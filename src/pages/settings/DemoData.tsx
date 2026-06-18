import { useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { encryptContact, encryptWallet } from '@/lib/crypto-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';

// Plausible-looking demo data for sales walkthroughs, training, and Playwright
// fixtures. Deliberately small + deterministic so the resulting org loads fast.
// Bookkeeping data (transactions, journal entries) is NOT seeded here — that
// requires balanced double-entry inserts under the active vault, tracked
// separately. Contacts + wallets are enough to demo the directory + dropdowns.
const SAMPLE_CONTACTS = [
  { name: 'Acme Industrial Supply', email: 'billing@acme-industrial.example', phone: '555-0101', city: 'Calgary',  country: 'CA', type: 'VENDOR' },
  { name: 'North Loop Logistics',   email: 'ap@northloop.example',           phone: '555-0102', city: 'Edmonton', country: 'CA', type: 'VENDOR' },
  { name: 'Cohort Coffee Co.',      email: 'orders@cohortcoffee.example',    phone: '555-0103', city: 'Vancouver',country: 'CA', type: 'CUSTOMER' },
  { name: 'Harbor & Vine',          email: 'hello@harborandvine.example',    phone: '555-0104', city: 'Halifax',  country: 'CA', type: 'CUSTOMER' },
  { name: 'Granite Plumbing Ltd.',  email: 'office@granite-plumbing.example',phone: '555-0105', city: 'Winnipeg', country: 'CA', type: 'CUSTOMER' },
  { name: 'Jordan Reyes',           email: 'jordan.reyes@example.com',       phone: '555-0106', city: 'Toronto',  country: 'CA', type: 'EMPLOYEE' },
] as const;

const SAMPLE_WALLETS = [
  { name: 'Operating Checking', asset: 'USD', walletType: 'Bank',     initialBalance: 25_000 },
  { name: 'Treasury BTC',       asset: 'BTC', walletType: 'Exchange', initialBalance: 0.75 },
] as const;

// Tables emptied by the wipe. Order matters — children before parents so
// FK cascades that lean on them don't kick in unexpectedly. Anything
// unrelated to bookkeeping data (org_members, organizations, billing,
// rekey jobs) stays untouched; the user keeps their seat.
const WIPE_TABLES = [
  'journal_entry_lines',
  'journal_entries',
  'transactions',
  'payment_request_line_items',
  'payment_requests',
  'invoices',
  'wallets',
  'contacts',
  'chart_of_accounts',
  'attachments',
  'sync_events',
  'connection_account_map',
  'or_connection_state',
  'exchange_rates',
] as const;

interface RowCount {
  table: string;
  rows: number;
  error?: string;
}

export default function DemoDataPage() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText } = useVault();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [working, setWorking] = useState(false);
  const [counts, setCounts] = useState<RowCount[]>([]);
  const [countingNow, setCountingNow] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const seedSample = async () => {
    if (!orgId) return;
    setSeeding(true);
    try {
      const contacts = await Promise.all(
        SAMPLE_CONTACTS.map((c) =>
          encryptContact(
            {
              name: c.name, email: c.email, phone: c.phone, city: c.city, country: c.country,
              street: null, state: null, zip: null, type: c.type,
            },
            encryptText,
          ),
        ),
      );
      const { error: cErr } = await supabase.from('contacts').insert(
        contacts.map((enc) => ({ org_id: orgId, ...enc } as any)),
      );
      if (cErr) throw new Error(`contacts: ${cErr.message}`);

      const wallets = await Promise.all(
        SAMPLE_WALLETS.map((w) =>
          encryptWallet(
            {
              encrypted_name: w.name,
              initial_balance: w.initialBalance,
              asset: w.asset,
              account_type: w.walletType,
              connection_type: 'manual',
              external_account_code: null,
            },
            encryptText,
          ),
        ),
      );
      const { error: wErr } = await supabase.from('accounts').insert(
        wallets.map((enc) => ({ org_id: orgId, ...enc } as any)),
      );
      if (wErr) throw new Error(`wallets: ${wErr.message}`);

      toast.success(`Seeded ${SAMPLE_CONTACTS.length} contacts and ${SAMPLE_WALLETS.length} accounts.`);
      await fetchCounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Seed failed.');
    } finally {
      setSeeding(false);
    }
  };

  const fetchCounts = async () => {
    if (!orgId) return;
    setCountingNow(true);
    const next: RowCount[] = [];
    for (const t of WIPE_TABLES) {
      const { count, error } = await (supabase as any)
        .from(t)
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      if (error) {
        next.push({ table: t, rows: 0, error: error.message });
      } else {
        next.push({ table: t, rows: count ?? 0 });
      }
    }
    setCounts(next);
    setCountingNow(false);
  };

  const totalRows = counts.reduce((acc, c) => acc + c.rows, 0);
  const expectedConfirm = 'DELETE EVERYTHING';

  const runWipe = async () => {
    if (!orgId) return;
    if (confirmText !== expectedConfirm) {
      toast.error(`Type "${expectedConfirm}" to proceed.`);
      return;
    }
    setWorking(true);
    let removed = 0;
    let failed = 0;
    for (const t of WIPE_TABLES) {
      const { error } = await (supabase as any).from(t).delete().eq('org_id', orgId);
      if (error) {
        failed++;
        console.error(`[demo-wipe] ${t}:`, error.message);
      } else {
        removed++;
      }
    }
    setWorking(false);
    setConfirmOpen(false);
    setConfirmText('');
    if (failed === 0) {
      toast.success(`Wiped ${removed} tables. Refresh the app to see the empty state.`);
    } else {
      toast.error(`${removed} tables cleared, ${failed} failed — check the console for details.`);
    }
    await fetchCounts();
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Demo data</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Reset this organization's bookkeeping data so you can demo a clean state, capture
          fresh screenshots, or run a Playwright suite from scratch. The wipe leaves the
          organization, billing, and your membership intact — only the bookkeeping tables are emptied.
        </p>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900 max-w-2xl">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Destructive — the data is not recoverable from the app.</p>
            <p className="mt-1">
              Run this only on dev orgs, demo sandboxes, or accounts you explicitly want to reset.
              There is no undo from the UI.
            </p>
          </div>
        </div>
      </div>

      <section className="space-y-3 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Current row counts
          </h2>
          <Button variant="outline" size="sm" onClick={fetchCounts} disabled={countingNow || orgLoading || !orgId}>
            {countingNow ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
            {counts.length === 0 ? 'Count' : 'Refresh'}
          </Button>
        </div>
        {counts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Hit "Count" to see how many rows the wipe would delete.
          </p>
        ) : (
          <div className="bg-card border border-border rounded-lg divide-y" data-testid="demo-data-row-counts">
            {counts.map((c) => (
              <div key={c.table} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{c.table}</span>
                {c.error ? (
                  <span className="text-xs text-destructive">{c.error}</span>
                ) : (
                  <span className="font-mono tabular-nums">{c.rows.toLocaleString()}</span>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2 text-sm bg-muted/40">
              <span className="font-medium">Total</span>
              <span className="font-mono tabular-nums font-semibold">{totalRows.toLocaleString()}</span>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 max-w-2xl">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Seed sample data
        </h2>
        <p className="text-xs text-muted-foreground">
          Adds {SAMPLE_CONTACTS.length} plausible contacts (customers, vendors, employee) and
          {' '}{SAMPLE_WALLETS.length} accounts (USD operating + BTC treasury). Names are clearly
          fictional. Safe to run on top of existing data — it inserts, doesn't replace.
        </p>
        <Button
          variant="outline"
          onClick={seedSample}
          disabled={!orgId || seeding || working || orgLoading}
          data-testid="demo-data-seed-trigger"
        >
          {seeding ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Sparkles className="w-4 h-4 mr-1.5" />}
          Seed contacts and accounts
        </Button>
        <p className="text-xs text-muted-foreground">
          Demo transactions and journal entries are not yet seeded — those need balanced
          double-entry inserts encrypted under your active vault, tracked as a follow-up.
        </p>
      </section>

      <section className="space-y-3 max-w-2xl">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Wipe
        </h2>
        <Button
          variant="destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={!orgId || working || orgLoading}
          data-testid="demo-data-wipe-trigger"
        >
          Clear all bookkeeping data for this org
        </Button>
        <p className="text-xs text-muted-foreground">
          Empties {WIPE_TABLES.length} tables scoped to this org. Membership, billing rows,
          and the organization record are preserved.
        </p>
      </section>

      <Dialog open={confirmOpen} onOpenChange={(v) => { if (!working) { setConfirmOpen(v); setConfirmText(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Wipe bookkeeping data?</DialogTitle>
            <DialogDescription className="pt-2">
              This deletes every row in the {WIPE_TABLES.length} tables listed above for the
              currently selected organization. There is no undo from inside the app — only a
              database point-in-time restore could recover the data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <p className="text-sm">
              Type <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-semibold">{expectedConfirm}</code> to confirm.
            </p>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={expectedConfirm}
              autoFocus
              data-testid="demo-data-confirm-input"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={runWipe}
              disabled={confirmText !== expectedConfirm || working}
              data-testid="demo-data-confirm-button"
            >
              {working ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              Wipe org data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
