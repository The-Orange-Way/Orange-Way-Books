import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, ExternalLink, Loader2, Trash2, KeyRound, AlertTriangle, ChevronDown, ChevronRight, Pencil, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { useCapability } from '@/hooks/useCapability';
import { TransactionList } from '@/components/connections/TransactionList';
import { WalletPickerStep, type DiscoveredWallet } from '@/components/connections/WalletPickerStep';
import { DestinationAccountPicker, type SourceWalletPick } from '@/components/connections/DestinationAccountPicker';
import { SourceWalletBadges, type DecryptedSourceWallet } from '@/components/connections/SourceWalletBadges';
import { DestinationAccountChips } from '@/components/connections/DestinationAccountChips';
import { ConfirmDialog } from '@/components/connections/ConfirmDialog';
import { decryptWallet, decryptOrgSettings } from '@/lib/crypto-fields';
import {
  fetchAndDecryptMappings,
  saveMappingsForConnection,
  buildMappingIndex,
  lookupRouting,
  type DecryptedConnectionAccountMapping,
} from '@/lib/connectionAccountMap';
import {
  importOrTransactionsToV3,
  type DecryptedOrTx,
  type DestinationWallet,
} from '@/lib/orImportBridge';

const SUBACCOUNT_LS_PREFIX = 'or_subaccount_id_for_org_';

/**
 * localStorage key tracking which connection ids opened the picker but never
 * completed it. We use this to surface a "Setup incomplete" badge so the user
 * can resume the flow rather than being stuck with a connection that has no
 * source_wallets / mappings.
 *
 * Stored as a JSON-encoded string array; entries are added on connection
 * create and removed once or-source-wallets-set succeeds. The current
 * implementation also shows a "Configure wallets" button on ANY connection
 * with zero source_wallets — the localStorage flag just lets us style the
 * incomplete ones distinctly.
 */
const INCOMPLETE_CONNECTIONS_LS_PREFIX = 'or_incomplete_connections_for_org_';

function readIncompleteSet(orgId: string | null): Set<string> {
  if (!orgId) return new Set();
  try {
    const raw = localStorage.getItem(INCOMPLETE_CONNECTIONS_LS_PREFIX + orgId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeIncompleteSet(orgId: string | null, set: Set<string>): void {
  if (!orgId) return;
  try {
    localStorage.setItem(
      INCOMPLETE_CONNECTIONS_LS_PREFIX + orgId,
      JSON.stringify(Array.from(set)),
    );
  } catch {
    /* swallow quota errors — incomplete tracking is a UX hint, not load-bearing */
  }
}

interface RawSourceWallet {
  id: string;
  external_wallet_id: string;
  is_synced: boolean;
  encrypted_metadata: string;
}

interface ConnectionRow {
  id: string;
  provider_type: string;
  encrypted_label: string | null;
  encrypted_credentials: string;
  status: 'active' | 'error' | 'disconnected';
  last_sync_at: string | null;
  encrypted_last_error: string | null;
  /** Phase 3: per-wallet sync selection — empty for legacy connections. */
  source_wallets?: RawSourceWallet[];
  // Decrypted client-side after fetch.
  decrypted_label?: string | null;
  decrypted_last_error?: string | null;
  decrypted_source_wallets?: DecryptedSourceWallet[];
}

interface AccountNameLookup {
  /** wallets.id → plaintext wallet name */
  byId: Map<string, string>;
  /**
   * wallets.id → full DestinationWallet projection (id + name + asset). Used
   * by the OR→OWB import bridge to compose ledger rows. Kept alongside `byId`
   * because most callers only need the name and treating asset as required
   * would force every render path to handle a missing decrypt.
   */
  walletsById: Map<string, DestinationWallet>;
}

const PROVIDERS = [
  {
    type: 'blink',
    name: 'Blink',
    description: 'Lightning + USD stablecoin wallet.',
    apiKeyUrl: 'https://dashboard.blink.sv/api-keys',
    steps: [
      'Sign in to the Blink dashboard.',
      'Go to Settings → API keys (or use the link above).',
      'Create a new key with read-only access — we only need to read your transactions.',
      'Copy the key and paste it below before it disappears (Blink only shows it once).',
    ],
  },
] as const;

async function postProxy(
  accessToken: string,
  endpoint: string,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/owb-or-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ endpoint, org_id: orgId, payload }),
  });
}

async function callProxy(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  const orgId = localStorage.getItem('orangewaybooks.active_org');
  if (!orgId) throw new Error('No active org');

  // First call: send current session access_token. The Supabase Edge
  // Function gateway sometimes rejects a freshly-minted ES256 JWT with
  // UNAUTHORIZED_NO_AUTH_HEADER on the first call (propagation lag
  // between Auth and the gateway). legacy-proxy has hit this for months
  // and works around it by calling refreshSession() on 401 and
  // retrying once. Mirror that pattern here.
  let resp = await postProxy(session.access_token, endpoint, orgId, payload);
  if (resp.status === 401) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed?.session?.access_token) {
      resp = await postProxy(refreshed.session.access_token, endpoint, orgId, payload);
    }
  }

  const text = await resp.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data && data.error)
      ? String(data.error)
      : `${endpoint} failed (HTTP ${resp.status})`;
    throw new Error(msg);
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data;
}

export default function Connections() {
  const {
    isUnlocked,
    encryptText, decryptText,
    encryptOrCipher, decryptOrCipher, decryptOrTxnCipher,
    exportOrCredsKey, exportOrTxnsKey,
  } = useVault();

  const [orgId, setOrgId] = useState<string | null>(null);
  // Capability gate — UI presence only; RLS still authoritative on writes.
  const canWriteConnectors = useCapability('connectors.write', orgId);
  const [subaccountId, setSubaccountId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Bumped per-connection after a successful sync so the embedded
  // TransactionList refetches its rows.
  const [txRefreshKeys, setTxRefreshKeys] = useState<Record<string, number>>({});

  // Phase 3 — wallet picker / destination mapping state.
  const [walletPicker, setWalletPicker] = useState<{
    connectionId: string;
    providerType: string;
    providerName: string;
    discovered: DiscoveredWallet[];
  } | null>(null);
  const [destPicker, setDestPicker] = useState<{
    connectionId: string;
    sourceWallets: SourceWalletPick[];
  } | null>(null);
  const [mappings, setMappings] = useState<DecryptedConnectionAccountMapping[]>([]);
  const [accountLookup, setAccountLookup] = useState<AccountNameLookup>({
    byId: new Map(),
    walletsById: new Map(),
  });
  /** Org primary currency, needed by the bridge to compose dual-currency JEs. */
  const [primaryCurrency, setPrimaryCurrency] = useState<string>('USD');
  /**
   * Per-connection bridge progress flag — drives the "Importing…" badge on
   * the connection card so the user sees the second phase of "Sync now"
   * (OR-side fetch → OWB import) explicitly.
   */
  const [bridgingId, setBridgingId] = useState<string | null>(null);
  /** Connection ids where the user opened the picker but never completed it. */
  const [incompleteConnIds, setIncompleteConnIds] = useState<Set<string>>(new Set());
  /** Branded delete confirmation — controlled state, replaces window.confirm. */
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRow | null>(null);

  // Resolve org + subaccount on mount.
  useEffect(() => {
    const id = localStorage.getItem('orangewaybooks.active_org');
    setOrgId(id);
    if (id) {
      const cached = localStorage.getItem(SUBACCOUNT_LS_PREFIX + id);
      if (cached) setSubaccountId(cached);
      setIncompleteConnIds(readIncompleteSet(id));
    }
  }, []);

  // Lazily provision when missing (after isUnlocked, since proxy uses JWT).
  useEffect(() => {
    if (!orgId || subaccountId || !isUnlocked) return;
    let cancelled = false;
    (async () => {
      setProvisioning(true);
      try {
        const res = (await callProxy('or-provision', {})) as { subaccount_id: string };
        if (cancelled) return;
        localStorage.setItem(SUBACCOUNT_LS_PREFIX + orgId, res.subaccount_id);
        setSubaccountId(res.subaccount_id);
      } catch (err) {
        if (!cancelled) {
          console.error('[Connections] provision failed', err);
          toast.error(`Failed to set up OrangeRails: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        if (!cancelled) setProvisioning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, subaccountId, isUnlocked]);

  // Fetch connections list whenever subaccount + vault are ready. Decrypts
  // both the connection-level fields (label, last_error) and any per-wallet
  // metadata (currency, label) on each connection's source_wallets.
  const refreshList = useCallback(async () => {
    if (!subaccountId || !isUnlocked) {
      // No subaccount yet (still provisioning or vault locked) — drop the
      // initial loading state so the empty-state card can render. Without
      // this, the page sat on "Loading…" forever for fresh accounts.
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = (await callProxy('or-connection-list', { subaccount_id: subaccountId })) as { connections: ConnectionRow[] };
      const decoded = await Promise.all((res.connections ?? []).map(async (c): Promise<ConnectionRow> => {
        let decrypted_label: string | null = null;
        let decrypted_last_error: string | null = null;
        if (c.encrypted_label) {
          try { decrypted_label = await decryptOrCipher(c.encrypted_label); } catch { /* cosmetic */ }
        }
        if (c.encrypted_last_error) {
          try { decrypted_last_error = await decryptOrCipher(c.encrypted_last_error); } catch { /* may fail */ }
        }

        const decrypted_source_wallets: DecryptedSourceWallet[] = await Promise.all(
          (c.source_wallets ?? []).map(async (sw): Promise<DecryptedSourceWallet> => {
            let currency = '';
            let label: string | null = null;
            try {
              const json = await decryptOrCipher(sw.encrypted_metadata);
              const parsed = JSON.parse(json) as { currency?: string; label?: string };
              currency = parsed.currency ?? '';
              label = parsed.label ?? null;
            } catch {
              /* If decrypt fails (e.g. metadata written under a previous key),
               * fall back to displaying just the opaque id. */
            }
            return {
              id: sw.id,
              external_wallet_id: sw.external_wallet_id,
              is_synced: sw.is_synced,
              currency,
              label,
            };
          }),
        );

        return { ...c, decrypted_label, decrypted_last_error, decrypted_source_wallets };
      }));
      setConnections(decoded);
    } catch (err) {
      console.error('[Connections] list failed', err);
      toast.error(`Failed to load connections: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [subaccountId, isUnlocked, decryptOrCipher]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // Realtime: when the or-webhook-receiver records a sync.completed event for
  // this org, the Connections page should update without a manual refresh.
  // Subscribes to sync_events filtered to the current org. RLS on sync_events
  // limits the stream to rows the user can see, so this is safe even if a
  // filter is bypassed.
  useEffect(() => {
    if (!orgId) return;
    const channel = supabase
      .channel(`sync-events-${orgId}`)
      .on(
        'postgres_changes' as never,
        { event: 'INSERT', schema: 'public', table: 'sync_events', filter: `org_id=eq.${orgId}` },
        (payload: { new: { synced_count?: number | null; or_connection_id?: string | null; status?: string | null } }) => {
          const n = payload.new?.synced_count ?? 0;
          // Branch by status so failed / deleted events surface as warnings
          // rather than silent successes. Status was added in the
          // sync_events_status migration; older rows have no value and are
          // treated as completed (matches the DB default).
          switch (payload.new?.status ?? 'completed') {
            case 'failed':
              toast.error('Orange Rails reported a sync failure — open the connection for details.');
              break;
            case 'deleted':
              toast.info('A connection was removed on the Orange Rails side.');
              break;
            default:
              toast.success(n > 0 ? `Imported ${n} new transactions` : 'Sync completed');
          }
          void refreshList();
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [orgId, refreshList]);

  // Phase 3: load destination mappings + a wallets name lookup alongside the
  // connection list. Both feed the badges + the routing resolution used by
  // TransactionList. NOTE: `accountLookup` historically pointed at
  // chart_of_accounts; the bug fix routes destinations to the `wallets` table
  // instead. We keep the variable name for minimal blast radius — it now
  // holds wallets.id → wallet name.
  const refreshMappingsAndAccounts = useCallback(async () => {
    if (!orgId || !isUnlocked) return;
    try {
      const decryptedMappings = await fetchAndDecryptMappings(orgId, decryptText);
      setMappings(decryptedMappings);
    } catch (err) {
      console.error('[Connections] mappings load failed', err);
    }

    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('org_id', orgId);
      if (error) throw error;
      const byId = new Map<string, string>();
      const walletsById = new Map<string, DestinationWallet>();
      await Promise.all(
        ((data as any[]) ?? []).map(async (row) => {
          try {
            const fields = await decryptWallet(row, decryptText);
            const id = row.id as string;
            const name = fields.encrypted_name | '[Encrypted]';
            byId.set(id, name);
            walletsById.set(id, {
              id,
              name,
              asset: fields.asset,
            });
          } catch {
            /* non-fatal — name will render as "(unrouted)" placeholder. Most
             * commonly seen for orphaned mapping rows from the broken Phase 3
             * attempt that pointed at chart_of_accounts.id values. The user
             * fixes by re-running the picker via "Edit mapping" /
             * "Configure wallets". */
          }
        }),
      );
      setAccountLookup({ byId, walletsById });
    } catch (err) {
      console.error('[Connections] wallets load failed', err);
    }

    // Primary currency for the bridge's dual-currency JE composition. Default
    // to USD if org_settings is missing or undecryptable — the bridge falls
    // back to "rate pending" lines automatically.
    try {
      const { data: sData } = await supabase
        .from('org_settings')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();
      if (sData) {
        const dec = await decryptOrgSettings(sData as any, decryptText);
        if (dec.primary_currency) setPrimaryCurrency(dec.primary_currency.toUpperCase());
      }
    } catch (err) {
      console.warn('[Connections] org_settings load failed (using default primary_currency):', err);
    }
  }, [orgId, isUnlocked, decryptText]);

  useEffect(() => { void refreshMappingsAndAccounts(); }, [refreshMappingsAndAccounts]);

  /**
   * Memoized routing index: (or_connection_id::or_external_wallet_id) →
   * external_account_id[]. Recomputed whenever mappings change.
   */
  const mappingIndex = useMemo(() => buildMappingIndex(mappings), [mappings]);

  /**
   * For a given connection, build a per-currency list of routed account
   * names. Used by ConnectionCard to render destination chips.
   */
  function buildDestChips(conn: ConnectionRow): Array<{ currency: string; accountName: string | null }> {
    const wallets = conn.decrypted_source_wallets ?? [];
    if (wallets.length === 0) return [];
    return wallets
      .filter((w) => w.is_synced)
      .map((w) => {
        const accountIds = lookupRouting(mappingIndex, conn.id, w.external_wallet_id);
        // 1:1 default — if multiple mappings exist, render the first; the
        // user can review the full set in the Edit Mapping dialog.
        const firstId = accountIds[0];
        const accountName = firstId ? accountLookup.byId.get(firstId) ?? null : null;
        return { currency: w.currency | w.label | '?', accountName };
      });
  }

  /**
   * Per-row routing resolver used by TransactionList. Looks up an OR
   * source_wallet_id against the active mapping index and returns the
   * destination account name (or null when unrouted).
   */
  function makeResolveRouting(connectionId: string) {
    return (sourceWalletId: string | null | undefined): string | null => {
      if (!sourceWalletId) return null;
      const ids = lookupRouting(mappingIndex, connectionId, sourceWalletId);
      const first = ids[0];
      if (!first) return null;
      return accountLookup.byId.get(first) ?? null;
    };
  }

  async function handleAddConnection(params: { provider: string; label: string; apiKey: string }) {
    if (!subaccountId) throw new Error('Subaccount not ready yet');
    const labelPlaintext = params.label | params.provider;
    const encrypted_label = await encryptOrCipher(labelPlaintext);
    const encrypted_credentials = await encryptOrCipher(JSON.stringify({ api_key: params.apiKey }));

    const created = (await callProxy('or-connection-create', {
      subaccount_id: subaccountId,
      provider_type: params.provider,
      encrypted_label,
      encrypted_credentials,
    })) as { connection_id?: string };
    toast.success('Connection added — your API key is encrypted and stored only as ciphertext.');
    await refreshList();

    // Phase 3 — discover wallets so the user can pick which to sync. Discovery
    // failure is non-fatal: the connection still works in legacy account-wide
    // mode, we just surface a warning toast.
    const newConnectionId = created?.connection_id;
    if (!newConnectionId) {
      toast.warning('Connection saved but discovery skipped — wallet picker unavailable.');
      return;
    }

    // Mark this connection as incomplete-setup until the user finishes the
    // picker flow. Cleared in handleSaveWalletPicks once we successfully
    // call or-source-wallets-set.
    setIncompleteConnIds((prev) => {
      const next = new Set(prev);
      next.add(newConnectionId);
      writeIncompleteSet(orgId, next);
      return next;
    });

    try {
      const credentials_key = await exportOrCredsKey();
      const disc = (await callProxy('or-discover-wallets', {
        subaccount_id: subaccountId,
        connection_id: newConnectionId,
        credentials_key,
      })) as { discovered_wallets?: DiscoveredWallet[] };

      const providerName = PROVIDERS.find((p) => p.type === params.provider)?.name ?? params.provider;
      setWalletPicker({
        connectionId: newConnectionId,
        providerType: params.provider,
        providerName,
        discovered: disc.discovered_wallets ?? [],
      });
    } catch (err) {
      console.warn('[Connections] discovery failed', err);
      toast.warning(
        'Connection saved. Wallet discovery failed — sync will pull all account transactions until you retry.',
      );
    }
  }

  /**
   * Phase 3 — encrypt each picked wallet's metadata with ORK in the browser,
   * then send the selection to or-source-wallets-set. On success, refresh and
   * advance to the destination-account picker.
   */
  async function handleSaveWalletPicks(selections: Array<DiscoveredWallet & { is_synced: boolean }>) {
    if (!walletPicker || !subaccountId) return;

    const payloadWallets = await Promise.all(
      selections.map(async (sel) => {
        const metadataPlaintext = JSON.stringify({
          currency: sel.currency,
          ...(sel.label ? { label: sel.label } : {}),
        });
        const encrypted_metadata = await encryptOrCipher(metadataPlaintext);
        return {
          external_wallet_id: sel.external_wallet_id,
          encrypted_metadata,
          is_synced: sel.is_synced,
        };
      }),
    );

    await callProxy('or-source-wallets-set', {
      subaccount_id: subaccountId,
      connection_id: walletPicker.connectionId,
      source_wallets: payloadWallets,
    });

    // Clear incomplete-setup tracking — user finished the picker step.
    setIncompleteConnIds((prev) => {
      if (!prev.has(walletPicker.connectionId)) return prev;
      const next = new Set(prev);
      next.delete(walletPicker.connectionId);
      writeIncompleteSet(orgId, next);
      return next;
    });

    const syncedSelections = selections.filter((s) => s.is_synced);
    toast.success(
      syncedSelections.length === 0
        ? 'Wallet selection saved — sync paused until you re-open the picker.'
        : `Wallet selection saved (${syncedSelections.length} active).`,
    );

    const connectionId = walletPicker.connectionId;
    setWalletPicker(null);
    await refreshList();

    if (syncedSelections.length === 0) return;

    // Step B — open the destination-account picker for the just-selected wallets.
    setDestPicker({
      connectionId,
      sourceWallets: syncedSelections.map((s) => ({
        external_wallet_id: s.external_wallet_id,
        currency: s.currency,
        label: s.label ?? null,
        initialAccountId: null,
      })),
    });
  }

  function handleSkipWalletPicks() {
    setWalletPicker(null);
    toast.info('No wallets configured — sync will pull all account transactions until you retry.');
  }

  /**
   * Phase 3 — persist destination mappings to connection_account_map.
   * encrypted_account_id is AES-256-GCM (vault MEK) over the chart_of_accounts.id.
   */
  async function handleSaveDestinations(mappingsToSave: Array<{ or_external_wallet_id: string; external_account_id: string }>) {
    if (!destPicker || !orgId) return;
    await saveMappingsForConnection({
      orgId,
      orConnectionId: destPicker.connectionId,
      desired: mappingsToSave,
      encryptText,
    });
    setDestPicker(null);
    toast.success('Destination mapping saved — synced transactions will route here.');
    await refreshMappingsAndAccounts();
  }

  function handleSkipDestinations() {
    setDestPicker(null);
    toast.info('Destination mapping skipped — synced transactions will show as unrouted until you set it.');
  }

  /** Re-open the destination picker for an existing connection. */
  function handleEditMapping(conn: ConnectionRow) {
    const synced = (conn.decrypted_source_wallets ?? []).filter((w) => w.is_synced);
    if (synced.length === 0) {
      // No source_wallets configured — fall through to the discovery-based
      // resume flow. This typically means the user closed the picker before
      // finishing setup (intentionally or accidentally).
      void handleConfigureWallets(conn);
      return;
    }
    const sourceWallets: SourceWalletPick[] = synced.map((w) => {
      const existingIds = lookupRouting(mappingIndex, conn.id, w.external_wallet_id);
      return {
        external_wallet_id: w.external_wallet_id,
        currency: w.currency | w.label | '?',
        label: w.label,
        initialAccountId: existingIds[0] ?? null,
      };
    });
    setDestPicker({ connectionId: conn.id, sourceWallets });
  }

  /**
   * Resume the discovery → picker flow for a connection that has no
   * source_wallets configured. Surfaces "Configure wallets" on the card so
   * the user isn't stuck with a half-set-up connection (Bug #3).
   */
  async function handleConfigureWallets(conn: ConnectionRow) {
    if (!subaccountId) {
      toast.error('OrangeRails not ready yet — try again in a moment.');
      return;
    }
    try {
      const credentials_key = await exportOrCredsKey();
      const disc = (await callProxy('or-discover-wallets', {
        subaccount_id: subaccountId,
        connection_id: conn.id,
        credentials_key,
      })) as { discovered_wallets?: DiscoveredWallet[] };

      const providerName = PROVIDERS.find((p) => p.type === conn.provider_type)?.name ?? conn.provider_type;
      setWalletPicker({
        connectionId: conn.id,
        providerType: conn.provider_type,
        providerName,
        discovered: disc.discovered_wallets ?? [],
      });
    } catch (err) {
      console.warn('[Connections] re-discover failed', err);
      toast.error(
        `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleSync(conn: ConnectionRow) {
    if (!subaccountId) return;
    setSyncingId(conn.id);
    try {
      const credentials_key = await exportOrCredsKey();
      const transactions_key = await exportOrTxnsKey();
      const res = (await callProxy('or-sync', {
        subaccount_id: subaccountId,
        connection_ids: [conn.id],
        credentials_key,
        transactions_key,
      })) as { synced: number; connections: Array<{ connection_id: string; synced: number; error?: string }> };

      const errs = res.connections.filter(c => c.error);
      if (errs.length > 0) {
        toast.warning(`Synced ${res.synced}; ${errs.length} connection(s) had errors.`);
      } else if (res.synced === 0) {
        toast.info('No new transactions found.');
      } else {
        toast.success(`Synced ${res.synced} transaction${res.synced === 1 ? '' : 's'} from ${conn.decrypted_label || conn.provider_type}`);
      }
      // Auto-expand the just-synced connection and trigger a tx refresh.
      setExpanded(prev => ({ ...prev, [conn.id]: true }));
      setTxRefreshKeys(prev => ({ ...prev, [conn.id]: (prev[conn.id] ?? 0) + 1 }));
      await refreshList();

      // Phase 5 — bridge OR-side rows into the OWB wallet ledger + JE pair.
      // We always run the bridge (even if `synced === 0`) because the user may
      // have just configured a destination mapping AFTER previously syncing,
      // in which case earlier-fetched rows still need to be imported. The
      // bridge is idempotent so re-running on already-imported rows is cheap.
      if (orgId) {
        await bridgeConnection(conn);
      }
    } catch (err) {
      console.error('[Connections] sync failed', err);
      toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingId(null);
    }
  }

  /**
   * Phase 5 bridge — fetch+decrypt this connection's OR transactions, then
   * fan them out to OWB's `transactions` table and a balanced JE pair via
   * importOrTransactionsToV3.
   *
   * Errors here are non-fatal to the sync workflow: we toast a warning and
   * leave the OR-side rows in place so the user can re-run later. Detailed
   * per-tx errors are logged to the console.
   */
  async function bridgeConnection(conn: ConnectionRow): Promise<void> {
    if (!orgId || !subaccountId) return;
    setBridgingId(conn.id);
    try {
      // Re-fetch so we work from the freshest OR-side state (the sync we
      // just ran may have produced new rows that aren't in any local cache).
      //
      // Cursor: send the earliest `last_or_synced_at` across this
      // connection's mappings as `since` so OR can skip already-imported
      // transactions server-side once it accepts the parameter. Until OR
      // adopts it, the param is ignored and the response is unchanged —
      // dedup still happens client-side via the pre-batch lookup added in
      // an earlier change. The bridge writes a new cursor after a successful import
      // in a follow-up PR.
      const connectionMappings = mappings.filter((m) => m.or_connection_id === conn.id);
      const cursorCandidates = connectionMappings
        .map((m) => m.last_or_synced_at)
        .filter((v): v is string => typeof v === 'string');
      const since = cursorCandidates.length > 0
        ? cursorCandidates.reduce((a, b) => (a < b ? a : b))
        : undefined;

      const txRes = (await callProxy('or-transactions-list', {
        subaccount_id: subaccountId,
        connection_id: conn.id,
        limit: 200,
        ...(since ? { since } : {}),
      })) as { transactions: Array<{
        id: string;
        connection_id: string;
        external_id: string;
        encrypted_payload: string;
        occurred_at: string;
      }> };

      const rows = (txRes.transactions ?? []).filter(t => t.connection_id === conn.id);
      if (rows.length === 0) return;

      const decrypted: DecryptedOrTx[] = [];
      for (const r of rows) {
        try {
          const json = await decryptOrTxnCipher(r.encrypted_payload);
          const payload = JSON.parse(json) as DecryptedOrTx;
          decrypted.push(payload);
        } catch (err) {
          console.warn('[Connections] bridge: failed to decrypt OR tx', r.id, err);
        }
      }
      if (decrypted.length === 0) return;

      const result = await importOrTransactionsToV3({
        orgId,
        orConnectionId: conn.id,
        orTxs: decrypted,
        mappings,
        walletsById: accountLookup.walletsById,
        primaryCurrency,
        encryptText,
        decryptText,
      });

      if (result.imported > 0) {
        toast.success(
          `Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'} into your wallet ledger.`,
        );
      } else if (result.unrouted > 0 && result.duplicates === 0) {
        toast.info(
          `${result.unrouted} OR transaction${result.unrouted === 1 ? '' : 's'} await mapping — open Edit mapping to route them.`,
        );
      } else if (result.errors.length > 0) {
        toast.warning(
          `Bridge completed with ${result.errors.length} error${result.errors.length === 1 ? '' : 's'} — see console.`,
        );
      }
      if (result.errors.length > 0) {
        console.warn('[Connections] bridge errors:', result.errors);
      }
      // Bump the txRefreshKey so TransactionList re-renders + re-checks the
      // "in ledger" badge state for these rows.
      setTxRefreshKeys(prev => ({ ...prev, [conn.id]: (prev[conn.id] ?? 0) + 1 }));
    } catch (err) {
      console.error('[Connections] bridge failed', err);
      toast.warning(`Could not import to ledger: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBridgingId(null);
    }
  }

  /**
   * Delete request — shows the branded confirmation dialog. Actual delete
   * runs via confirmDelete() once the user clicks the destructive action.
   */
  function handleDelete(conn: ConnectionRow) {
    setDeleteTarget(conn);
  }

  async function confirmDelete() {
    const conn = deleteTarget;
    if (!conn || !subaccountId) return;
    try {
      await callProxy('or-connection-delete', { subaccount_id: subaccountId, connection_id: conn.id });
      toast.success('Connection deleted');
      // Clean up incomplete tracking for the deleted connection.
      setIncompleteConnIds((prev) => {
        if (!prev.has(conn.id)) return prev;
        const next = new Set(prev);
        next.delete(conn.id);
        writeIncompleteSet(orgId, next);
        return next;
      });
      await refreshList();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────

  if (!isUnlocked) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-sm text-muted-foreground">Unlock your vault to manage connections.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Connections</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sync your Bitcoin accounts via OrangeRails — wallets, exchanges, payment processors, mining pools.
            Zero-knowledge: your credentials are never readable by anyone but you.
          </p>
        </div>
        {subaccountId && canWriteConnectors && (
          <Button onClick={() => setAddOpen(true)} data-testid="connections-add">+ Add connection</Button>
        )}
      </div>

      {provisioning && (
        <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          Setting up OrangeRails for this org…
        </div>
      )}

      {loading && connections.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : connections.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center space-y-2">
          <Zap className="w-8 h-8 mx-auto text-orange-500" />
          <p className="text-sm font-medium">No connections yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Add a Bitcoin account to start syncing transactions automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map(c => {
            const noSourceWallets = (c.decrypted_source_wallets ?? []).length === 0;
            const setupIncomplete = noSourceWallets && incompleteConnIds.has(c.id);
            return (
              <ConnectionCard
                key={c.id}
                conn={c}
                canWrite={canWriteConnectors}
                syncing={syncingId === c.id}
                bridging={bridgingId === c.id}
                expanded={!!expanded[c.id]}
                onToggleExpand={() => setExpanded(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                onSync={() => handleSync(c)}
                onDelete={() => handleDelete(c)}
                onEditMapping={() => handleEditMapping(c)}
                onConfigureWallets={() => void handleConfigureWallets(c)}
                noSourceWallets={noSourceWallets}
                setupIncomplete={setupIncomplete}
                destChips={buildDestChips(c)}
                resolveRouting={makeResolveRouting(c.id)}
                resolveDestinationWalletId={(extWalletId) => {
                  const ids = lookupRouting(mappingIndex, c.id, extWalletId);
                  return ids[0] ?? null;
                }}
                fetchTransactions={async () => {
                  if (!subaccountId) return [];
                  const res = (await callProxy('or-transactions-list', {
                    subaccount_id: subaccountId,
                    connection_id: c.id,
                    limit: 50,
                  })) as { transactions: Array<{
                    id: string;
                    connection_id: string;
                    external_id: string;
                    encrypted_payload: string;
                    occurred_at: string;
                  }> };
                  // OR returns transactions across the subaccount when no
                  // server-side connection_id filter is honored — filter client-side
                  // to be safe so each card only shows its own rows.
                  return (res.transactions ?? []).filter(t => t.connection_id === c.id);
                }}
                decryptTxn={decryptOrTxnCipher}
                txRefreshKey={txRefreshKeys[c.id] ?? 0}
              />
            );
          })}
        </div>
      )}

      <div className="rounded-md border p-4 text-xs text-muted-foreground space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="w-3 h-3 shrink-0" />
          <span>Your vault password derives the encryption keys in your browser — never sent anywhere.</span>
        </div>
        <div className="flex items-center gap-2">
          <KeyRound className="w-3 h-3 shrink-0" />
          <span>OrangeRails stores ciphertext only and cannot decrypt your data.</span>
        </div>
      </div>

      {addOpen && (
        <AddConnectionDialog
          onClose={() => setAddOpen(false)}
          onSubmit={async (p) => {
            await handleAddConnection(p);
            setAddOpen(false);
          }}
        />
      )}

      {walletPicker && (
        <WalletPickerStep
          open
          discoveredWallets={walletPicker.discovered}
          providerName={walletPicker.providerName}
          onSkip={handleSkipWalletPicks}
          onConfirm={handleSaveWalletPicks}
        />
      )}

      {destPicker && orgId && (
        <DestinationAccountPicker
          open
          orgId={orgId}
          sourceWallets={destPicker.sourceWallets}
          onCancel={handleSkipDestinations}
          onConfirm={handleSaveDestinations}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title="Delete connection?"
        description={
          <>
            Delete the{' '}
            <span className="font-medium text-foreground">
              {deleteTarget?.decrypted_label | deleteTarget?.provider_type}
            </span>{' '}
            connection? Synced transactions for this connection will also be removed. This
            cannot be undone.
          </>
        }
        cancelLabel="Cancel"
        confirmLabel="Delete connection"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function ConnectionCard({
  conn,
  syncing,
  bridging,
  expanded,
  onToggleExpand,
  onSync,
  onDelete,
  onEditMapping,
  onConfigureWallets,
  noSourceWallets,
  setupIncomplete,
  destChips,
  resolveRouting,
  resolveDestinationWalletId,
  fetchTransactions,
  decryptTxn,
  txRefreshKey,
  canWrite,
}: {
  conn: ConnectionRow;
  /** UI capability gate for connectors.write — hides edit/delete/configure
   *  buttons when the calling user lacks the cap. RLS is still authoritative. */
  canWrite: boolean;
  syncing: boolean;
  /** True while the OR→OWB bridge is running for this connection. */
  bridging: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSync: () => void;
  onDelete: () => void;
  onEditMapping: () => void;
  onConfigureWallets: () => void;
  noSourceWallets: boolean;
  setupIncomplete: boolean;
  destChips: Array<{ currency: string; accountName: string | null }>;
  resolveRouting: (sourceWalletId: string | null | undefined) => string | null;
  /**
   * Resolve a source_wallet_id to its destination OWB wallets.id (or null if
   * unrouted). TransactionList uses this to scope its "in ledger" badge
   * lookup — it queries transactions filtered to the destination wallet ids
   * that this connection's mappings point at.
   */
  resolveDestinationWalletId: (sourceWalletId: string | null | undefined) => string | null;
  fetchTransactions: () => Promise<Array<{
    id: string;
    connection_id: string;
    external_id: string;
    encrypted_payload: string;
    occurred_at: string;
  }>>;
  decryptTxn: (ciphertext: string) => Promise<string>;
  txRefreshKey: number;
}) {
  const statusColor = conn.status === 'active'
    ? 'border-green-500/40 text-green-700 dark:text-green-400'
    : conn.status === 'error'
      ? 'border-destructive/40 text-destructive'
      : 'border-muted text-muted-foreground';

  const sourceWallets = conn.decrypted_source_wallets ?? [];
  const hasSourceWallets = sourceWallets.length > 0;

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{conn.decrypted_label || conn.provider_type}</span>
            <Badge variant="outline" className={`text-xs ${statusColor}`}>{conn.status}</Badge>
            {setupIncomplete && (
              <Badge
                variant="outline"
                className="text-xs border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                title="The wallet picker was opened but never completed for this connection."
              >
                Setup incomplete
              </Badge>
            )}
            {bridging && (
              <Badge
                variant="outline"
                className="text-xs border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-400 inline-flex items-center gap-1"
                title="Importing OR transactions into your wallet ledger and journal entries."
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                Importing to ledger…
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="uppercase">{conn.provider_type}</span>
            <span className="mx-2">·</span>
            <span>{conn.last_sync_at ? `Synced ${timeAgo(conn.last_sync_at)}` : 'Never synced'}</span>
          </div>
          <SourceWalletBadges wallets={sourceWallets} />
          {destChips.length > 0 && (
            <DestinationAccountChips entries={destChips} />
          )}
          {conn.decrypted_last_error && (
            <div className="text-xs text-destructive truncate flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{conn.decrypted_last_error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasSourceWallets && canWrite && (
            <Button onClick={onEditMapping} variant="ghost" size="sm" title="Edit destination mapping" data-testid="connections-edit-mapping">
              <Pencil className="w-3 h-3 mr-1" />
              Edit mapping
            </Button>
          )}
          {/* Bug #3 — Resume partial setup: any connection with no
              source_wallets gets an explicit "Configure wallets" entry point.
              Setup-incomplete (localStorage-tracked) connections get a
              continue-style label; legacy / never-configured ones get the
              opt-in label so users can move them onto the new picker flow. */}
          {noSourceWallets && canWrite && (
            <Button
              onClick={onConfigureWallets}
              variant={setupIncomplete ? 'default' : 'outline'}
              size="sm"
              title={
                setupIncomplete
                  ? 'Resume the wallet setup that was interrupted'
                  : 'Pick which wallets to sync and where they land'
              }
            >
              <Settings className="w-3 h-3 mr-1" />
              {setupIncomplete ? 'Continue setup' : 'Configure wallets'}
            </Button>
          )}
          <Button onClick={onToggleExpand} variant="ghost" size="sm">
            {expanded ? (
              <><ChevronDown className="w-3 h-3 mr-1" />Hide transactions</>
            ) : (
              <><ChevronRight className="w-3 h-3 mr-1" />View transactions</>
            )}
          </Button>
          {canWrite && (
            <Button onClick={onSync} disabled={syncing} variant="outline" size="sm" data-testid="connections-sync">
              {syncing ? (<><Loader2 className="w-3 h-3 mr-1 animate-spin" />Syncing…</>) : 'Sync now'}
            </Button>
          )}
          {canWrite && (
            <Button onClick={onDelete} variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" data-testid="connections-delete">
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="pt-2 border-t">
          <TransactionList
            fetchEncrypted={fetchTransactions}
            decrypt={decryptTxn}
            refreshKey={txRefreshKey}
            resolveRouting={resolveRouting}
            orConnectionId={conn.id}
            resolveDestinationWalletId={resolveDestinationWalletId}
          />
        </div>
      )}
    </div>
  );
}

function AddConnectionDialog({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (p: { provider: string; label: string; apiKey: string }) => Promise<void>;
}) {
  const [provider, setProvider] = useState<string>(PROVIDERS[0].type);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const meta = PROVIDERS.find(p => p.type === provider)!;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({ provider, label: label.trim(), apiKey: apiKey.trim() });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => { /* close only via explicit Cancel — protect partially-typed credentials */ }}>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Add a connection</DialogTitle>
          <DialogDescription>
            Your API key is encrypted in your browser before it leaves. OrangeRails stores ciphertext only.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="provider">Provider</Label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {PROVIDERS.map(p => (
                <option key={p.type} value={p.type}>{p.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{meta.description}</p>
          </div>

          <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
                How to get your {meta.name} API key
              </span>
              <a href={meta.apiKeyUrl} target="_blank" rel="noopener noreferrer"
                 className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1">
                Open <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
              {meta.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="label">Label (optional)</Label>
            <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`My ${meta.name} account`} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="api-key">API key</Label>
            <Input id="api-key" type="password" autoComplete="off" required
                   value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                   placeholder="Paste the key you just copied"
                   className="font-mono text-sm" />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting || !apiKey.trim()}>
              {submitting ? 'Encrypting + saving…' : 'Add connection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
