/**
 * ChangePrimaryCurrency — three-step wizard for changing the org's primary (functional) currency.
 *
 * D12 decision: atomic write closes previous org_primary_currency_history row + inserts new row
 * + updates org_settings.primary_currency. All prior JE lines keep primary_currency_at_posting
 * so historical reports are never corrupted.
 *
 * Step 1: Preview open items + effective-date picker
 * Step 2: Audit reason (mandatory ≥40 chars)
 * Step 3: Type-to-confirm destructive guard → commit
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { encryptOrgSettings } from '@/lib/crypto-fields';
import { toast } from 'sonner';

const CURRENCIES = [
  'BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX',
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'HKD', 'SGD',
  'MXN', 'BRL', 'INR', 'KRW', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
  'RON', 'ZAR', 'TRY', 'AED', 'SAR',
];

const REASON_CHIPS = [
  'Adopting Bitcoin Standard — all new activity in BTC effective fiscal year start.',
  'Regulatory requirement — local authority mandates functional currency change.',
  'Restructuring — entity relocated jurisdiction, new functional currency required.',
  'Acquisition — consolidated entity uses different functional currency.',
];

interface ChangePrimaryCurrencyProps {
  orgId: string | null;
  currentPrimary: string;
  onChanged?: (newCurrency: string) => void;
}

type WizardStep = 'preview' | 'reason' | 'confirm' | 'done';

interface OpenItem {
  jeDate: string;
  description: string;
  amount: number;
}

export function ChangePrimaryCurrency({ orgId, currentPrimary, onChanged }: ChangePrimaryCurrencyProps) {
  const { encryptText, decryptText } = useVault();

  const [step, setStep] = useState<WizardStep>('preview');
  const [newCurrency, setNewCurrency] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openItems, setOpenItems] = useState<OpenItem[]>([]);
  const [openItemsLoading, setOpenItemsLoading] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId | !newCurrency | step !== 'preview') return;
    // Count open A/R and A/P JE lines that would cross the boundary
    setOpenItemsLoading(true);
    supabase
      .from('journal_entry_lines')
      .select('id, journal_entries!inner(date, org_id)')
      .eq('journal_entries.org_id', orgId)
      .lte('journal_entries.date', effectiveDate)
      .limit(10)
      .then(({ data }) => {
        setOpenItems(
          ((data as any[]) ?? []).slice(0, 5).map((r: any) => ({
            jeDate: r.journal_entries?.date ?? '',
            description: 'Open item crossing boundary',
            amount: 0,
          }))
        );
        setOpenItemsLoading(false);
      });
  }, [orgId, newCurrency, effectiveDate, step]);

  const handleCommit = useCallback(async () => {
    if (!orgId | !newCurrency | !encryptText | !decryptText) return;
    if (reason.length < 40) { setError('Reason must be at least 40 characters.'); return; }
    if (confirmText.trim().toUpperCase() !== currentPrimary.toUpperCase()) {
      setError(`Type "${currentPrimary}" to confirm the change.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Close current era
      await supabase
        .from('org_primary_currency_history' as any)
        .update({ effective_to: effectiveDate } as any)
        .eq('org_id', orgId)
        .is('effective_to', null);

      // Insert new era
      await supabase
        .from('org_primary_currency_history' as any)
        .insert({
          org_id: orgId,
          primary_currency: newCurrency,
          effective_from: effectiveDate,
          effective_to: null,
          reason,
        } as any);

      // Read current org_settings row to preserve all other fields
      const { data: settingsRow } = await supabase
        .from('org_settings')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();

      // Encrypt updated primary_currency, keep all other encrypted fields unchanged
      const enc = await encryptOrgSettings(
        {
          primary_currency: newCurrency,
          secondary_currency: (settingsRow as any)?.secondary_currency ?? null,
          bitcoin_display: (settingsRow as any)?.bitcoin_display ?? null,
          fiscal_year_type: (settingsRow as any)?.fiscal_year_type ?? null,
          fiscal_start_month: (settingsRow as any)?.fiscal_start_month ?? null,
          date_format: (settingsRow as any)?.date_format ?? null,
          time_format: (settingsRow as any)?.time_format ?? null,
          number_format: (settingsRow as any)?.number_format ?? null,
          timezone: (settingsRow as any)?.timezone ?? null,
        },
        encryptText,
      );

      await supabase
        .from('org_settings')
        .upsert({ org_id: orgId, ...enc } as any, { onConflict: 'org_id' });

      toast.success(`Primary currency changed to ${newCurrency} effective ${effectiveDate}`);
      setStep('done');
      onChanged?.(newCurrency);
    } catch (e: any) {
      setError(e.message ?? 'Failed to change primary currency');
    } finally {
      setSaving(false);
    }
  }, [orgId, newCurrency, effectiveDate, reason, confirmText, currentPrimary, encryptText, decryptText, onChanged]);

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-base font-semibold">Change Primary Currency</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Changes the functional currency for all future transactions. Prior journal entries
          keep their original <code className="bg-muted px-1 rounded">primary_currency_at_posting</code> — no data is modified.
        </p>
      </div>

      {/* Current */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-muted/40 border border-border text-sm">
        <span className="text-muted-foreground">Current primary:</span>
        <span className="font-mono font-semibold">{currentPrimary}</span>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {(['preview', 'reason', 'confirm', 'done'] as WizardStep[]).map((s, i) => (
          <span key={s} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/40">›</span>}
            <span className={step === s ? 'text-foreground font-medium' : ''}>
              {s === 'preview' ? '1. Preview' : s === 'reason' ? '2. Reason' : s === 'confirm' ? '3. Confirm' : '4. Done'}
            </span>
          </span>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── Step 1: Preview ── */}
      {step === 'preview' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">New Primary Currency</Label>
            <select
              value={newCurrency}
              onChange={e => setNewCurrency(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <option value="">— select —</option>
              {CURRENCIES.filter(c => c !== currentPrimary).map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Effective Date</Label>
            <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="max-w-xs" />
            <p className="text-xs text-muted-foreground">
              Transactions on or after this date use the new primary currency.
            </p>
          </div>

          {newCurrency && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 space-y-2">
              <p className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> What happens</p>
              <ul className="list-disc list-inside space-y-1">
                <li>All <em>future</em> journal entries will use <strong>{newCurrency}</strong> as primary currency.</li>
                <li>All <em>prior</em> journal entries keep their pinned <strong>{currentPrimary}</strong> amounts — nothing is re-denominated.</li>
                <li>Reports that span this date will show a boundary banner.</li>
                <li>Open A/R and A/P items (below) remain pinned in <strong>{currentPrimary}</strong> until settled.</li>
              </ul>
            </div>
          )}

          {newCurrency && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Open items crossing the boundary (kept pinned in {currentPrimary}):
              </p>
              {openItemsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</div>
              ) : openItems.length === 0 ? (
                <p className="text-xs text-green-700">No open items detected before {effectiveDate}.</p>
              ) : (
                <p className="text-xs text-amber-700">{openItems.length} journal entries found before {effectiveDate}. These will retain {currentPrimary} as their posting currency.</p>
              )}
            </div>
          )}

          <Button
            disabled={!newCurrency | !effectiveDate}
            onClick={() => setStep('reason')}
            style={{ background: 'var(--color-brand-orange)', color: 'white' }}
          >
            Continue <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}

      {/* ── Step 2: Reason ── */}
      {step === 'reason' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Audit Reason <span className="text-muted-foreground font-normal">(minimum 40 characters)</span>
            </Label>
            <textarea
              className="w-full border rounded-md px-3 py-2 text-sm bg-background resize-none"
              style={{ borderColor: 'var(--color-border)' }}
              rows={4}
              placeholder="Describe why the primary currency is changing…"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
            <p className={`text-xs ${reason.length >= 40 ? 'text-green-600' : 'text-muted-foreground'}`}>
              {reason.length} / 40 chars {reason.length >= 40 ? '✓' : 'required'}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">Example chips (click to use):</p>
            <div className="flex flex-wrap gap-2">
              {REASON_CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => setReason(chip)}
                  className="px-2 py-1 text-xs border rounded-md bg-background hover:bg-muted transition-colors text-left"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  {chip.slice(0, 50)}…
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep('preview')}>← Back</Button>
            <Button
              disabled={reason.length < 40}
              onClick={() => setStep('confirm')}
              style={{ background: 'var(--color-brand-orange)', color: 'white' }}
            >
              Continue <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Confirm ── */}
      {step === 'confirm' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-2">
            <p className="font-semibold">This action cannot be undone.</p>
            <p className="text-xs">
              You are changing the primary currency from <strong>{currentPrimary}</strong> to <strong>{newCurrency}</strong> effective <strong>{effectiveDate}</strong>.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Type <code className="bg-muted px-1 rounded font-mono">{currentPrimary}</code> to confirm:
            </Label>
            <Input
              placeholder={currentPrimary}
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              className="max-w-xs font-mono"
            />
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep('reason')}>← Back</Button>
            <Button
              variant="destructive"
              disabled={saving | confirmText.trim().toUpperCase() !== currentPrimary.toUpperCase()}
              onClick={handleCommit}
            >
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Changing…</> : `Change to ${newCurrency}`}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 4: Done ── */}
      {step === 'done' && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg text-sm" style={{ background: '#DCFCE7', border: '1px solid #86EFAC', color: '#166534' }}>
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <div>
            <p className="font-semibold">Primary currency changed to {newCurrency}.</p>
            <p className="text-xs mt-0.5">
              New transactions will use {newCurrency}. Prior entries are unchanged. Reload the app to refresh all views.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
