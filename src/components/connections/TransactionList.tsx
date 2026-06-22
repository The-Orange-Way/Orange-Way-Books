import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ArrowDownLeft, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { findImportedOrTxIds } from '@/lib/orImportBridge';

/**
 * Decrypted transaction shape — matches the NormalizedTransaction emitted by
 * orange-rails/supabase/functions/or-sync/index.ts when it stores
 * encrypted_payload on encrypted_transactions.
 *
 * Phase 3: source_wallet_id arrives populated when or-sync runs in
 * source-wallet mode (i.e. the connection has source_wallets rows). Legacy
 * connections leave it null; the UI falls back to "unrouted".
 */
interface DecryptedTx {
  id: string;
  adapter: string;
  direction: 'in' | 'out';
  type: 'lightning' | 'onchain' | 'trade' | 'deposit' | 'withdrawal' | 'fee';
  amount_sats?: number;
  amount?: number;
  currency?: string;
  description?: string | null;
  counterparty?: string | null;
  status?: string;
  timestamp: string;
  /** Populated by or-sync when source-wallet routing is configured. */
  source_wallet_id?: string | null;
}

/** Raw row shape from or-transactions-list. */
interface EncryptedTxRow {
  id: string;
  connection_id: string;
  external_id: string;
  encrypted_payload: string;
  occurred_at: string;
}

interface DisplayTx {
  rowId: string;
  occurredAt: string;
  payload: DecryptedTx | null;
  decryptError: string | null;
}

export interface TransactionListProps {
  /** Caller invokes the owb-or-proxy `or-transactions-list` endpoint. */
  fetchEncrypted: () => Promise<EncryptedTxRow[]>;
  /** Decrypts a single encrypted_payload (base64 IV+ciphertext) using ORT. */
  decrypt: (ciphertext: string) => Promise<string>;
  /** Bumped by parent when sync finishes, to trigger a refetch. */
  refreshKey?: number;
  /**
   * Phase 3: resolves a transaction's source_wallet_id to a human-readable
   * destination account name. Returns null when the transaction is unrouted
   * (no source_wallet_id, or no mapping exists for that wallet).
   *
   * The parent owns the routing index because it joins client-side data
   * (the connection_account_map table + chart_of_accounts) before passing
   * us this lookup function.
   */
  resolveRouting?: (sourceWalletId: string | null | undefined) => string | null;
  /**
   * Phase 5: parent OR connection id. Used when querying the OWB transactions
   * table to detect which OR rows have already been bridged into the ledger.
   * When omitted, the "in ledger" badge is hidden.
   */
  orConnectionId?: string;
  /**
   * Phase 5: resolves an OR source_wallet_id to its destination OWB wallet id
   * (or null when unrouted). The badge query uses these wallet ids to scope
   * the lookup so we never scan the full transactions table.
   */
  resolveDestinationWalletId?: (sourceWalletId: string | null | undefined) => string | null;
}

export function TransactionList({
  fetchEncrypted,
  decrypt,
  refreshKey,
  resolveRouting,
  orConnectionId,
  resolveDestinationWalletId,
}: TransactionListProps) {
  const [rows, setRows] = useState<DisplayTx[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set of OR external_ids that already have a corresponding OWB transactions
   * row imported by orImportBridge. Recomputed whenever rows or routing
   * changes — drives the "in ledger" badge in the Routed-to column.
   */
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const encrypted = await fetchEncrypted();
      const decoded = await Promise.all(
        encrypted.map(async (r): Promise<DisplayTx> => {
          try {
            const json = await decrypt(r.encrypted_payload);
            const payload = JSON.parse(json) as DecryptedTx;
            return { rowId: r.id, occurredAt: r.occurred_at, payload, decryptError: null };
          } catch (err) {
            return {
              rowId: r.id,
              occurredAt: r.occurred_at,
              payload: null,
              decryptError: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      setRows(decoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [fetchEncrypted, decrypt]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Phase 5: once decrypted rows are available AND we have routing context,
  // ask OWB which OR external_ids already have a corresponding ledger row.
  // Scope the query to the destination wallets that this connection's
  // mappings actually point at — keeps the query small and avoids touching
  // unrelated wallet histories.
  useEffect(() => {
    let cancelled = false;
    if (!orConnectionId || !resolveDestinationWalletId || !rows || rows.length === 0) {
      setImportedIds(new Set());
      return;
    }
    const walletIdSet = new Set<string>();
    const orExternalIds: string[] = [];
    for (const r of rows) {
      if (!r.payload) continue;
      orExternalIds.push(r.payload.id);
      const destId = resolveDestinationWalletId(r.payload.source_wallet_id);
      if (destId) walletIdSet.add(destId);
    }
    if (walletIdSet.size === 0 || orExternalIds.length === 0) {
      setImportedIds(new Set());
      return;
    }
    void findImportedOrTxIds(Array.from(walletIdSet), orConnectionId, orExternalIds)
      .then((set) => {
        if (!cancelled) setImportedIds(set);
      })
      .catch((err) => {
        // Badge lookup is decorative — log but never block the row render.
        console.warn('[TransactionList] findImportedOrTxIds failed:', err);
        if (!cancelled) setImportedIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [rows, orConnectionId, resolveDestinationWalletId]);

  // Memoize the imported set into a stable callback the row component can
  // consume without prop-drill ceremony.
  const isImported = useMemo(() => {
    return (orTxId: string): boolean => importedIds.has(orTxId);
  }, [importedIds]);

  if (loading && rows === null) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2 py-2">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading transactions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-destructive py-2">Failed to load transactions: {error}</div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-2">
        No transactions yet — click Sync to fetch the latest from your provider.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[160px]">Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Memo</TableHead>
            <TableHead>Routed to</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TransactionRow
              key={r.rowId}
              tx={r}
              resolveRouting={resolveRouting}
              imported={r.payload ? isImported(r.payload.id) : false}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TransactionRow({
  tx,
  resolveRouting,
  imported,
}: {
  tx: DisplayTx;
  resolveRouting?: (sourceWalletId: string | null | undefined) => string | null;
  /** Phase 5: true when this OR row already has an OWB ledger row (transactions + JE). */
  imported: boolean;
}) {
  const date = formatDate(tx.occurredAt);

  if (!tx.payload) {
    return (
      <TableRow>
        <TableCell className="text-xs text-muted-foreground">{date}</TableCell>
        <TableCell className="text-right text-xs text-destructive">decrypt failed</TableCell>
        <TableCell className="text-xs text-muted-foreground truncate max-w-[280px]">
          {tx.decryptError}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">—</TableCell>
      </TableRow>
    );
  }

  const p = tx.payload;
  const isIn = p.direction === 'in';
  const Icon = isIn ? ArrowDownLeft : ArrowUpRight;
  const sign = isIn ? '+' : '−';
  const amountText =
    typeof p.amount_sats === 'number'
      ? `${formatNumber(p.amount_sats)} sats`
      : typeof p.amount === 'number'
        ? `${formatMoney(p.amount)} ${p.currency ?? ''}`.trim()
        : '—';
  const memo = p.description | p.counterparty | (p.type ? capitalize(p.type) : '');

  const routedAccountName = resolveRouting ? resolveRouting(p.source_wallet_id) : null;

  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap">{date}</TableCell>
      <TableCell className="text-right text-xs whitespace-nowrap">
        <span
          className={`inline-flex items-center gap-1 font-medium ${isIn ? 'text-green-600 dark:text-green-400' : 'text-foreground'}`}
        >
          <Icon className="w-3 h-3" />
          {sign}
          {amountText}
        </span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground truncate max-w-[280px]">
        {memo | <span className="italic">no memo</span>}
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          {routedAccountName ? (
            <span className="inline-flex items-center rounded border border-input bg-muted/30 px-1.5 py-0.5 text-[10px] tracking-wide truncate max-w-[160px]">
              {routedAccountName}
            </span>
          ) : (
            <span className="italic text-muted-foreground">unrouted</span>
          )}
          {imported && (
            <span
              className="inline-flex items-center gap-0.5 rounded border border-green-500/40 bg-green-500/10 px-1 py-0.5 text-[10px] text-green-700 dark:text-green-400"
              title="Already imported into your wallet ledger and journal entries."
            >
              <CheckCircle2 className="w-2.5 h-2.5" />
              in ledger
            </span>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
