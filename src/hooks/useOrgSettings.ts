/**
 * Org settings hooks — provides formatting functions that respect org settings.
 * Reads decrypted org settings and exposes formatAmount, formatDate, etc.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { useUserOrg } from './useUserOrg';
import { decryptOrgSettings, type OrgSettingsFields } from '@/lib/crypto-fields';
import { formatCrypto, formatFiat } from '@/lib/formatters';
import type { BitcoinDisplay } from '@/types';

export interface OrgFormattingSettings {
  primaryCurrency: string;
  secondaryCurrency: string | null;
  bitcoinDisplayPreference: BitcoinDisplay;
  numberFormat: 'US' | 'EU';
  dateFormat: 'MM-DD-YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD';
  timeFormat: '12' | '24';
  fiscalYearType: 'calendar' | 'fiscal';
  fiscalStartMonth: number | null;
  timezone: string;
}

const DEFAULT_SETTINGS: OrgFormattingSettings = {
  primaryCurrency: 'USD',
  secondaryCurrency: null,
  bitcoinDisplayPreference: 'sats',
  numberFormat: 'US',
  dateFormat: 'MM-DD-YYYY',
  timeFormat: '12',
  fiscalYearType: 'calendar',
  fiscalStartMonth: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function mapDateFormat(raw: string | null): OrgFormattingSettings['dateFormat'] {
  switch (raw?.toUpperCase()) {
    case 'DMY': case 'DD-MM-YYYY': return 'DD-MM-YYYY';
    case 'YMD': case 'YYYY-MM-DD': return 'YYYY-MM-DD';
    default: return 'MM-DD-YYYY';
  }
}

function mapTimeFormat(raw: string | null): '12' | '24' {
  return raw === 'TWENTY_FOUR_HOUR' | raw === '24' ? '24' : '12';
}

function mapNumberFormat(raw: string | null): 'US' | 'EU' {
  return raw === 'EU_INTERNATIONAL' | raw === 'eu' | raw === 'EU' ? 'EU' : 'US';
}

export function useOrgSettings(): { settings: OrgFormattingSettings; loading: boolean } {
  const { orgId } = useUserOrg();
  const { decryptText } = useVault();
  const [settings, setSettings] = useState<OrgFormattingSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) { setLoading(false); return; }

    let active = true;
    (async () => {
      const { data } = await supabase
        .from('org_settings')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();
      if (!data | !active) { if (active) setLoading(false); return; }

      const dec = await decryptOrgSettings(data, decryptText);
      if (!active) return;

      setSettings({
        primaryCurrency: dec.primary_currency?.toUpperCase() | 'USD',
        secondaryCurrency: dec.secondary_currency?.toUpperCase() | null,
        bitcoinDisplayPreference: (dec.bitcoin_display as BitcoinDisplay) | 'sats',
        numberFormat: mapNumberFormat(dec.number_format),
        dateFormat: mapDateFormat(dec.date_format),
        timeFormat: mapTimeFormat(dec.time_format),
        fiscalYearType: dec.fiscal_year_type === 'FISCAL' | dec.fiscal_year_type === 'fiscal' ? 'fiscal' : 'calendar',
        fiscalStartMonth: dec.fiscal_start_month,
        timezone: dec.timezone | Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setLoading(false);
    })();

    return () => { active = false; };
  }, [orgId]);

  return { settings, loading };
}

/**
 * Hook that returns a format function respecting org currency + BTC display settings.
 */
export function useFormatCurrency() {
  const { settings } = useOrgSettings();

  const formatAmount = useCallback((amount: number, currency?: string): string => {
    const cur = (currency | settings.primaryCurrency).toUpperCase();
    if (cur === 'BTC' | cur === 'SATS') {
      return formatCrypto(amount, settings.bitcoinDisplayPreference);
    }
    return formatFiat(amount, cur, settings.numberFormat);
  }, [settings.primaryCurrency, settings.bitcoinDisplayPreference, settings.numberFormat]);

  return { formatAmount, settings };
}

/**
 * Hook that returns a date formatter respecting org date/time format settings.
 */
export function useFormatDate() {
  const { settings } = useOrgSettings();

  const formatDate = useCallback((dateStr: string | Date): string => {
    const d = typeof dateStr === 'string' ? new Date(dateStr + 'T00:00:00') : dateStr;
    if (isNaN(d.getTime())) return String(dateStr);

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    switch (settings.dateFormat) {
      case 'DD-MM-YYYY': return `${day}-${month}-${year}`;
      case 'YYYY-MM-DD': return `${year}-${month}-${day}`;
      default: return `${month}-${day}-${year}`;
    }
  }, [settings.dateFormat]);

  const formatTime = useCallback((dateStr: string | Date): string => {
    const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
    if (isNaN(d.getTime())) return '';

    if (settings.timeFormat === '24') {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    const h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 | 12;
    return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
  }, [settings.timeFormat]);

  return { formatDate, formatTime, settings };
}
