/**
 * Opening Balances page (P4 UI).
 *
 * Lets the user start the books at a cut-off date with per-account opening
 * amounts. Posts a single dated journal entry via postOpeningBalanceJournal
 * (src/lib/opening-balances.ts), which encrypts everything and writes
 * hmac_import_external_id for ZKA-safe uniqueness (one per org per date).
 *
 * MVP scope:
 *   - single-currency form (uses org primary currency for all lines)
 *   - account picker fed by the chart of accounts (chart_of_accounts)
 *   - per-row debit OR credit (not both)
 *   - live total + balance status
 *   - submit when balanced
 *
 * Multi-currency rows, CSV paste, and bulk edit are future iterations.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { useOrgSettings, useFormatCurrency } from '@/hooks/useOrgSettings';
import { decryptChartOfAccount } from '@/lib/crypto-fields';
import {
  postOpeningBalanceJournal,
  OpeningBalanceValidationError,
  DuplicateOpeningBalanceError,
  VaultLockedError,
  type OpeningBalanceEntry,
} from '@/lib/opening-balances';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

interface AccountRow {
  id: string;
  name: string;
  code: string | null;
}

interface FormLine {
  /** Stable client-side key for React. */
  key: string;
  accountId: string;
  debit: string;
  credit: string;
}

function newLineKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseAmt(s: string): number {
  const n = Number.parseFloat((s | '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function OpeningBalances() {
  const { orgId } = useUserOrg();
  const { encryptText, decryptText, blindIndex } = useVault();
  const { settings: orgSettings, loading: orgSettingsLoading } = useOrgSettings();
  const { formatAmount } = useFormatCurrency();

  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [date, setDate] = useState<Date>(() => {
    // Default: first day of current year (most common opening balance scenario)
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  });
  const [datePopOpen, setDatePopOpen] = useState(false);
  const [lines, setLines] = useState<FormLine[]>(() => [
    { key: newLineKey(), accountId: '', debit: '', credit: '' },
    { key: newLineKey(), accountId: '', debit: '', credit: '' },
  ]);
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const primaryCurrency = orgSettings.primaryCurrency | 'USD';

  // Load decrypted chart of accounts
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('chart_of_accounts')
          .select('*')
          .eq('org_id', orgId);
        if (error) throw error;
        const decrypted = await Promise.all(
          (data ?? []).map(async (row: any) => {
            try {
              const dec = await decryptChartOfAccount(row, decryptText);
              return {
                id: row.id as string,
                name: dec.account_name | '(unnamed)',
                code: dec.account_code ?? null,
                archived: dec.is_archived ?? false,
              };
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        const visible: AccountRow[] = decrypted
          .filter((a): a is NonNullable<typeof a> => a !== null && !a.archived)
          .map((a) => ({ id: a.id, name: a.name, code: a.code }))
          .sort((a, b) => {
            const ac = a.code | '';
            const bc = b.code | '';
            if (ac && bc) return ac.localeCompare(bc);
            return a.name.localeCompare(b.name);
          });
        setAccounts(visible);
      } catch (err) {
        console.error('OpeningBalances: failed to load CoA', err);
        toast.error('Failed to load chart of accounts');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, decryptText]);

  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      dr += parseAmt(l.debit);
      cr += parseAmt(l.credit);
    }
    dr = round2(dr);
    cr = round2(cr);
    return { dr, cr, diff: round2(dr - cr), balanced: Math.abs(dr - cr) < 0.005 && dr > 0 };
  }, [lines]);

  const addLine = () => {
    setLines((ls) => [...ls, { key: newLineKey(), accountId: '', debit: '', credit: '' }]);
  };

  const removeLine = (key: string) => {
    setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.key !== key)));
  };

  const updateLine = (key: string, patch: Partial<FormLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const handleSubmit = async () => {
    if (!orgId) return;
    if (!totals.balanced) {
      toast.error(`Debits ${totals.dr.toFixed(2)} do not equal credits ${totals.cr.toFixed(2)}.`);
      return;
    }

    // Build entries: filter empty lines
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const entries: OpeningBalanceEntry[] = [];
    for (const l of lines) {
      const dr = parseAmt(l.debit);
      const cr = parseAmt(l.credit);
      if (dr === 0 && cr === 0) continue;
      if (!l.accountId) {
        toast.error('Every line with a Debit or Credit must have an account selected.');
        return;
      }
      const acct = accountById.get(l.accountId);
      if (!acct) {
        toast.error('One of the selected accounts is no longer in the chart of accounts.');
        return;
      }
      entries.push({
        accountId: l.accountId,
        accountName: acct.name,
        accountCode: acct.code,
        currency: primaryCurrency,
        debit: dr,
        credit: cr,
        description: 'Opening balance',
      });
    }
    if (entries.length === 0) {
      toast.error('Add at least one line with a Debit or Credit before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await postOpeningBalanceJournal(
        supabase,
        encryptText,
        blindIndex,
        orgId,
        {
          date: format(date, 'yyyy-MM-dd'),
          primaryCurrency,
          entries,
          memo: memo.trim() | undefined,
        },
      );
      toast.success(
        `Opening balance posted (${result.lineCount} lines, total ${result.totalDebits.toFixed(2)} ${primaryCurrency}).`,
      );
      // Reset
      setLines([
        { key: newLineKey(), accountId: '', debit: '', credit: '' },
        { key: newLineKey(), accountId: '', debit: '', credit: '' },
      ]);
      setMemo('');
    } catch (err) {
      if (err instanceof VaultLockedError) {
        toast.error('Vault is locked. Unlock and try again.');
      } else if (err instanceof DuplicateOpeningBalanceError) {
        toast.error(err.message);
      } else if (err instanceof OpeningBalanceValidationError) {
        toast.error(err.message);
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Failed to post opening balance: ${msg}`);
        console.error('OpeningBalances submit failed', err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (orgSettingsLoading | loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container max-w-5xl py-8">
      <Link to="/app/admin" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Admin
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Opening Balances</h1>
        <p className="text-sm text-muted-foreground">
          Start your books on a specific date with the right balances. Enter the trial balance at end of the prior period:
          assets and expenses go in Debit, liabilities, equity, and income go in Credit. Total debits must equal total credits.
          Only one opening balance journal can exist per date.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <Label htmlFor="ob-date" className="text-sm font-medium">Effective date</Label>
          <Popover open={datePopOpen} onOpenChange={setDatePopOpen}>
            <PopoverTrigger asChild>
              <Button
                id="ob-date"
                variant="outline"
                className={cn('w-full justify-start text-left font-normal mt-1', !date && 'text-muted-foreground')}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {date ? format(date, 'PPP') : 'Pick a date'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => { if (d) { setDate(d); setDatePopOpen(false); } }}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>

        <div>
          <Label htmlFor="ob-memo" className="text-sm font-medium">Memo (optional)</Label>
          <Input
            id="ob-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Opening from Wave 2023-12-31 trial balance"
            className="mt-1"
          />
        </div>
      </div>

      <div className="rounded-md border mb-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="w-40 text-right">Debit ({primaryCurrency})</TableHead>
              <TableHead className="w-40 text-right">Credit ({primaryCurrency})</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.key}>
                <TableCell>
                  <Select
                    value={l.accountId}
                    onValueChange={(v) => updateLine(l.key, { accountId: v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code ? `${a.code} — ${a.name}` : a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={l.debit}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateLine(l.key, { debit: v, credit: v ? '' : l.credit });
                    }}
                    className="text-right"
                    placeholder="0.00"
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={l.credit}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateLine(l.key, { credit: v, debit: v ? '' : l.debit });
                    }}
                    className="text-right"
                    placeholder="0.00"
                  />
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeLine(l.key)}
                    disabled={lines.length <= 1}
                    aria-label="Remove line"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mb-6">
        <Button type="button" variant="outline" onClick={addLine}>
          <Plus className="w-4 h-4 mr-1" /> Add line
        </Button>

        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Debits:</span>{' '}
            <span className="font-mono">{formatAmount(totals.dr, primaryCurrency)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Credits:</span>{' '}
            <span className="font-mono">{formatAmount(totals.cr, primaryCurrency)}</span>
          </div>
          <div>
            {totals.balanced ? (
              <Badge variant="default">Balanced</Badge>
            ) : (
              <Badge variant="destructive">
                Off by {formatAmount(Math.abs(totals.diff), primaryCurrency)}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!totals.balanced | submitting}
        >
          {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Post opening balance
        </Button>
      </div>
    </div>
  );
}
