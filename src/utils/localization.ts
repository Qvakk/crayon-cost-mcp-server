/**
 * Localization utility for month names
 * Supports English and Norwegian
 */

export type Locale = 'en' | 'no';

const MONTH_NAMES: Record<Locale, string[]> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ],
  no: [
    'januar', 'februar', 'mars', 'april', 'mai', 'juni',
    'juli', 'august', 'september', 'oktober', 'november', 'desember'
  ]
};

/**
 * Format a month string (YYYY-MM) to localized "Month YYYY" format
 * @param monthString - Month in YYYY-MM format (e.g., "2025-10")
 * @param locale - Language locale ('en' or 'no')
 * @returns Formatted month name (e.g., "October 2025" or "oktober 2025")
 */
export function formatMonthYear(monthString: string, locale: Locale = 'en'): string {
  if (!monthString || monthString === 'unknown') {
    return 'Unknown';
  }

  const [year, month] = monthString.split('-');
  const monthIndex = parseInt(month, 10) - 1; // Convert to 0-based index

  if (isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return monthString; // Return original if invalid
  }

  const monthName = MONTH_NAMES[locale][monthIndex];
  return `${monthName} ${year}`;
}

/**
 * Get the current locale from environment or default to English
 * @returns Current locale setting
 */
export function getCurrentLocale(): Locale {
  const envLocale = process.env.LOCALE?.toLowerCase();
  return (envLocale === 'no' || envLocale === 'nb' || envLocale === 'nn') ? 'no' : 'en';
}
