/**
 * OrgSetupSurface, the DL-0718 post-onboarding org setup surface.
 *
 * Two kinds of assertion:
 *   - Gating (slice 2, DEC-0281/0282): the CTA enable/disable rules and the
 *     conditional Bitcoin display block. These do not touch the write path.
 *   - Finish (slice 3, DL-0718): pressing "Open my books" creates the org and
 *     fires onComplete. The vault and supabase are mocked so this stays
 *     deterministic and offline. Encryption runs in the browser via
 *     encryptText, so the server dependency here is a plain write.
 *
 * The pickers are native select elements, so a currency change is a plain
 * fireEvent.change and needs none of the pointer polyfills a Radix listbox
 * would require and this repo's vitest setup does not provide.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OrgSetupSurface from '../OrgSetupSurface';

// Hoisted so the vi.mock factories below (hoisted above the imports) can close
// over the same spy instances the assertions read.
const { insertOrg, upsertMember, insertSettings, updateEq } = vi.hoisted(() => ({
  insertOrg: vi.fn(async () => ({ error: null })),
  upsertMember: vi.fn(async () => ({ error: null })),
  insertSettings: vi.fn(async () => ({ error: null })),
  updateEq: vi.fn(async () => ({ error: null })),
}));

vi.mock('@/context/VaultContext', () => ({
  useVault: () => ({ encryptText: async (s: string) => `enc:${s}` }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === 'org_members') return { upsert: upsertMember };
      if (table === 'org_settings') return { insert: insertSettings };
      // organizations: insert on create, update for ledger_status.
      return { insert: insertOrg, update: () => ({ eq: updateEq }) };
    },
  },
}));

vi.mock('@/lib/crypto-fields', () => ({
  encryptOrgSettings: async () => ({ key_version: 2 }),
}));

vi.mock('@/lib/init-chart-of-accounts', () => ({
  initChartOfAccounts: async () => {},
}));

vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, {
    loading: () => 'toast-id',
    success: () => {},
    error: () => {},
  }),
}));

// Screen 1 is the organization name; a non-blank name is required before the
// Continue button advances to the currency screen.
function renderAtCurrencyScreen() {
  const onComplete = vi.fn();
  render(<OrgSetupSurface userId="user-1" onComplete={onComplete} />);
  fireEvent.change(screen.getByLabelText('Organization Name'), {
    target: { value: 'Satoshi Holdings Ltd' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return { onComplete };
}

describe('OrgSetupSurface screen 1 (organization name)', () => {
  it('keeps Continue disabled until a non-blank name is entered', () => {
    render(<OrgSetupSurface userId="user-1" onComplete={vi.fn()} />);
    const cta = screen.getByRole('button', { name: 'Continue' });
    expect(cta).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: '   ' },
    });
    expect(cta).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: 'Acme' },
    });
    expect(cta).toBeEnabled();
  });
});

describe('OrgSetupSurface screen 2 (currencies)', () => {
  it('keeps "Open my books" disabled until a primary currency is chosen (DEC-0281)', () => {
    renderAtCurrencyScreen();
    const cta = screen.getByRole('button', { name: 'Open my books' });
    expect(cta).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Primary currency'), {
      target: { value: 'USD' },
    });
    expect(cta).toBeEnabled();
  });

  it('enables the CTA with the secondary currency left empty (DEC-0282)', () => {
    renderAtCurrencyScreen();
    fireEvent.change(screen.getByLabelText('Primary currency'), {
      target: { value: 'USD' },
    });
    // The secondary picker is untouched and still resolves to "None".
    expect(screen.getByLabelText(/Secondary currency/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Open my books' })).toBeEnabled();
  });

  it('shows the Bitcoin display block only while a picker is BTC (DEC-0281)', () => {
    renderAtCurrencyScreen();
    const primary = screen.getByLabelText('Primary currency');
    const secondary = screen.getByLabelText(/Secondary currency/);

    // Neither picker is BTC: no display block.
    fireEvent.change(primary, { target: { value: 'USD' } });
    expect(screen.queryByLabelText(/Bitcoin display preference/)).toBeNull();

    // Primary is BTC: the block appears.
    fireEvent.change(primary, { target: { value: 'BTC' } });
    expect(screen.getByLabelText(/Bitcoin display preference/)).toBeInTheDocument();

    // Primary back to fiat, secondary is BTC: still appears.
    fireEvent.change(primary, { target: { value: 'USD' } });
    fireEvent.change(secondary, { target: { value: 'BTC' } });
    expect(screen.getByLabelText(/Bitcoin display preference/)).toBeInTheDocument();

    // Neither picker is BTC again: the block disappears.
    fireEvent.change(secondary, { target: { value: 'EUR' } });
    expect(screen.queryByLabelText(/Bitcoin display preference/)).toBeNull();
  });
});

describe('OrgSetupSurface finish (slice 3, DL-0718)', () => {
  it('creates the org, the OWNER member and settings, then fires onComplete', async () => {
    const onComplete = vi.fn();
    render(<OrgSetupSurface userId="user-1" onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Primary currency'), {
      target: { value: 'BTC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open my books' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(insertOrg).toHaveBeenCalledTimes(1);
    expect(upsertMember).toHaveBeenCalledTimes(1);
    expect(insertSettings).toHaveBeenCalledTimes(1);
  });
});
