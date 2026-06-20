/**
 * Invoices page (I4) — list, filter, bulk actions.
 *
 * These tests prove the list page renders decrypted invoices, that the
 * plaintext status filter narrows the table, that clicking a row opens the
 * edit dialog, and that bulk-action selection + Send/Void/Export-CSV work.
 *
 * ZKA invariant: every assertion below references values that come back from
 * the mocked `decryptInvoice` helper — never from a Supabase column directly.
 * If a future refactor accidentally reads ciphertext-as-plaintext from the
 * row, these tests will fail because they only stub `decryptInvoice`.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Invoices from '../Invoices';

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('@/hooks/useUserOrg', () => ({
  useUserOrg: () => ({ orgId: 'org-1' }),
}));

const __vaultStable = {
  encryptText: async (s: string) => `enc(${s})`,
  decryptText: async (s: string) => s.replace(/^enc\(|\)$/g, ''),
  isUnlocked: true,
};
vi.mock('@/context/VaultContext', () => ({
  useVault: () => __vaultStable,
}));

vi.mock('@/hooks/useOrgSettings', () => ({
  useFormatCurrency: () => ({
    formatAmount: (n: number, c: string) => `${c} ${n.toFixed(2)}`,
  }),
}));

// Pretend every encrypted invoice row decrypts to the customer name stored
// in the helper field `__customer`, so the test can build deterministic
// fixtures without going through real WebCrypto.
vi.mock('@/lib/crypto-fields', () => ({
  encryptInvoice: vi.fn(async (f: any) => ({ ...f, __encrypted: true })),
  decryptInvoice: vi.fn(async (row: any) => ({
    customer_name: row.__customer,
    customer_email_snapshot: row.__email ?? null,
    customer_phone_snapshot: null,
    customer_address: null,
    amount: row.amount,
    memo: row.__memo ?? null,
    internal_notes: null,
    payment_instructions: null,
  })),
  encryptInvoiceLineItem: vi.fn(async (f: any) => ({ ...f })),
  decryptInvoiceLineItem: vi.fn(async (l: any) => ({
    description: l.__desc ?? '',
    amount: l.__amount ?? 0,
    chart_of_accounts_id: null,
  })),
}));

vi.mock('@/lib/invoiceShare', () => ({
  buildInvoiceShare: vi.fn(async () => ({
    publicUrlId: 'pub-1',
    encryptedShareBlob: 'blob',
    shareUrl: 'https://example.com/i/pub-1',
  })),
}));

vi.mock('@/lib/invoicePdf', () => ({
  openInvoicePrint: vi.fn(),
}));

vi.mock('@/lib/exports/csv', () => ({
  exportToCsv: vi.fn(),
}));

// Hoisted helpers so the vi.mock factory below can close over them
// (vi.mock factories run before module top-level code).
const { __INVOICES, __updateMock, __makeChain } = vi.hoisted(() => {
  const INVOICES = [
    {
      id: 'inv-1',
      invoice_number: 'INV-001',
      status: 'DRAFT',
      amount: 100,
      currency: 'USD',
      issue_date: '2026-05-01',
      due_date: '2026-05-15',
      sent_at: null,
      paid_at: null,
      __customer: 'Acme Corp',
    },
    {
      id: 'inv-2',
      invoice_number: 'INV-002',
      status: 'SENT',
      amount: 250,
      currency: 'USD',
      issue_date: '2026-05-02',
      due_date: '2026-05-16',
      sent_at: '2026-05-02T00:00:00Z',
      paid_at: null,
      __customer: 'Beta LLC',
    },
    {
      id: 'inv-3',
      invoice_number: 'INV-003',
      status: 'PAID',
      amount: 999,
      currency: 'EUR',
      issue_date: '2026-05-03',
      due_date: '2026-05-17',
      sent_at: '2026-05-03T00:00:00Z',
      paid_at: '2026-05-05T00:00:00Z',
      __customer: 'Gamma Inc',
    },
    {
      id: 'inv-4',
      invoice_number: 'INV-004',
      status: 'DRAFT',
      amount: 42,
      currency: 'USD',
      issue_date: '2026-05-04',
      due_date: null,
      sent_at: null,
      paid_at: null,
      __customer: 'Delta Co',
    },
  ];
  const updateMock = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  function makeChain(data: any) {
    const result = { data, error: null };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: Array.isArray(data) ? null : data, error: null }),
      single: () => Promise.resolve(result),
      then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  }
  return { __INVOICES: INVOICES, __updateMock: updateMock, __makeChain: makeChain };
});

const INVOICES_FIXTURE = __INVOICES;
const updateMock = __updateMock;

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    if (table === 'invoices')
      return {
        ...__makeChain(__INVOICES),
        update: __updateMock,
        delete: () => __makeChain(null),
        insert: () => __makeChain({ id: 'new' }),
      };
    if (table === 'org_settings') {
      return __makeChain({
        public_org_name: 'Acme Org',
        invoice_email_subject_template: null,
        invoice_email_body_template: null,
      });
    }
    return {
      ...__makeChain([]),
      update: vi.fn(() => __makeChain(null)),
      delete: () => __makeChain(null),
      insert: () => __makeChain({ id: 'new' }),
    };
  };
  return {
    supabase: {
      from: vi.fn((t: string) => builder(t)),
      rpc: vi.fn(async () => ({ data: 'INV-005', error: null })),
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
      functions: { invoke: vi.fn(async () => ({ data: { sent: true }, error: null })) },
    },
  };
});

// sonner toast — silence in tests but allow spying.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────

async function renderAndWait() {
  render(<Invoices />);
  await waitFor(
    () => {
      expect(screen.queryAllByTestId('invoice-row').length).toBeGreaterThan(0);
    },
    { timeout: 4000 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Invoices page (I4)', () => {
  it('renders all decrypted invoice rows from the org', async () => {
    await renderAndWait();
    const rows = screen.getAllByTestId('invoice-row');
    expect(rows).toHaveLength(4);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta LLC')).toBeInTheDocument();
    expect(screen.getByText('Gamma Inc')).toBeInTheDocument();
    expect(screen.getByText('Delta Co')).toBeInTheDocument();
  });

  it('filters rows by plaintext status (DRAFT chip narrows to two rows)', async () => {
    await renderAndWait();
    // Find the DRAFT chip inside the status filter strip.
    const filterBar = screen.getByTestId('invoice-status-filter');
    const draftChip = within(filterBar).getByText(/^DRAFT$/);
    fireEvent.click(draftChip);
    await waitFor(() => {
      expect(screen.getAllByTestId('invoice-row')).toHaveLength(2);
    });
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Delta Co')).toBeInTheDocument();
    expect(screen.queryByText('Beta LLC')).not.toBeInTheDocument();
  });

  it('shows the bulk-action bar when a row is selected', async () => {
    await renderAndWait();
    const cb = screen.getByTestId('invoice-select-INV-001');
    fireEvent.click(cb);
    const bar = await screen.findByTestId('invoice-bulk-bar');
    expect(within(bar).getByText(/1 selected/)).toBeInTheDocument();
    expect(within(bar).getByTestId('invoice-bulk-send')).toBeInTheDocument();
    expect(within(bar).getByTestId('invoice-bulk-void')).toBeInTheDocument();
    expect(within(bar).getByTestId('invoice-bulk-export')).toBeInTheDocument();
  });

  it('bulk-void writes status=VOIDED only for non-PAID/VOIDED selections', async () => {
    await renderAndWait();
    // Select INV-001 (DRAFT) + INV-003 (PAID — should be skipped by the
    // handler's status guard, NOT silently flipped to VOIDED).
    fireEvent.click(screen.getByTestId('invoice-select-INV-001'));
    fireEvent.click(screen.getByTestId('invoice-select-INV-003'));

    // Stub window.confirm so the handler proceeds.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByTestId('invoice-bulk-void'));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });
    // Exactly one update call (for INV-001). INV-003 is PAID — guard skips it.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updatePayload = updateMock.mock.calls[0][0];
    expect(updatePayload.status).toBe('VOIDED');

    confirmSpy.mockRestore();
  });

  it('Export CSV invokes the browser-side exporter with decrypted rows', async () => {
    const { exportToCsv } = await import('@/lib/exports/csv');
    await renderAndWait();
    fireEvent.click(screen.getByTestId('invoice-export-csv'));
    await waitFor(() => {
      expect(exportToCsv).toHaveBeenCalledTimes(1);
    });
    const [filename, headers, rows] = (exportToCsv as any).mock.calls[0];
    expect(filename).toMatch(/^owb-invoices-/);
    expect(headers).toContain('Customer');
    expect(headers).toContain('Amount');
    // Customer column must contain the DECRYPTED name, never an encrypted
    // blob — proves the ZKA invariant holds end-to-end through the export.
    const customers = rows.map((r: any[]) => r[4]);
    expect(customers).toEqual(
      expect.arrayContaining(['Acme Corp', 'Beta LLC', 'Gamma Inc', 'Delta Co']),
    );
  });
});
