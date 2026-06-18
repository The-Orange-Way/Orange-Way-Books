/**
 * UI capability gates — Phase 4.x UX polish.
 *
 * Server-side RLS (user_has_capability) is the authoritative enforcement
 * mechanism for the OWB permissions model. These tests prove that the
 * matching UI buttons disappear when the calling user lacks the capability,
 * so a Viewer/Auditor/PaymentsApprover never sees a control that would
 * 403 on click.
 *
 * Each test mounts a real page component but mocks:
 *   - useCapability — to simulate a specific role's capability set
 *   - useUserOrg    — to supply an orgId
 *   - useVault      — stable stub (stable-stub pattern)
 *   - supabase      — minimal builder that returns empty result sets
 *
 * The page is allowed to render its empty / loading / error states; what we
 * assert is presence/absence of the write controls keyed by data-testid.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Capability fixture: the 9 system presets from D7 ──────────────────────
// Mirrors src/hooks/__tests__/capability-rls.test.ts. Kept in-file (not
// imported) so a future drift on the source-of-truth test surfaces here too.
const ALL_CAPS = [
  'transactions.read', 'transactions.write', 'transactions.write_own', 'transactions.delete',
  'journal_entries.read', 'journal_entries.write', 'journal_entries.delete',
  'accounts.read', 'accounts.write', 'accounts.delete',
  'payments.read', 'payments.create', 'payments.approve', 'payments.pay',
  'contacts.read', 'contacts.write', 'contacts.delete',
  'reports.read', 'reports.read_summary',
  'periods.close', 'periods.unlock',
  'users.invite', 'users.revoke', 'users.manage_roles',
  'roles.manage',
  'connectors.read', 'connectors.write',
  'org.manage',
  'audit.read',
  'support.session_open', 'support.scope_read',
] as const;
type Cap = (typeof ALL_CAPS)[number];

const PRESETS: Record<string, Cap[]> = {
  Owner: [...ALL_CAPS],
  Viewer: ['reports.read_summary'],
  Auditor: [
    'transactions.read', 'journal_entries.read', 'accounts.read', 'payments.read',
    'contacts.read', 'reports.read', 'reports.read_summary', 'connectors.read', 'audit.read',
  ],
  PaymentsApprover: ['transactions.read', 'payments.read', 'payments.approve', 'reports.read'],
  PaymentsPayer: ['transactions.read', 'payments.read', 'payments.pay', 'reports.read'],
  CustomNoContactsWrite: [
    'transactions.read', 'contacts.read', // contacts.write absent
  ],
};

// Hoisted holder so the vi.mock factory can pick up the active role per test.
// Initialised empty here; beforeEach sets it to Owner.
const { __activeCaps } = vi.hoisted(() => ({
  __activeCaps: { current: new Set<string>() },
}));

function setRole(role: keyof typeof PRESETS) {
  __activeCaps.current = new Set(PRESETS[role]);
}

// ── Mocks shared by every page mount ──────────────────────────────────────

vi.mock('@/hooks/useCapability', () => ({
  useCapability: (key: string) => __activeCaps.current.has(key),
  // Other exports the pages may pull from this module — not used in these
  // tests but exported to satisfy the module shape.
  useCurrentUserRoles: () => ({ roles: [], capabilities: __activeCaps.current, loading: false, error: null }),
  useRoles: () => ({ roles: [], loading: false, error: null, refresh: () => {} }),
  useRoleCapabilities: () => ({ keys: new Set(), loading: false, error: null, refresh: () => {} }),
  useAllCapabilities: () => ({ capabilities: [], byFeature: new Map(), loading: false, error: null }),
  useHasAdvancedTier: () => true,
  aggregateActiveGrants: () => ({ roles: [], capabilities: new Set() }),
}));

vi.mock('@/hooks/useUserOrg', () => ({
  useUserOrg: () => ({ orgId: 'org-1', loading: false, allOrgs: [], switchOrg: () => {} }),
}));

const __vaultStable = {
  isUnlocked: true,
  encryptText: async (s: string) => `enc(${s})`,
  decryptText: async (s: string) => s.replace(/^enc\(|\)$/g, ''),
  encryptBlob: async (b: unknown) => b,
  decryptBlob: async (b: unknown) => b,
  encryptOrCipher: async (s: string) => s,
  decryptOrCipher: async (s: string) => s,
  decryptOrTxnCipher: async (s: string) => s,
  exportOrCredsKey: async () => 'key',
  exportOrTxnsKey: async () => 'key',
  loadOrgSigningKey: async () => null,
  signMutation: async () => 'sig',
};
vi.mock('@/context/VaultContext', () => ({
  useVault: () => __vaultStable,
}));

vi.mock('@/hooks/useOrgSettings', () => ({
  useFormatCurrency: () => ({
    formatAmount: (n: number, c: string) => `${c} ${n.toFixed(2)}`,
    settings: { primary_currency: 'USD' },
  }),
  useOrgSettings: () => ({
    settings: { primary_currency: 'USD', secondary_currency: 'BTC', bitcoin_display: 'sats' },
    loading: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Minimal supabase builder — every query returns an empty list. The pages
// just need to render their empty states; we're checking button presence.
vi.mock('@/lib/supabase', () => {
  const makeChain = (data: unknown = []) => {
    const result = { data, error: null };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      or: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      gte: () => chain,
      lte: () => chain,
      neq: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve(result),
      then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const insert = vi.fn(() => makeChain(null));
  const update = vi.fn(() => makeChain(null));
  const del = vi.fn(() => makeChain(null));
  return {
    SUPABASE_URL: 'http://stub',
    SUPABASE_PUBLISHABLE_KEY: 'stub',
    supabase: {
      from: vi.fn(() => ({ ...makeChain([]), insert, update, delete: del })),
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
      rpc: vi.fn(async () => ({ data: null, error: null })),
      functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
      channel: vi.fn(() => ({ on: function () { return this; }, subscribe: () => ({}) })),
      removeChannel: vi.fn(),
    },
  };
});

// Pages pull these helpers; stub them to no-ops so render doesn't crash.
vi.mock('@/lib/crypto-fields', () => ({
  encryptTransaction: vi.fn(async (f: any) => f),
  decryptTransaction: vi.fn(async (r: any) => r),
  decryptWallet: vi.fn(async (r: any) => r),
  decryptChartOfAccount: vi.fn(async (r: any) => r),
  encryptChartOfAccount: vi.fn(async (f: any) => f),
  decryptOrgSettings: vi.fn(async (r: any) => r),
  decryptOrganization: vi.fn(async (r: any) => r),
  encryptContact: vi.fn(async (f: any) => f),
  decryptContact: vi.fn(async (r: any) => r),
  encryptJournalEntry: vi.fn(async (f: any) => f),
  decryptJournalEntry: vi.fn(async (r: any) => r),
  encryptJournalEntryLine: vi.fn(async (f: any) => f),
  decryptJournalEntryLine: vi.fn(async (r: any) => r),
  encryptPaymentRequest: vi.fn(async (f: any) => f),
  decryptPaymentRequest: vi.fn(async (r: any) => r),
}));

// Import after mocks so the page bindings see them.
import Transactions from '../Transactions';
import JournalEntries from '../JournalEntries';
import Payments from '../Payments';

beforeEach(() => {
  vi.clearAllMocks();
  setRole('Owner');
});

function renderPage(Component: React.ComponentType) {
  return render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

describe('UI capability gates', () => {
  // ── Owner: sees everything ──────────────────────────────────────────────

  it('Owner sees Add Transaction button on Transactions page', async () => {
    setRole('Owner');
    renderPage(Transactions);
    await waitFor(() => {
      expect(screen.queryByTestId('tx-new-button')).toBeInTheDocument();
    });
  });

  // ── Viewer: sees zero write controls on Transactions + JE ──────────────

  it('Viewer sees no New/Delete/Edit buttons on Transactions page', async () => {
    setRole('Viewer');
    renderPage(Transactions);
    // Page should mount (it'll show the loading/empty body); we wait briefly
    // for the post-load render cycle and then assert no write controls.
    await waitFor(() => {
      // The page header is the stable anchor.
      expect(screen.getByPlaceholderText(/search transactions/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tx-new-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-delete-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-edit-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-bulk-delete')).not.toBeInTheDocument();
  });

  it('Viewer sees no New/Delete buttons on Journal Entries page', async () => {
    setRole('Viewer');
    renderPage(JournalEntries);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search journal entries/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('je-new-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('je-delete-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('je-bulk-delete')).not.toBeInTheDocument();
  });

  // ── Auditor: read-only on every page ────────────────────────────────────

  it('Auditor sees no write actions on Transactions page', async () => {
    setRole('Auditor');
    renderPage(Transactions);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search transactions/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tx-new-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-delete-button')).not.toBeInTheDocument();
  });

  // ── PaymentsApprover: only Approver tab; no Payer/Create ────────────────

  it('PaymentsApprover sees Approver view but not Payer/Create', async () => {
    setRole('PaymentsApprover');
    renderPage(Payments);
    await waitFor(() => {
      // Page should render some Payments content (header).
      expect(screen.getByRole('heading', { name: /payments/i })).toBeInTheDocument();
    });
    // Create-request button is hidden.
    expect(screen.queryByTestId('payments-new-request')).not.toBeInTheDocument();
    // Payer tile is hidden — there should only be the Approver tile and only
    // one role in the available list, so the whole switcher collapses.
    expect(screen.queryByTestId('payments-view-as-payer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payments-view-as-requester')).not.toBeInTheDocument();
  });

  // ── No payment access at all: empty state ───────────────────────────────

  it('A role with no payment capabilities sees the empty state, not the page', async () => {
    setRole('Viewer'); // Viewer has zero payments.* caps
    renderPage(Payments);
    await waitFor(() => {
      expect(screen.getByTestId('payments-no-access')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('payments-new-request')).not.toBeInTheDocument();
  });

  // ── Custom role missing contacts.write ──────────────────────────────────

  it('Custom role missing transactions.write sees no Add Transaction button', async () => {
    setRole('CustomNoContactsWrite'); // also lacks transactions.write/write_own
    renderPage(Transactions);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search transactions/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tx-new-button')).not.toBeInTheDocument();
  });
});
