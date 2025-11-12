import axios, { AxiosInstance } from 'axios';

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

  constructor(
    private clientId: string,
    private clientSecret: string,
    private username: string,
    private password: string,
    private baseUrl: string = 'https://api.crayon.com/api/v1'
  ) {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Authenticate with Crayon API and get access token
   */
  private async authenticate(): Promise<string> {
    const now = Date.now() / 1000;
    
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry > now + 60) {
      return this.accessToken;
    }

    try {
      // Crayon API requires Basic Authentication (client_id:client_secret) in Authorization header
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
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
        }
      );

      // Crayon API returns AccessToken (PascalCase), not access_token
      const token = response.data.access_token || (response.data as any).AccessToken;
      const expiresIn = response.data.expires_in || (response.data as any).ExpiresIn || 3600;
      
      this.accessToken = token;
      this.tokenExpiry = now + expiresIn;
      
      return this.accessToken;
    } catch (error) {
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get billing statements with filters
   */
  async getBillingStatements(filter: BillingStatementFilter): Promise<any> {
    const token = await this.authenticate();
    
    const params = new URLSearchParams();
    params.append('organizationId', filter.organizationId.toString());
    
    if (filter.invoiceProfileId) params.append('invoiceProfileId', filter.invoiceProfileId.toString());
    if (filter.provisionType) params.append('provisionType', filter.provisionType);
    if (filter.from) params.append('from', filter.from);
    if (filter.to) params.append('to', filter.to);
    if (filter.page) params.append('page', filter.page.toString());
    if (filter.pageSize) params.append('pageSize', filter.pageSize.toString());

    const response = await this.apiClient.get(`/billingstatements/?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get grouped billing statements
   */
  async getGroupedBillingStatements(filter: BillingStatementFilter): Promise<any> {
    const token = await this.authenticate();
    
    const params = new URLSearchParams();
    params.append('organizationId', filter.organizationId.toString());
    
    if (filter.invoiceProfileId) params.append('invoiceProfileId', filter.invoiceProfileId.toString());
    if (filter.provisionType) params.append('provisionType', filter.provisionType);
    if (filter.from) params.append('from', filter.from);
    if (filter.to) params.append('to', filter.to);

    const response = await this.apiClient.get(`/billingstatements/grouped?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get Azure usage data
   */
  async getAzureUsage(params: AzureUsageParams): Promise<any> {
    const token = await this.authenticate();
    
    const queryParams = new URLSearchParams({
      year: params.year.toString(),
      month: params.month.toString(),
    });

    if (params.includeBom !== undefined) {
      queryParams.append('includeBom', params.includeBom ? '1' : '0');
    }

    const response = await this.apiClient.get(
      `/AzureUsage/${params.azurePlanId}/azureSubscriptions/${params.subscriptionId}/monthlyUsage?${queryParams.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  }

  /**
   * Get invoices
   */
  async getInvoices(organizationId: number, page?: number, pageSize?: number): Promise<any> {
    const token = await this.authenticate();
    
    const params = new URLSearchParams();
    params.append('organizationId', organizationId.toString());
    if (page) params.append('page', page.toString());
    if (pageSize) params.append('pageSize', pageSize.toString());

    const response = await this.apiClient.get(`/invoices/?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get invoice profiles
   */
  async getInvoiceProfiles(organizationId: number): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get(`/invoiceprofiles/?organizationId=${organizationId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get organizations (for listing available orgs)
   */
  async getOrganizations(): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get('/organizations/', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get customer tenants (Azure/AWS customers)
   */
  async getCustomerTenants(organizationId?: number): Promise<any> {
    const token = await this.authenticate();
    
    const params = organizationId ? `?organizationId=${organizationId}` : '';
    const response = await this.apiClient.get(`/customertenants/${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get Azure subscriptions for a customer tenant
   * First fetches the Azure Plan ID, then gets the subscriptions
   */
  async getAzureSubscriptions(customerTenantId: number): Promise<any> {
    const token = await this.authenticate();
    
    try {
      // Step 1: Get the Azure Plan for this customer tenant
      const planResponse = await this.apiClient.get(
        `/customertenants/${customerTenantId}/azurePlan/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      
      const azurePlan = planResponse.data;
      if (!azurePlan || !azurePlan.Id) {
        return {
          Items: [],
          TotalHits: 0,
          message: `No Azure Plan found for customer tenant ${customerTenantId}`,
        };
      }

      // Step 2: Get Azure subscriptions for this Azure Plan
      const subscriptionsResponse = await this.apiClient.get(
        `/AzurePlans/${azurePlan.Id}/azureSubscriptions/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return subscriptionsResponse.data;
    } catch (error) {
      // If Azure Plan not found, return empty list instead of error
      if ((error as any).response?.status === 404) {
        return {
          Items: [],
          TotalHits: 0,
          message: `No Azure Plan found for customer tenant ${customerTenantId}`,
        };
      }
      throw error;
    }
  }

  /**
   * Get subscriptions (all cloud subscriptions)
   */
  async getSubscriptions(organizationId?: number, page?: number, pageSize?: number): Promise<any> {
    const token = await this.authenticate();
    
    const params = new URLSearchParams();
    if (organizationId) params.append('organizationId', organizationId.toString());
    if (page) params.append('page', page.toString());
    if (pageSize) params.append('pageSize', pageSize.toString());

    const response = await this.apiClient.get(`/subscriptions/?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get historical billing data for multiple months
   */
  async getHistoricalBilling(organizationId: number, monthsBack: number = 6, invoiceProfileId?: number): Promise<any> {
    const token = await this.authenticate();
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsBack);
    
    // Set to first day of the month to capture complete billing periods
    // Billing statements have StartDate/EndDate periods (e.g., 2025-08-01 to 2025-09-01)
    // We need to start from the 1st of the month to include those billing periods
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    const filter = {
      organizationId,
      invoiceProfileId,
      from: startDate.toISOString(),
      to: endDate.toISOString(),
    };

    return this.getGroupedBillingStatements(filter);
  }

  /**
   * Get subscription details with tags
   */
  async getSubscriptionById(subscriptionId: number): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get(`/subscriptions/${subscriptionId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
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
   * Get Azure subscriptions for an Azure Plan
   */
  async getAzurePlanSubscriptions(azurePlanId: number): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get(`/AzurePlans/${azurePlanId}/azureSubscriptions/`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Get subscription tags
   */
  async getSubscriptionTags(subscriptionId: number): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.get(`/subscriptions/${subscriptionId}/tags`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  }

  /**
   * Update subscription tags
   */
  async updateSubscriptionTags(subscriptionId: number, tags: Record<string, string>): Promise<any> {
    const token = await this.authenticate();
    
    const response = await this.apiClient.put(
      `/subscriptions/${subscriptionId}/tags`,
      tags,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  }

  /**
   * Get cost tracking by subscription tags
   */
  async getCostByTags(organizationId: number, monthsBack: number = 3): Promise<any> {
    const token = await this.authenticate();
    
    // Get subscriptions and billing data
    const [subscriptions, billingData] = await Promise.all([
      this.getSubscriptions(organizationId),
      this.getHistoricalBilling(organizationId, monthsBack),
    ]);

    // Fetch tags for each subscription
    const subscriptionsWithTags = await Promise.all(
      (subscriptions.Items || []).map(async (sub: any) => {
        try {
          const tags = await this.getSubscriptionTags(sub.Id);
          return { ...sub, tags };
        } catch (error) {
          return { ...sub, tags: null };
        }
      })
    );

    return {
      subscriptions: subscriptionsWithTags,
      billingData,
      organizationId,
      monthsBack,
    };
  }

  /**
   * Get total Azure costs for a date range
   */
  async getAzureCostsByDateRange(organizationId: number, from: string, to: string): Promise<any> {
    const token = await this.authenticate();
    
    try {
      // Try organization-level endpoint first
      const response = await this.apiClient.get(
        `/usagecost/organization/${organizationId}/?from=${from}&to=${to}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      // Fallback: aggregate billing statements
      console.warn(`Organization-level cost endpoint failed, using billing statements fallback`);
      const billingData = await this.getGroupedBillingStatements({
        organizationId,
        from,
        to,
      });

      return {
        organizationId,
        from,
        to,
        billingStatements: billingData,
        source: 'billing_statements_fallback',
      };
    }
  }

  /**
   * Get Azure costs by subscription for a date range
   */
  async getAzureCostsBySubscription(azurePlanId: number, subscriptionId: number, from: string, to: string): Promise<any> {
    const token = await this.authenticate();
    
    try {
      // Parse dates to get year and month
      const fromDate = new Date(from);
      const toDate = new Date(to);

      // For simplicity, use the start month/year if dates don't align
      const year = fromDate.getFullYear();
      const month = fromDate.getMonth() + 1;

      const response = await this.apiClient.get(
        `/usagecost/resellerCustomer/${azurePlanId}/subscription/${subscriptionId}/category/azure/?from=${from}&to=${to}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      // Fallback: try to get Azure usage CSV
      console.warn(`Subscription-level cost endpoint failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      const fromDate = new Date(from);
      const year = fromDate.getFullYear();
      const month = fromDate.getMonth() + 1;

      try {
        const usageData = await this.getAzureUsage({ azurePlanId, subscriptionId, year, month });
        return {
          azurePlanId,
          subscriptionId,
          from,
          to,
          usageData,
          source: 'usage_csv_fallback',
        };
      } catch (usageError) {
        throw new Error(`Failed to fetch costs: ${usageError instanceof Error ? usageError.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * Get cost trends over multiple months
   */
  async getCostTrends(organizationId: number, monthsBack: number = 6): Promise<any> {
    const token = await this.authenticate();
    
    const historicalData = await this.getHistoricalBilling(organizationId, monthsBack);
    const costsByMonth: { [key: string]: number } = {};
    
    // Aggregate costs by month
    if (historicalData.Items) {
      historicalData.Items.forEach((item: any) => {
        // Extract month from StartDate (format: 2025-10-01T00:00:00+00:00)
        const startDate = item.StartDate ? new Date(item.StartDate) : null;
        const month = startDate 
          ? `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}` 
          : 'unknown';
        
        // Extract numeric value from TotalSalesPrice object
        const cost = item.TotalSalesPrice?.Value || 0;
        costsByMonth[month] = (costsByMonth[month] || 0) + cost;
      });
    }

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
    const token = await this.authenticate();
    
    // Get subscriptions and their cost history
    const subscriptions = await this.getSubscriptions(organizationId);
    const billingData = await this.getHistoricalBilling(organizationId, monthsBack);

    const anomalies: any[] = [];
    
    // Group billing data by subscription
    const costsBySubscription: { [key: string]: any[] } = {};
    if (billingData.Items) {
      billingData.Items.forEach((item: any) => {
        const subId = item.SubscriptionId || 'unknown';
        if (!costsBySubscription[subId]) costsBySubscription[subId] = [];
        costsBySubscription[subId].push(item);
      });
    }

    // Analyze trends for each subscription
    Object.entries(costsBySubscription).forEach(([subId, costs]) => {
      const sortedCosts = costs.sort((a: any, b: any) => new Date(a.Date || 0).getTime() - new Date(b.Date || 0).getTime());
      
      for (let i = 1; i < sortedCosts.length; i++) {
        const current = sortedCosts[i].TotalSalesPrice || 0;
        const previous = sortedCosts[i - 1].TotalSalesPrice || 0;
        
        if (previous > 0) {
          const changePercent = ((current - previous) / previous) * 100;
          
          if (Math.abs(changePercent) > changeThresholdPercent) {
            const sub = subscriptions.Items?.find((s: any) => s.Id.toString() === subId);
            anomalies.push({
              subscriptionId: subId,
              subscriptionName: sub?.Name || 'Unknown',
              previousCost: previous,
              currentCost: current,
              change: current - previous,
              changePercent: parseFloat(changePercent.toFixed(2)),
              date: sortedCosts[i].Date,
            });
          }
        }
      }
    });

    // Sort by highest change
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
   */
  async analyzeCostsByTags(organizationId: number, monthsBack: number = 3): Promise<any> {
    const token = await this.authenticate();
    
    // Get all subscriptions with their tags
    const subscriptions = await this.getSubscriptions(organizationId);
    const billingData = await this.getHistoricalBilling(organizationId, monthsBack);

    // Fetch tags for each subscription
    const subscriptionsWithTags = await Promise.all(
      (subscriptions.Items || []).map(async (sub: any) => {
        try {
          const tags = await this.getSubscriptionTags(sub.Id);
          return { ...sub, tags: tags || {} };
        } catch (error) {
          return { ...sub, tags: {} };
        }
      })
    );

    // Create subscription ID to tags mapping
    const subIdToTags = new Map(subscriptionsWithTags.map((s: any) => [s.Id, s.tags]));

    // Aggregate costs by tag
    const costsByTag: { [key: string]: { [key: string]: number } } = {};
    
    if (billingData.Items) {
      billingData.Items.forEach((item: any) => {
        const subId = item.SubscriptionId;
        const cost = item.TotalSalesPrice || 0;
        const tags = subIdToTags.get(subId) || {};

        // Aggregate by each tag key-value pair
        Object.entries(tags).forEach(([tagKey, tagValue]: [string, any]) => {
          if (!costsByTag[tagKey]) costsByTag[tagKey] = {};
          const tagVal = String(tagValue);
          costsByTag[tagKey][tagVal] = (costsByTag[tagKey][tagVal] || 0) + cost;
        });
      });
    }

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
      subscriptionsAnalyzed: subscriptionsWithTags.length,
      costBreakdown,
    };
  }

  /**
   * Find subscriptions by name pattern and get their latest invoice
   */
  async findSimilarSubscriptionsAndInvoices(organizationId: number, namePattern: string): Promise<any> {
    const token = await this.authenticate();
    
    // Get all subscriptions
    const subscriptions = await this.getSubscriptions(organizationId);
    
    // Filter by name pattern (case-insensitive regex)
    const pattern = new RegExp(namePattern, 'i');
    const matchingSubscriptions = (subscriptions.Items || []).filter((sub: any) => 
      pattern.test(sub.Name || '')
    );

    // Get invoices for matching subscriptions
    const invoices = await this.getInvoices(organizationId);
    
    const subscriptionsWithInvoices = await Promise.all(
      matchingSubscriptions.map(async (sub: any) => {
        const subInvoices = (invoices.Items || []).filter((inv: any) => 
          inv.SubscriptionId === sub.Id
        ).sort((a: any, b: any) => new Date(b.Date || 0).getTime() - new Date(a.Date || 0).getTime());

        const tags = await this.getSubscriptionTags(sub.Id).catch(() => ({}));

        return {
          subscription: sub,
          tags,
          lastInvoice: subInvoices[0] || null,
          totalInvoices: subInvoices.length,
          recentInvoices: subInvoices.slice(0, 5),
        };
      })
    );

    return {
      organizationId,
      searchPattern: namePattern,
      matchesFound: matchingSubscriptions.length,
      results: subscriptionsWithInvoices,
    };
  }

  /**
   * List all subscriptions with their tags for verification and auditing
   */
  async listAllSubscriptionsWithTags(organizationId?: number): Promise<any> {
    const token = await this.authenticate();
    
    // Get all subscriptions
    const subscriptions = await this.getSubscriptions(organizationId);
    
    // Fetch tags for each subscription
    const subscriptionsWithTags = await Promise.all(
      (subscriptions.Items || []).map(async (sub: any) => {
        try {
          const tags = await this.getSubscriptionTags(sub.Id);
          return {
            id: sub.Id,
            name: sub.Name,
            status: sub.Status,
            type: sub.Type,
            createdDate: sub.CreatedDate,
            tags: tags || {},
          };
        } catch (error) {
          return {
            id: sub.Id,
            name: sub.Name,
            status: sub.Status,
            type: sub.Type,
            createdDate: sub.CreatedDate,
            tags: {},
            tagsError: `Failed to fetch tags: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      })
    );

    return {
      organizationId: organizationId || 'all',
      totalSubscriptions: subscriptionsWithTags.length,
      subscriptions: subscriptionsWithTags,
    };
  }

  /**
   * Get last month costs summary by organization
   */
  async getLastMonthCostsByOrganization(organizationId: number): Promise<any> {
    const token = await this.authenticate();
    
    // Calculate last month's date range
    const today = new Date();
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0); // Last day of previous month
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    
    const from = lastMonthStart.toISOString().split('T')[0];
    const to = lastMonthEnd.toISOString().split('T')[0];

    try {
      const billingData = await this.getGroupedBillingStatements({
        organizationId,
        from,
        to,
      });

      const totalCost = (billingData.Items || []).reduce((sum: number, item: any) => 
        sum + (item.TotalSalesPrice || 0), 0
      );

      return {
        organizationId,
        period: { from, to, description: 'Last Month' },
        totalCost,
        currencyCode: (billingData.Items && billingData.Items[0]?.CurrencyCode) || 'USD',
        itemsCount: billingData.Items?.length || 0,
        items: billingData.Items || [],
      };
    } catch (error) {
      throw new Error(`Failed to get last month costs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get last month costs breakdown by invoice profile
   */
  async getLastMonthCostsByInvoiceProfile(organizationId: number): Promise<any> {
    const token = await this.authenticate();
    
    // Get invoice profiles
    const profiles = await this.getInvoiceProfiles(organizationId);
    
    // Calculate last month's date range
    const today = new Date();
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    
    const from = lastMonthStart.toISOString().split('T')[0];
    const to = lastMonthEnd.toISOString().split('T')[0];

    // Get costs for each invoice profile
    const costsByProfile = await Promise.all(
      (profiles.Items || []).map(async (profile: any) => {
        try {
          const billingData = await this.getGroupedBillingStatements({
            organizationId,
            invoiceProfileId: profile.Id,
            from,
            to,
          });

          const totalCost = (billingData.Items || []).reduce((sum: number, item: any) => 
            sum + (item.TotalSalesPrice || 0), 0
          );

          return {
            profileId: profile.Id,
            profileName: profile.Name,
            totalCost,
            currencyCode: (billingData.Items && billingData.Items[0]?.CurrencyCode) || 'USD',
            itemsCount: billingData.Items?.length || 0,
          };
        } catch (error) {
          return {
            profileId: profile.Id,
            profileName: profile.Name,
            totalCost: 0,
            error: `Failed to fetch costs: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      })
    );

    const totalOrganizationCost = costsByProfile.reduce((sum: number, p: any) => 
      sum + (p.totalCost || 0), 0
    );

    return {
      organizationId,
      period: { from, to, description: 'Last Month' },
      totalOrganizationCost,
      profilesCount: costsByProfile.length,
      costsByProfile: costsByProfile.sort((a: any, b: any) => 
        (b.totalCost || 0) - (a.totalCost || 0)
      ),
    };
  }

  /**
   * Get last month costs breakdown by tags (CostCenter, Department, etc.)
   */
  async getLastMonthCostsByTags(organizationId: number): Promise<any> {
    const token = await this.authenticate();
    
    // Get all subscriptions with tags
    const subscriptions = await this.getSubscriptions(organizationId);
    
    // Fetch tags for all subscriptions
    const subscriptionsWithTags = await Promise.all(
      (subscriptions.Items || []).map(async (sub: any) => {
        try {
          const tags = await this.getSubscriptionTags(sub.Id);
          return { id: sub.Id, name: sub.Name, tags: tags || {} };
        } catch (error) {
          return { id: sub.Id, name: sub.Name, tags: {} };
        }
      })
    );

    // Calculate last month's date range
    const today = new Date();
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    
    const from = lastMonthStart.toISOString().split('T')[0];
    const to = lastMonthEnd.toISOString().split('T')[0];

    // Get billing data
    const billingData = await this.getGroupedBillingStatements({
      organizationId,
      from,
      to,
    });

    // Create subscription ID to tags mapping
    const subIdToTags = new Map(subscriptionsWithTags.map(s => [s.id, s.tags]));
    const subIdToName = new Map(subscriptionsWithTags.map(s => [s.id, s.name]));

    // Aggregate costs by tag
    const costsByTag: { [key: string]: { [key: string]: { cost: number; subscriptions: string[] } } } = {};
    
    if (billingData.Items) {
      billingData.Items.forEach((item: any) => {
        const subId = item.SubscriptionId;
        const cost = item.TotalSalesPrice || 0;
        const tags = subIdToTags.get(subId) || {};
        const subName = subIdToName.get(subId) || `Unknown (${subId})`;

        // Aggregate by each tag key-value pair
        Object.entries(tags).forEach(([tagKey, tagValue]: [string, any]) => {
          if (!costsByTag[tagKey]) costsByTag[tagKey] = {};
          const tagVal = String(tagValue);
          if (!costsByTag[tagKey][tagVal]) {
            costsByTag[tagKey][tagVal] = { cost: 0, subscriptions: [] };
          }
          costsByTag[tagKey][tagVal].cost += cost;
          if (!costsByTag[tagKey][tagVal].subscriptions.includes(subName)) {
            costsByTag[tagKey][tagVal].subscriptions.push(subName);
          }
        });
      });
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

      const total = breakdown.reduce((sum: number, b: any) => sum + b.cost, 0);

      return {
        tag: tagKey,
        total,
        breakdown,
      };
    }).sort((a: any, b: any) => b.total - a.total);

    const totalCost = costBreakdown.reduce((sum: number, t: any) => sum + t.total, 0);

    return {
      organizationId,
      period: { from, to, description: 'Last Month' },
      totalCost,
      tagsCount: costBreakdown.length,
      costByTags: costBreakdown,
    };
  }
}

