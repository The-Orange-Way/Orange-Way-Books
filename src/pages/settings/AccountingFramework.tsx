/**
 * AccountingFramework, Org Settings section for framework + translation method.
 *
 * Writes accounting_framework and fx_translation_method as plaintext columns
 * on org_settings (no ZKA encryption needed, these are configuration, not financials).
 */

import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import type { AuditFramework, FxTranslationMethod } from '@/lib/reports/audit-footer';

interface AccountingFrameworkProps {
  orgId: string | null;
}

const FRAMEWORK_OPTIONS: { value: AuditFramework; label: string; description: string }[] = [
  {
    value: 'IFRS',
    label: 'IFRS',
    description:
      'IAS 21, The Effects of Changes in Foreign Exchange Rates. Default for companies outside the United States.',
  },
  {
    value: 'US_GAAP',
    label: 'US GAAP',
    description:
      'ASC 830, Foreign Currency Matters. Required for US-registered entities filing under GAAP.',
  },
  {
    value: 'IFRS_AND_GAAP',
    label: 'IFRS + US GAAP (Dual)',
    description:
      'Report under both standards simultaneously. Suitable for multinationals or entities with dual audit requirements.',
  },
];

const TRANSLATION_OPTIONS: { value: FxTranslationMethod; label: string; description: string }[] = [
  {
    value: 'historical-per-transaction',
    label: 'Historical rate per transaction',
    description:
      'Each line uses the rate pinned at posting date. Most precise; required for formal IFRS/GAAP statements. Default.',
  },
  {
    value: 'closing-rate',
    label: 'Closing rate',
    description:
      'All amounts translated at the balance-sheet date rate. Simplified view. Suitable for dashboards.',
  },
  {
    value: 'period-average',
    label: 'Period-average rate',
    description:
      'Income statement lines use average rate over the reporting period. Common in GAAP consolidated reporting.',
  },
];

export function AccountingFramework({ orgId }: AccountingFrameworkProps) {
  const [framework, setFramework] = useState<AuditFramework>('IFRS');
  const [translationMethod, setTranslationMethod] = useState<FxTranslationMethod>(
    'historical-per-transaction',
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    supabase
      .from('org_settings')
      .select('accounting_framework, fx_translation_method')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setFramework(((data as any).accounting_framework as AuditFramework) | 'IFRS');
          setTranslationMethod(
            ((data as any).fx_translation_method as FxTranslationMethod) |
              'historical-per-transaction',
          );
        }
        setLoading(false);
      });
  }, [orgId]);

  const handleSave = async () => {
    if (!orgId) return;
    setSaving(true);
    setSaved(false);
    const { error } = await supabase.from('org_settings').upsert(
      {
        org_id: orgId,
        accounting_framework: framework,
        fx_translation_method: translationMethod,
      } as any,
      { onConflict: 'org_id' },
    );
    setSaving(false);
    if (error) {
      toast.error('Failed to save: ' + error.message);
    } else {
      setSaved(true);
      toast.success('Framework settings saved');
      setTimeout(() => setSaved(false), 2500);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold">Accounting Framework</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Determines which standard governs FX remeasurement, revaluation disclosures, and
          audit-compliance footnotes on exported reports.
        </p>
      </div>

      {/* Framework selector */}
      <div className="space-y-3">
        <Label className="font-semibold">Framework</Label>
        <div className="space-y-2">
          {FRAMEWORK_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${
                framework === opt.value
                  ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange-light)]'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <input
                type="radio"
                name="framework"
                checked={framework === opt.value}
                onChange={() => setFramework(opt.value)}
                className="mt-0.5 accent-[var(--color-brand-orange)]"
              />
              <div>
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Translation method selector */}
      <div className="space-y-3">
        <Label className="font-semibold">Secondary Currency Translation Method</Label>
        <p className="text-xs text-muted-foreground">
          Controls how primary-currency amounts are converted to secondary currency in reports.
          Dashboards always use closing rate for live display.
        </p>
        <div className="space-y-2">
          {TRANSLATION_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${
                translationMethod === opt.value
                  ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange-light)]'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <input
                type="radio"
                name="translation"
                checked={translationMethod === opt.value}
                onChange={() => setTranslationMethod(opt.value)}
                className="mt-0.5 accent-[var(--color-brand-orange)]"
              />
              <div>
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <Button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2"
        style={{ background: 'var(--color-brand-orange)', color: 'white' }}
      >
        {saving ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Saving…
          </>
        ) : saved ? (
          <>
            <CheckCircle2 className="w-4 h-4" />
            Saved
          </>
        ) : (
          'Save Framework Settings'
        )}
      </Button>

      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">What this affects</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Audit compliance footnotes on CSV/PDF exports</li>
          <li>FX revaluation entries (IAS 21 vs ASC 830 disclosure wording)</li>
          <li>Secondary currency translation in the Reports page</li>
        </ul>
        <p className="mt-1">
          Framework setting does <em>not</em> affect the underlying journal entries, those are
          always immutably pinned at posting-date rates regardless of which standard you choose.
        </p>
      </div>
    </div>
  );
}
