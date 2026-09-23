import axios, { AxiosInstance } from 'axios';
import { logger } from './middleware/logger.js';

/**
 * Normalises a Crayon list response to an array.
 *
 * The Crayon API returns **bare arrays** for every collection endpoint
 * (`/BillingStatements`, `/Subscriptions`, `/Invoices`, `/Organizations`, …).
 * Some endpoints/proxies still wrap results in an `{ Items: [...] }` envelope,
 * and paginated payloads may carry `TotalHits`. Reading `.Items` unconditionally
 * therefore silently yields `undefined` and turns every aggregate into zero, so
 * all list access goes through this helper.
 */
export function unwrapList<T = any>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['Items', 'items', 'value', 'Value', 'data', 'Results']) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}

/**
 * Extracts a monetary amount from a Crayon value shape.
 *
 * `BillingStatement.totalSalesPrice` and `GroupedBillingStatement.totalSalesPrice`
 * are `Price` objects (`{ value, currencyCode }`), while usage-cost endpoints
 * return a bare `amount` number. A raw `TotalSalesPrice` read yields an object,
 * which makes every sum `NaN`/0 — so amounts are always read through here.
 */
export function priceValue(cost: unknown): number {
  if (typeof cost === 'number') return Number.isFinite(cost) ? cost : 0;
  if (typeof cost === 'string') {
    const parsed = Number(cost);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (cost && typeof cost === 'object') {
    const record = cost as Record<string, unknown>;
    for (const key of ['value', 'Value', 'amount', 'Amount']) {
      const v = record[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const parsed = Number(v);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return 0;
}

/** Extracts the currency code from a Crayon value shape. */
export function priceCurrency(cost: unknown, fallback = 'NOK'): string {
  const record = (cost ?? {}) as Record<string, unknown>;
  const code = record.currencyCode ?? record.CurrencyCode;
  return typeof code === 'string' && code ? code : fallback;
}

interface CrayonAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface BillingStatementFilter {
  organizationId: number;
  invoiceProfileId?: number;
  provisionType?: 'None' | 'Seat' | 'Usage' | 'OneTime' | 'Crayon' | 'AzureMarketplace';
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

interface AzureUsageParams {
  azurePlanId: number;
  subscriptionId: number;
  year: number;
  month: number;
  includeBom?: boolean;
}

export class CrayonApiClient {
  private apiClient: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  /**
   * Reference cache for slow-changing lookups that would otherwise be re-fetched
   * once per tool call (e.g. a customer tenant's Azure plan). Billing and cost
   * data is deliberately never cached — stale financial figures are worse than a
   * repeated call.
   */
  private readonly azurePlanByTenant = new Map<number, any>();

  constructor(
    private clientId: string,
    private clientSecret: string,
    private username: string,
    private password: string,
    private baseUrl: string = 'https://api.crayon.com/api/v1',
    /** Per-request timeout in ms. Keeps a stalled API from hanging a tool call. */
    private requestTimeoutMs: number = 30_000
  ) {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      // Hard timeout per Crayon request. Without it a stalled connection blocks
      // the circuit breaker's own timeout from ever being the limiting factor,
      // and the caller waits indefinitely.
      timeout: this.requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Authenticated GET. Centralises token acquisition so callers never have to
   * repeat the `authenticate()` + header boilerplate.
   */
  private async get(path: string): Promise<any> {
    const token = await this.authenticate();
    const response = await this.apiClient.get(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  /** Authenticated POST. */
  private async post(path: string, body?: unknown): Promise<any> {
    const token = await this.authenticate();
    return (await this.apiClient.post(path, body, {
      headers: { Authorization: `Bearer ${token}` },
    })).data;
  }

  /**
   * Fetches every page of a paginated Crayon collection endpoint.
   *
   * The API exposes no total count and no cursor, so a single request silently
   * truncates and an aggregate would report a partial dataset as complete.
   *
   * Termination deliberately does **not** use "page came back shorter than the
   * requested size" as an end-of-data signal. The spec declares no maximum
   * `PageSize`, so the server may cap it; if it caps below what we ask for, every
   * page would look short and that heuristic would stop after a single request —
   * reintroducing the very truncation this exists to prevent. The walk stops only
   * on an empty page, which is correct regardless of any server-side cap. The
   * cost is one extra (small, empty) request at the end, which is a fair trade
   * against reporting spend from a partial dataset.
   *
   * No client-side de-duplication is performed. Rows are not guaranteed to carry
   * a unique `id` (e.g. `GroupedBillingStatement` has both `groupId` and `id` and
   * repeats across billing periods, and usage-cost rows have no id at all), so
   * deduping individual rows risks dropping legitimate ones from a total.
   * Instead, progress is judged at the **page boundary**: if a page starts with
   * the same row as the previous page, the server is replaying a page rather than
   * advancing, so the walk stops. That detects a server ignoring `Page` without
   * ever discarding a distinct row.
   *
   * @param buildUrl Produces the URL for a given 1-based page number.
   * @param maxPages Safety cap on requests (bounds the total rows fetched).
   */
  private async getAllPages(
    buildUrl: (page: number) => string,
    maxPages: number = 20
  ): Promise<any[]> {
    const collected: any[] = [];
    let previousFirstRow: string | null = null;

    for (let page = 1; page <= maxPages; page++) {
      const batch = unwrapList(await this.get(buildUrl(page)));

      if (batch.length === 0) break; // past the end of the collection

      // Page-boundary progress check: identical first row => page did not advance.
      const firstRow = JSON.stringify(batch[0]);
      if (firstRow === previousFirstRow) {
        logger.warn('Pagination did not advance; stopping to avoid duplicate rows', {
          endpoint: buildUrl(page).split('?')[0],
          page,
          collected: collected.length,
        });
        break;
      }
      previousFirstRow = firstRow;

      collected.push(...batch);

      if (page === maxPages) {
        logger.warn('Pagination cap reached; results may be incomplete', {
          endpoint: buildUrl(page).split('?')[0],
          collected: collected.length,
          maxPages,
        });
      }
    }

    return collected;
  }

  /**
   * Authenticate with Crayon API and get access token.
   *
   * The in-flight promise is memoized so concurrent tool calls hitting an expired
   * token trigger exactly **one** token request (a thundering herd here would
   * otherwise fire N simultaneous auth calls and risk the provider rate-limiting
   * or rejecting the credentials).
   */
  private async authenticate(): Promise<string> {
    const now = Date.now() / 1000;

    // Return cached token if still valid (60s safety margin before expiry).
    if (this.accessToken && this.tokenExpiry > now + 60) {
      return this.accessToken;
    }

    // Coalesce concurrent refreshes onto a single in-flight request.
    if (this.tokenRefresh) {
      return this.tokenRefresh;
    }

    this.tokenRefresh = this.requestToken()
      .then((token) => {
        this.accessToken = token;
        this.tokenExpiry = Date.now() / 1000 + this.currentExpiresIn;
        return token;
      })
      .finally(() => {
        this.tokenRefresh = null;
      });

    return this.tokenRefresh;
  }

  /** Holds the in-flight token refresh, if any. */
  private tokenRefresh: Promise<string> | null = null;
  private currentExpiresIn: number = 3600;

  /** Performs the actual token request and stores the resulting TTL. */
  private async requestToken(): Promise<string> {
    // Crayon API requires Basic Authentication (client_id:client_secret) in Authorization header
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    try {
      const response = await axios.post<CrayonAuthResponse>(
        `${this.baseUrl}/connect/token`,
        new URLSearchParams({
          grant_type: 'password',
          username: this.username,
          password: this.password,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${auth}`,
          },
          timeout: this.requestTimeoutMs,
        }
      );

      // Crayon API returns AccessToken (PascalCase), not access_token
      const token = response.data.access_token || (response.data as any).AccessToken;
      const expiresIn = response.data.expires_in || (response.data as any).ExpiresIn || 3600;
      this.currentExpiresIn = expiresIn;

      if (!token) {
        throw new Error('No access token received from API');
      }

      return token;
    } catch (error) {
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get billing statements with filters.
   * Spec: GET /api/v1/BillingStatements (query: InvoiceProfileId, OrganizationId,
   * ProvisionType, From, To, Page, PageSize) -> BillingStatement[]
   */
  /**
   * Get billing statements with filters.
   *
   * Paged explicitly: this backs the paginated tool surface, so a caller asking
   * for page 2 gets exactly that page (with `pageSize` defaulting to 100).
   */
  async getBillingStatements(filter: BillingStatementFilter): Promise<any[]> {
    const params = new URLSearchParams();
    params.append('OrganizationId', filter.organizationId.toString());
    params.append('Page', (filter.page ?? 1).toString());
    params.append('PageSize', (filter.pageSize ?? 100).toString());

    if (filter.invoiceProfileId) params.append('InvoiceProfileId', filter.invoiceProfileId.toString());
    if (filter.provisionType) params.append('ProvisionType', filter.provisionType);
    if (filter.from) params.append('From', filter.from);
    if (filter.to) params.append('To', filter.to);

    return unwrapList(await this.get(`/BillingStatements?${params.toString()}`));
  }

  /**
   * Get grouped billing statements.
   * Spec: GET /api/v1/BillingStatements/grouped -> GroupedBillingStatement[]
   * Walks all pages: aggregates must never read a truncated result set.
   */
  async getGroupedBillingStatements(filter: BillingStatementFilter): Promise<any[]> {
    const pageSize = 500;
    return this.getAllPages((page) => {
      const params = new URLSearchParams();
      params.append('OrganizationId', filter.organizationId.toString());
      params.append('Page', page.toString());
      params.append('PageSize', pageSize.toString());

      if (filter.invoiceProfileId) params.append('InvoiceProfileId', filter.invoiceProfileId.toString());
      if (filter.provisionType) params.append('ProvisionType', filter.provisionType);
      if (filter.from) params.append('From', filter.from);
      if (filter.to) params.append('To', filter.to);

      return `/BillingStatements/grouped?${params.toString()}`;
    });
  }

  /**
   * Get invoices for an organization.
   * Spec: GET /api/v1/Invoices/{organizationId} (query: Page, PageSize) -> Invoice[]
   * Note: the organization is a **path** segment, not a query parameter.
   */
  async getInvoices(organizationId: number, page?: number, pageSize?: number): Promise<any[]> {
    const params = new URLSearchParams();
    if (page) params.append('Page', page.toString());
    if (pageSize) params.append('PageSize', pageSize.toString());
    const qs = params.toString();

    return unwrapList(await this.get(`/Invoices/${organizationId}${qs ? `?${qs}` : ''}`));
  }

  /**
   * Get invoice profiles.
   * Spec: GET /api/v1/InvoiceProfiles (query: OrganizationId) -> InvoiceProfileExtended[]
   */
  async getInvoiceProfiles(organizationId: number): Promise<any[]> {
    const params = new URLSearchParams({ OrganizationId: organizationId.toString() });
    return unwrapList(await this.get(`/InvoiceProfiles?${params.toString()}`));
  }

  /**
   * Get organizations.
   * Spec: GET /api/v1/Organizations (query: Page, PageSize, Search) -> Organization[]
   */
  async getOrganizations(): Promise<any[]> {
    return unwrapList(await this.get('/Organizations'));
  }

  /**
   * Get customer tenants (Azure/AWS customers).
   * Spec: GET /api/v1/CustomerTenants -> CustomerTenantExtended[]
   */
  async getCustomerTenants(organizationId?: number): Promise<any[]> {
    const params = new URLSearchParams();
    if (organizationId) params.append('OrganizationId', organizationId.toString());
    const qs = params.toString();

    return unwrapList(await this.get(`/CustomerTenants${qs ? `?${qs}` : ''}`));
  }

  /**
   * Get Azure subscriptions for a customer tenant.
   *
   * The customer-tenant -> Azure-plan -> subscriptions chain is resolved in two
   * calls by the API's own design; the plan lookup is cached so repeated calls
   * (the Azure cost tools) do not re-fetch it.
   */
  async getAzureSubscriptions(customerTenantId: number): Promise<any[]> {
    const azurePlan = await this.getAzurePlanForTenant(customerTenantId);
    if (!azurePlan?.id) {
      return [];
    }

    return unwrapList(await this.get(`/AzurePlans/${azurePlan.id}/azureSubscriptions`));
  }

  /**
   * Resolves (and caches) the Azure Plan for a customer tenant.
   * Spec: GET /api/v1/CustomerTenants/{customerTenantId}/azurePlan -> AzurePlan
   */
  async getAzurePlanForTenant(customerTenantId: number): Promise<any | null> {
    const cached = this.azurePlanByTenant.get(customerTenantId);
    if (cached !== undefined) return cached;

    try {
      const plan = await this.get(`/CustomerTenants/${customerTenantId}/azurePlan`);
      const result = plan?.id ? plan : null;
      this.azurePlanByTenant.set(customerTenantId, result);
      return result;
    } catch (error) {
      // A tenant without an Azure plan legitimately returns 404.
      if ((error as any).response?.status === 404) {
        this.azurePlanByTenant.set(customerTenantId, null);
        return null;
      }
      throw error;
    }
  }

  /**
   * Get subscriptions (all cloud subscriptions).
   * Spec: GET /api/v1/Subscriptions
   *   (query: OrganizationId, CustomerTenantId, PublisherId, Statuses, Page,
   *    PageSize, Search, …) -> SubscriptionExtended[]
   * `SubscriptionExtended` already embeds `subscriptionTags`, so tag lookups do
   * not need an extra request per subscription.
   */
  async getSubscriptions(options: {
    organizationId?: number;
    customerTenantId?: number;
    page?: number;
    pageSize?: number;
    search?: string;
  } = {}): Promise<any[]> {
    // Explicit page -> single request (caller asked for pagination control).
    if (options.page) {
      const params = new URLSearchParams();
      if (options.organizationId) params.append('OrganizationId', options.organizationId.toString());
      if (options.customerTenantId) params.append('CustomerTenantId', options.customerTenantId.toString());
      params.append('Page', options.page.toString());
      if (options.pageSize) params.append('PageSize', options.pageSize.toString());
      if (options.search) params.append('Search', options.search);

      return unwrapList(await this.get(`/Subscriptions?${params.toString()}`));
    }

    // No page requested -> the caller wants the complete set.
    return this.getAllSubscriptions(options);
  }

  /**
   * Walks every page of the subscription list. Aggregates must use this: a
   * single un-paginated request truncates silently at the API's page size.
   */
  private async getAllSubscriptions(options: {
    organizationId?: number;
    customerTenantId?: number;
    search?: string;
  } = {}): Promise<any[]> {
    const pageSize = 500;
    return this.getAllPages((page) => {
      const params = new URLSearchParams();
      params.append('Page', page.toString());
      params.append('PageSize', pageSize.toString());
      if (options.organizationId) params.append('OrganizationId', options.organizationId.toString());
      if (options.customerTenantId) params.append('CustomerTenantId', options.customerTenantId.toString());
      if (options.search) params.append('Search', options.search);
      return `/Subscriptions?${params.toString()}`;
    });
  }

  /**
   * Get historical billing data for multiple months.
   * Returns a flat array of grouped billing statements, complete across pages.
   */
  async getHistoricalBilling(organizationId: number, monthsBack: number = 6, invoiceProfileId?: number): Promise<any[]> {
    const endDate = new Date();
    const startDate = new Date();
    // setMonth is local-time based; billing periods are UTC dates on the wire, so
    // compute the start month in UTC to avoid a DST/day-boundary drift.
    startDate.setUTCMonth(startDate.getUTCMonth() - monthsBack);

    // Start at the 1st of the month so complete billing periods are included
    // (statements are keyed on StartDate/EndDate, e.g. 2025-08-01..2025-09-01).
    startDate.setUTCDate(1);
    startDate.setUTCHours(0, 0, 0, 0);

    return this.getGroupedBillingStatements({
      organizationId,
      invoiceProfileId,
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    });
  }

  /**
   * Get subscription details.
   * Spec: GET /api/v1/Subscriptions/{id} -> SubscriptionDetailed
   *
   * The path is capitalised to match the spec exactly. Routing through the shared
   * `get()` helper (rather than calling axios directly) also means this method
   * picks up the request timeout and token handling like every other call.
   */
  async getSubscriptionById(subscriptionId: number): Promise<any> {
    return this.get(`/Subscriptions/${subscriptionId}`);
  }

  /**
   * Get Azure Plan details
   */
  async getAzurePlan(azurePlanId: number): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get(`/AzurePlans/${azurePlanId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get Azure subscriptions for an Azure Plan.
   * Spec: GET /api/v1/AzurePlans/{azurePlanId}/azureSubscriptions
   */
  async getAzurePlanSubscriptions(azurePlanId: number): Promise<any[]> {
    return unwrapList(await this.get(`/AzurePlans/${azurePlanId}/azureSubscriptions`));
  }

  /**
   * Get subscription tags.
   * Spec: GET /api/v1/Subscriptions/{subscriptionId}/tags -> SubscriptionTags
   */
  async getSubscriptionTags(subscriptionId: number): Promise<any> {
    return this.get(`/Subscriptions/${subscriptionId}/tags`);
  }

  /**
   * Replace the tags on a subscription.
   *
   * Spec: POST (not PUT) /api/v1/Subscriptions/{subscriptionId}/tags, body
   * `SubscriptionTags` = `{ subscriptionId, costCenter, department, project,
   * custom, owner }`. The endpoint is a whole-object replace, so unknown keys are
   * rejected — arbitrary key/value maps are not accepted.
   *
   * @returns `true` when the API accepted the update.
   */
  async updateSubscriptionTags(
    subscriptionId: number,
    tags: { costCenter?: string; department?: string; project?: string; custom?: string; owner?: string }
  ): Promise<boolean> {
    const body = {
      subscriptionId,
      costCenter: tags.costCenter ?? null,
      department: tags.department ?? null,
      project: tags.project ?? null,
      custom: tags.custom ?? null,
      owner: tags.owner ?? null,
    };

    return Boolean(await this.post(`/Subscriptions/${subscriptionId}/tags`, body));
  }

  /**
   * Get AWS accounts (the AWS equivalent of an Azure subscription).
   * Spec: GET /api/v1/AwsAccounts
   *   (query: OrganizationId, PublisherId, ConsumerId, CustomerTenantType,
   *    Page, PageSize, Search) -> AwsAccountExtended[]
   * `tags` is embedded, so no extra request is needed per account.
   */
  async getAwsAccounts(options: {
    organizationId?: number;
    customerTenantId?: number;
    page?: number;
    pageSize?: number;
    search?: string;
  } = {}): Promise<any[]> {
    // Explicit page -> single request; otherwise walk all pages.
    if (options.page) {
      const params = new URLSearchParams();
      if (options.organizationId) params.append('OrganizationId', options.organizationId.toString());
      if (options.customerTenantId) params.append('ConsumerId', options.customerTenantId.toString());
      params.append('Page', options.page.toString());
      if (options.pageSize) params.append('PageSize', options.pageSize.toString());
      if (options.search) params.append('Search', options.search);

      return unwrapList(await this.get(`/AwsAccounts?${params.toString()}`));
    }

    const pageSize = 500;
    return this.getAllPages((page) => {
      const params = new URLSearchParams();
      params.append('Page', page.toString());
      params.append('PageSize', pageSize.toString());
      if (options.organizationId) params.append('OrganizationId', options.organizationId.toString());
      if (options.customerTenantId) params.append('ConsumerId', options.customerTenantId.toString());
      if (options.search) params.append('Search', options.search);
      return `/AwsAccounts?${params.toString()}`;
    });
  }

  /**
   * Get a single AWS account with its tags.
   * Spec: GET /api/v1/AwsAccounts/{id} -> AwsAccountExtended
   */
  async getAwsAccountById(accountId: number): Promise<any> {
    return this.get(`/AwsAccounts/${accountId}`);
  }

  /**
   * Summarise spend per cloud provider for the subscription list.
   *
   * The same subscription catalogue covers every cloud Crayon resells
   * (Microsoft/Azure, AWS, and others), so provider attribution is derived from
   * the publisher already present on each subscription rather than maintained as
   * separate per-cloud tools.
   */
  /**
   * Get AWS accounts for the multi-cloud roll-up (complete across pages).
   */
  async getCloudSpendByPublisher(organizationId: number): Promise<any> {
    const [subscriptions, awsAccounts] = await Promise.all([
      this.getSubscriptions({ organizationId }),
      this.getAwsAccounts({ organizationId }),
    ]);

    const byPublisher = new Map<string, { total: number; subscriptionCount: number }>();
    for (const sub of subscriptions) {
      const publisher = sub?.publisher?.name ?? 'Unknown';
      const entry = byPublisher.get(publisher) ?? { total: 0, subscriptionCount: 0 };
      entry.total += priceValue(sub?.salesPrice);
      entry.subscriptionCount += 1;
      byPublisher.set(publisher, entry);
    }

    return {
      organizationId,
      currencyCode: subscriptions.length ? priceCurrency(subscriptions[0]?.salesPrice) : 'NOK',
      publishers: [...byPublisher.entries()]
        .map(([publisher, data]) => ({ publisher, ...data }))
        .sort((a, b) => b.total - a.total),
      aws: {
        accountCount: awsAccounts.length,
        activatedAccounts: awsAccounts.filter((a) => a?.isActivated).length,
        accounts: awsAccounts.map((a) => ({
          id: a?.id,
          name: a?.name ?? a?.awsAccountName ?? null,
          payerAccountId: a?.payerAccountId ?? null,
          masterAccountStatus: a?.masterAccountStatus ?? null,
          awsSegment: a?.awsSegment ?? null,
          isActivated: a?.isActivated ?? null,
          tags: a?.tags ?? {},
        })),
      },
    };
  }

  /**
   * Get subscriptions together with their embedded tags and cost history.
   *
   * `SubscriptionExtended` already carries `subscriptionTags`, so no per-row
   * tag request is needed (the previous implementation issued one request per
   * subscription).
   */
  async getCostByTags(organizationId: number, monthsBack: number = 3): Promise<any> {
    const [subscriptions, billingData] = await Promise.all([
      this.getSubscriptions({ organizationId }),
      this.getHistoricalBilling(organizationId, monthsBack),
    ]);

    return {
      subscriptions: subscriptions.map((sub) => ({
        id: sub?.id,
        name: sub?.name,
        tags: sub?.subscriptionTags ?? null,
      })),
      billingData,
      organizationId,
      monthsBack,
    };
  }

  /**
   * Get total Azure costs for an organization within a date range.
   * Spec: GET /api/v1/UsageCost/organization/{organizationId}?from&to
   *       -> OrganizationUsageCost[]
   */
  async getAzureCostsByDateRange(organizationId: number, from: string, to: string): Promise<any> {
    const params = new URLSearchParams({ from, to });
    const items = unwrapList(await this.get(`/UsageCost/organization/${organizationId}?${params.toString()}`));

    return {
      organizationId,
      from,
      to,
      totalCost: items.reduce((sum, item) => sum + priceValue(item?.amount), 0),
      currencyCode: items.length ? (items[0]?.currencyCode ?? 'NOK') : 'NOK',
      itemCount: items.length,
      items,
    };
  }

  /**
   * Get Azure costs for a subscription within a date range, by category.
   * Spec: POST /api/v1/UsageCost/getForCategory
   *       body { resellerCustomerId, subscriptionId, category, currencyCode, from, to }
   *       -> CategoryUsageCost[] = [{ subcategory, amount, currencyCode }]
   */
  async getAzureCostsBySubscription(azurePlanId: number, subscriptionId: number, from: string, to: string): Promise<any> {
    const items = unwrapList(
      await this.post('/UsageCost/getForCategory', {
        resellerCustomerId: azurePlanId,
        subscriptionId: String(subscriptionId),
        category: 'azure',
        from,
        to,
      })
    );

    return {
      azurePlanId,
      subscriptionId,
      from,
      to,
      totalCost: items.reduce((sum, item) => sum + priceValue(item?.amount), 0),
      currencyCode: items.length ? (items[0]?.currencyCode ?? 'NOK') : 'NOK',
      itemCount: items.length,
      items,
    };
  }

  /**
   * Get Azure usage for a subscription as a downloadable CSV reference.
   * Spec: GET /api/v1/AzureUsage/{azurePlanId}/azureSubscriptions/{id}/monthlyUsage
   *       (query: year, month, includeBom) -> AzureUsageFile
   */
  async getAzureUsage(params: AzureUsageParams): Promise<any> {
    const query = new URLSearchParams({
      year: params.year.toString(),
      month: params.month.toString(),
    });
    if (params.includeBom !== undefined) {
      query.append('includeBom', params.includeBom ? 'true' : 'false');
    }

    return this.get(
      `/AzureUsage/${params.azurePlanId}/azureSubscriptions/${params.subscriptionId}/monthlyUsage?${query.toString()}`
    );
  }

  /**
   * Get cost trends over multiple months
   */
  async getCostTrends(organizationId: number, monthsBack: number = 6): Promise<any> {
    const historicalData = await this.getHistoricalBilling(organizationId, monthsBack);
    const costsByMonth: { [key: string]: number } = {};

    // Aggregate costs by month. `startDate` is ISO (e.g. 2025-10-01T00:00:00+00:00)
    // and `totalSalesPrice` is a Price object, so both go through the helpers.
    historicalData.forEach((item: any) => {
      const startDate = item?.startDate ? new Date(item.startDate) : null;
      const month = startDate && !isNaN(startDate.getTime())
        ? `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`
        : 'unknown';

      const cost = priceValue(item?.totalSalesPrice);
      costsByMonth[month] = (costsByMonth[month] || 0) + cost;
    });

    // Calculate month-over-month changes
    const trends = Object.entries(costsByMonth)
      .sort()
      .reduce((acc: any[], [month, cost], idx, arr) => {
        if (idx > 0) {
          const prevCost = arr[idx - 1][1] as number;
          const change = cost - prevCost;
          const changePercent = prevCost !== 0 ? (change / prevCost) * 100 : 0;
          acc.push({
            month,
            cost,
            previousCost: prevCost,
            change,
            changePercent: parseFloat(changePercent.toFixed(2)),
          });
        } else {
          acc.push({ month, cost, previousCost: null, change: null, changePercent: null });
        }
        return acc;
      }, []);

    return {
      organizationId,
      monthsBack,
      trends,
      summary: {
        totalMonths: trends.length,
        averageMonthlyCost: trends.length > 0 ? trends.reduce((sum: number, t: any) => sum + t.cost, 0) / trends.length : 0,
        highestMonth: trends.length > 0 ? trends.reduce((max: any, t: any) => (t.cost > max.cost ? t : max), trends[0]) : null,
        lowestMonth: trends.length > 0 ? trends.reduce((min: any, t: any) => (t.cost < min.cost ? t : min), trends[0]) : null,
      },
    };
  }

  /**
   * Detect cost anomalies - find subscriptions with significant changes
   */
  async detectCostAnomalies(organizationId: number, monthsBack: number = 3, changeThresholdPercent: number = 25): Promise<any> {
    // Get subscriptions and their cost history
    const subscriptions = await this.getSubscriptions({ organizationId });
    const billingData = await this.getHistoricalBilling(organizationId, monthsBack);

    const anomalies: any[] = [];

    // Group billing data by subscription
    const costsBySubscription: { [key: string]: any[] } = {};
    billingData.forEach((item: any) => {
      const subId = item?.orderId || item?.invoiceProfile?.id || 'unknown';
      if (!costsBySubscription[subId]) costsBySubscription[subId] = [];
      costsBySubscription[subId].push(item);
    });

    // Analyze trends for each subscription
    Object.entries(costsBySubscription).forEach(([subId, costs]) => {
      const sortedCosts = [...costs].sort(
        (a: any, b: any) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime()
      );

      for (let i = 1; i < sortedCosts.length; i++) {
        const current = priceValue(sortedCosts[i].totalSalesPrice);
        const previous = priceValue(sortedCosts[i - 1].totalSalesPrice);

        if (previous > 0) {
          const changePercent = ((current - previous) / previous) * 100;

          if (Math.abs(changePercent) > changeThresholdPercent) {
            const sub = subscriptions.find((s: any) => String(s?.id) === String(subId));
            anomalies.push({
              subscriptionId: subId,
              subscriptionName: sub?.name || 'Unknown',
              previousCost: previous,
              currentCost: current,
              change: current - previous,
              changePercent: parseFloat(changePercent.toFixed(2)),
              // `startDate` is the statement period key (camelCase in the API).
              date: sortedCosts[i]?.startDate ?? null,
            });
          }
        }
      }
    });

    // Sort by highest change. `toSorted` avoids mutating the input array.
    anomalies.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

    return {
      organizationId,
      monthsBack,
      changeThresholdPercent,
      anomaliesFound: anomalies.length,
      anomalies: anomalies.slice(0, 50), // Top 50 anomalies
      summary: {
        totalSubscriptionsAnalyzed: Object.keys(costsBySubscription).length,
        highestIncrease: anomalies.find((a: any) => a.changePercent > 0),
        highestDecrease: anomalies.find((a: any) => a.changePercent < 0),
      },
    };
  }

  /**
   * Analyze costs by tags (cost centers, departments, etc.)
   *
   * Tags come from `subscriptionTags` on the subscription list response, so this
   * is two API calls regardless of subscription count (previously N+1).
   */
  async analyzeCostsByTags(organizationId: number, monthsBack: number = 3): Promise<any> {
    const subscriptions = await this.getSubscriptions({ organizationId });
    const billingData = await this.getHistoricalBilling(organizationId, monthsBack);

    // Grouped billing statements are keyed by invoice profile, not subscription,
    // so tag attribution uses each subscription's own sales price.
    const subIdToTags = new Map<number, any>(
      subscriptions.map((s: any) => [s?.id, s?.subscriptionTags ?? {}])
    );

    const costsByTag: { [key: string]: { [key: string]: number } } = {};

    subscriptions.forEach((sub: any) => {
      const tags = subIdToTags.get(sub.id) ?? {};
      const cost = priceValue(sub.salesPrice);

      // Only the named tag dimensions are meaningful for aggregation.
      for (const [tagKey, tagValue] of Object.entries(tags)) {
        if (tagValue === null || tagValue === undefined || tagValue === '') continue;
        if (!costsByTag[tagKey]) costsByTag[tagKey] = {};
        const tagVal = String(tagValue);
        costsByTag[tagKey][tagVal] = (costsByTag[tagKey][tagVal] || 0) + cost;
      }
    });

    // Format results
    const costBreakdown = Object.entries(costsByTag).map(([tagKey, values]) => ({
      tag: tagKey,
      breakdown: Object.entries(values)
        .map(([value, cost]) => ({ value, cost }))
        .sort((a: any, b: any) => b.cost - a.cost),
      total: Object.values(values).reduce((sum: number, cost: number) => sum + cost, 0),
    }));

    return {
      organizationId,
      monthsBack,
      subscriptionsAnalyzed: subscriptions.length,
      billingStatementsAnalyzed: billingData.length,
      costBreakdown,
    };
  }

  /**
   * Find subscriptions by name pattern and get their latest invoice.
   *
   * Invoices are fetched once and joined in memory; tags are read from the
   * embedded `subscriptionTags` rather than per-subscription requests.
   */
  async findSimilarSubscriptionsAndInvoices(organizationId: number, namePattern: string): Promise<any> {
    const subscriptions = await this.getSubscriptions({ organizationId });

    const pattern = new RegExp(namePattern, 'i');
    const matchingSubscriptions = subscriptions.filter((sub: any) =>
      pattern.test(sub?.name ?? '')
    );

    // Invoices are per organization, not per subscription.
    const invoices = await this.getInvoices(organizationId);

    const subscriptionsWithInvoices = matchingSubscriptions.map((sub: any) => {
      const subInvoices = invoices
        .filter((inv: any) => inv?.orderId && sub?.orderId && inv.orderId === sub.orderId)
        .sort((a: any, b: any) => new Date(b.invoiceDate || 0).getTime() - new Date(a.invoiceDate || 0).getTime());

      return {
        subscription: {
          id: sub?.id,
          name: sub?.name,
          status: sub?.status,
          salesPrice: priceValue(sub?.salesPrice),
        },
        tags: sub?.subscriptionTags ?? {},
        lastInvoice: subInvoices[0] ?? null,
        totalInvoices: subInvoices.length,
        recentInvoices: subInvoices.slice(0, 5),
      };
    });

    return {
      organizationId,
      searchPattern: namePattern,
      matchesFound: matchingSubscriptions.length,
      results: subscriptionsWithInvoices,
    };
  }

  /**
   * List all subscriptions with their tags for verification and auditing.
   *
   * Tags are embedded in the subscription list response (`subscriptionTags`), so
   * this is a single paginated walk with no per-row requests.
   */
  async listAllSubscriptionsWithTags(organizationId?: number): Promise<any> {
    const subscriptions = await this.getSubscriptions({ organizationId });

    const rows = subscriptions.map((sub: any) => ({
      id: sub?.id,
      name: sub?.name,
      status: sub?.status,
      publisher: sub?.publisher?.name ?? null,
      organization: sub?.organization?.name ?? null,
      startDate: sub?.startDate ?? null,
      endDate: sub?.endDate ?? null,
      salesPrice: priceValue(sub?.salesPrice),
      tags: sub?.subscriptionTags ?? {},
    }));

    const untagged = rows.filter((r) => Object.keys(r.tags).length === 0).length;

    return {
      organizationId: organizationId ?? 'all',
      totalSubscriptions: rows.length,
      untaggedSubscriptions: untagged,
      subscriptions: rows,
    };
  }

  /**
   * Resolves the previous calendar month as an inclusive date range.
   * Computed in UTC: the API compares ISO date strings, and using local-time
   * getters would shift the window on non-UTC hosts (e.g. a CET container) or on
   * the month boundary.
   */
  private previousMonthRange(now = new Date()): { from: string; to: string } {
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return {
      from: lastMonthStart.toISOString().split('T')[0],
      to: lastMonthEnd.toISOString().split('T')[0],
    };
  }

  /** Sums the `totalSalesPrice` (Price) of grouped billing statements. */
  private sumBillingStatements(statements: any[]): { total: number; currency: string } {
    const total = statements.reduce((sum, item) => sum + priceValue(item?.totalSalesPrice), 0);
    const currency = statements.length ? priceCurrency(statements[0]?.totalSalesPrice) : 'NOK';
    return { total, currency };
  }

  /**
   * Get last month costs summary by organization
   */
  async getLastMonthCostsByOrganization(organizationId: number): Promise<any> {
    const { from, to } = this.previousMonthRange();

    const billingData = await this.getGroupedBillingStatements({ organizationId, from, to });
    const { total, currency } = this.sumBillingStatements(billingData);

    return {
      organizationId,
      period: { from, to, description: 'Last Month' },
      totalCost: total,
      currencyCode: currency,
      itemsCount: billingData.length,
      items: billingData,
    };
  }

  /**
   * Get last month costs breakdown by invoice profile.
   *
   * A single grouped-billing call already carries the invoice profile per row, so
   * this needs two requests total (profiles + statements) instead of one request
   * per profile.
   */
  async getLastMonthCostsByInvoiceProfile(organizationId: number): Promise<any> {
    const { from, to } = this.previousMonthRange();

    const [profiles, billingData] = await Promise.all([
      this.getInvoiceProfiles(organizationId),
      this.getGroupedBillingStatements({ organizationId, from, to }),
    ]);

    // Accumulate per profile from the single statement result set.
    const totalsByProfile = new Map<number, { total: number; items: number; currency: string }>();
    for (const statement of billingData) {
      const profileId = statement?.invoiceProfile?.id;
      if (profileId === undefined || profileId === null) continue;

      const entry = totalsByProfile.get(profileId) ?? { total: 0, items: 0, currency: priceCurrency(statement?.totalSalesPrice) };
      entry.total += priceValue(statement?.totalSalesPrice);
      entry.items += 1;
      totalsByProfile.set(profileId, entry);
    }

    const costsByProfile = profiles.map((profile: any) => {
      const entry = totalsByProfile.get(profile?.id);
      return {
        profileId: profile?.id,
        profileName: profile?.name,
        totalCost: entry?.total ?? 0,
        currencyCode: entry?.currency ?? 'NOK',
        itemsCount: entry?.items ?? 0,
      };
    }).sort((a: any, b: any) => b.totalCost - a.totalCost);

    return {
      organizationId,
      period: { from, to, description: 'Last Month' },
      totalOrganizationCost: costsByProfile.reduce((sum: number, p: any) => sum + p.totalCost, 0),
      profilesCount: costsByProfile.length,
      costsByProfile,
    };
  }

  /**
   * Get last month costs breakdown by tags (costCenter, department, project,
   * custom, owner).
   *
   * Tag dimensions come from the subscription list (embedded `subscriptionTags`)
   * and each subscription's own `salesPrice`, so this is two API calls total.
   */
  async getLastMonthCostsByTags(organizationId: number): Promise<any> {
    const { from, to } = this.previousMonthRange();

    // Only the subscription list is needed: it carries both tags and sales price.
    const subscriptions = await this.getSubscriptions({ organizationId });

    const costsByTag: { [key: string]: { [key: string]: { cost: number; subscriptions: string[] } } } = {};

    for (const sub of subscriptions) {
      const tags = sub?.subscriptionTags ?? {};
      const cost = priceValue(sub?.salesPrice);
      const subName = sub?.name ?? `Unknown (${sub?.id})`;

      for (const [tagKey, tagValue] of Object.entries(tags)) {
        if (tagValue === null || tagValue === undefined || tagValue === '') continue;
        if (!costsByTag[tagKey]) costsByTag[tagKey] = {};
        const tagVal = String(tagValue);

        if (!costsByTag[tagKey][tagVal]) {
          costsByTag[tagKey][tagVal] = { cost: 0, subscriptions: [] };
        }
        costsByTag[tagKey][tagVal].cost += cost;
        if (!costsByTag[tagKey][tagVal].subscriptions.includes(subName)) {
          costsByTag[tagKey][tagVal].subscriptions.push(subName);
        }
      }
    }

    // Format results
    const costBreakdown = Object.entries(costsByTag).map(([tagKey, values]) => {
      const breakdown = Object.entries(values)
        .map(([value, data]: [string, any]) => ({
          value,
          cost: data.cost,
          subscriptionCount: data.subscriptions.length,
          subscriptions: data.subscriptions,
        }))
        .sort((a: any, b: any) => b.cost - a.cost);

      return {
        tag: tagKey,
        total: breakdown.reduce((sum: number, b: any) => sum + b.cost, 0),
        breakdown,
      };
    }).sort((a: any, b: any) => b.total - a.total);

    return {
      organizationId,
      period: { from, to, description: 'Last Month' },
      totalCost: costBreakdown.reduce((sum: number, t: any) => sum + t.total, 0),
      tagsCount: costBreakdown.length,
      costByTags: costBreakdown,
    };
  }
}

