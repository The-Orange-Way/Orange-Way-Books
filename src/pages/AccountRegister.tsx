/**
 * Account Register — account statement view (T5B).
 *
 * Shows every encrypted movement that touched a single chart-of-accounts row,
 * sorted oldest-to-newest, with a running balance. Pulls from two sources:
 *
 *   1. transactions where account_id = :accountId AND status != VOID
 *      (standard-mode transactions — direct legacy ledger backend posting, no JE wrapper today)
 *   2. journal_entry_lines where account_id = :accountId AND parent JE.status != VOID
 *      (split / transfer / manual JE rows)
 *
 * Both are decrypted browser-side and merged by date. Running balance respects
 * the account's normal-balance side (asset/expense are debit-normal; liability/
 * equity/revenue are credit-normal). Excludes VOID entries by design.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import {
  decryptChartOfAccount,
  decryptTransaction,
  decryptJournalEntry,
  decryptJournalEntryLine,
} from '@/lib/crypto-fields';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { format } from 'date-fns';

interface RegisterRow {
  id: string;
  date: string;
  source: 'transaction' | 'journal_entry_line';
  source_id: string;
  description: string;
  debit: number;
  credit: number;
  status: string | null;
  running: number;
}

export default function AccountRegister() {
  const { accountId } = useParams<{ accountId: string }>();
  const { orgId } = useUserOrg();
  const { decryptText } = useVault();
  const { formatAmount } = useFormatCurrency();

  const [loading, setLoading] = useState(true);
  const [accountName, setAccountName] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [accountType, setAccountType] = useState<string | null>(null);
  const [normalBalance, setNormalBalance] = useState<'DEBIT' | 'CREDIT'>('DEBIT');
  const [rows, setRows] = useState<RegisterRow[]>([]);

  useEffect(() => {
    if (!accountId | !orgId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Account header
        const { data: acc } = await supabase
          .from('chart_of_accounts')
          .select('*')
          .eq('id', accountId)
          .single();
        if (acc) {
          try {
            const dec = await decryptChartOfAccount(acc as any, decryptText);
            if (!cancelled) {
              setAccountName(dec.account_name | '(unnamed)');
              setAccountCode(dec.account_code | '');
              setAccountType(dec.account_type | null);
            }
          } catch {
            if (!cancelled) setAccountName('(decrypt failed)');
          }
          // normal_balance lives plaintext on the row
          if ((acc as any).normal_balance === 'CREDIT' && !cancelled) {
            setNormalBalance('CREDIT');
          }
        }

        // Source 1: transactions
        const { data: txRows } = await supabase
          .from('transactions')
          .select('*')
          .eq('org_id', orgId)
          .eq('account_id', accountId);

        const txDecrypted: Omit<RegisterRow, 'running'>[] = [];
        for (const row of (txRows ?? []) as any[]) {
          try {
            const dec = await decryptTransaction(row, decryptText);
            if (dec.status === 'VOID') continue;
            const amt = dec.amount ?? 0;
            txDecrypted.push({
              id: `tx-${row.id}`,
              date: row.date,
              source: 'transaction',
              source_id: row.id,
              description: dec.memo ?? dec.type ?? '—',
              debit: amt > 0 ? amt : 0,
              credit: amt < 0 ? Math.abs(amt) : 0,
              status: dec.status ?? null,
            });
          } catch {
            // skip undecryptable
          }
        }

        // Source 2: journal_entry_lines (join through parent JE)
        const { data: jelRows } = await supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(id, date, status, key_version, source_type, org_id, encrypted_memo, memo)')
          .eq('account_id', accountId)
          .eq('journal_entries.org_id', orgId);

        const jelDecrypted: Omit<RegisterRow, 'running'>[] = [];
        for (const row of (jelRows ?? []) as any[]) {
          try {
            const dec = await decryptJournalEntryLine(row, decryptText);
            const je = row.journal_entries;
            // Skip lines whose parent JE is VOID.
            let jeStatus = je?.status as string | null;
            try {
              if (je?.key_version) {
                const jeDec = await decryptJournalEntry(je, decryptText);
                jeStatus = jeDec.status ?? null;
              }
            } catch { /* keep raw status */ }
            if (jeStatus === 'VOID') continue;
            jelDecrypted.push({
              id: `jel-${row.id}`,
              date: je?.date ?? '',
              source: 'journal_entry_line',
              source_id: row.id,
              description: dec.description ?? '—',
              debit: dec.debit ?? 0,
              credit: dec.credit ?? 0,
              status: jeStatus,
            });
          } catch {
            // skip
          }
        }

        // Merge + sort by date asc; compute running balance respecting the
        // account's normal side.
        const merged = [...txDecrypted, ...jelDecrypted].sort((a, b) => {
          if (a.date < b.date) return -1;
          if (a.date > b.date) return 1;
          return 0;
        });
        let running = 0;
        const isDebitNormal = ((acc as any)?.normal_balance ?? 'DEBIT') !== 'CREDIT';
        const final: RegisterRow[] = merged.map(r => {
          const delta = isDebitNormal ? (r.debit - r.credit) : (r.credit - r.debit);
          running += delta;
          return { ...r, running };
        });
        if (!cancelled) setRows(final);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, orgId, decryptText]);

  const endingBalance = useMemo(() => {
    if (rows.length === 0) return 0;
    return rows[rows.length - 1].running;
  }, [rows]);

  if (!accountId) {
    return <div className="p-6 text-sm text-muted-foreground">No account selected.</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="outline" size="sm">
          <Link to="/app/admin?tab=chart"><ArrowLeft className="w-4 h-4 mr-1" /> Back to Chart of Accounts</Link>
        </Button>
      </div>
      <div>
        <h1 className="text-2xl font-bold">
          {accountCode && <span className="font-mono text-muted-foreground mr-2">{accountCode}</span>}
          {accountName | '—'}
        </h1>
        <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
          {accountType && <Badge variant="outline">{accountType}</Badge>}
          <span>Normal balance: <span className="font-medium">{normalBalance}</span></span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-10 text-sm">
                      No movements on this account yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.date}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {r.source === 'transaction' ? 'Tx' : 'JE'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{r.description}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-green-700">
                        {r.debit > 0 ? formatAmount(r.debit) : ''}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-red-700">
                        {r.credit > 0 ? formatAmount(r.credit) : ''}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatAmount(r.running)}</TableCell>
                      <TableCell>
                        {r.status && r.status !== 'POSTED' && (
                          <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="text-sm flex items-center justify-end gap-2">
            <span className="text-muted-foreground">Ending balance:</span>
            <span className="font-mono font-medium">{formatAmount(endingBalance)}</span>
          </div>
        </>
      )}
    </div>
  );
}
