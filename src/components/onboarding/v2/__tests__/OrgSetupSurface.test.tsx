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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FIELD_KEY_VERSION } from '@/lib/crypto-fields';
import OrgSetupSurface from '../OrgSetupSurface';
import type { OnboardingVaultSetup } from '../onboarding-state';

/**
 * What the wizard hands over. Not the MEK, not the password, not the recovery
 * code: a verifier, a public salt, a key version and two wrapped-MEK
 * ciphertexts. Values are obvious placeholders so an assertion failure names
 * the field that went missing.
 */
const VAULT_SETUP: OnboardingVaultSetup = {
  verifier: 'verifier-abc',
  vaultSalt: 'salt-abc',
  vaultKeyVersion: 1,
  encMekCiphertext: 'enc-mek-abc',
  recoveryCiphertext: 'recovery-abc',
};

// Hoisted so the vi.mock factories below (hoisted above the imports) can close
// over the same spy instances the assertions read.
const { createOrgRpc, updateEq } = vi.hoisted(() => ({
  createOrgRpc: vi.fn(async () => ({ data: 'org-1', error: null })),
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
    // Org creation is one SECURITY DEFINER call now, so there is nothing left
    // to intercept per table on the create path.
    rpc: createOrgRpc,
    // The only table this surface still touches directly is organizations, and
    // only to move ledger_status while the chart of accounts seeds.
    from: () => ({ update: () => ({ eq: updateEq }) }),
  },
}));

vi.mock('@/lib/crypto-fields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crypto-fields')>()),
  encryptOrgSettings: async () => ({ key_version: 2 }),
}));

vi.mock('@/lib/init-chart-of-accounts', () => ({
  initChartOfAccounts: async () => {},
}));

const toastError = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, {
    loading: () => 'toast-id',
    success: () => {},
    error: toastError,
  }),
}));

// Screen 1 is the organization name; a non-blank name is required before the
// Continue button advances to the currency screen.
function renderAtCurrencyScreen() {
  const onComplete = vi.fn();
  render(<OrgSetupSurface userId="user-1" vaultSetup={VAULT_SETUP} onComplete={onComplete} />);
  fireEvent.change(screen.getByLabelText('Organization Name'), {
    target: { value: 'Satoshi Holdings Ltd' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return { onComplete };
}

describe('OrgSetupSurface screen 1 (organization name)', () => {
  it('keeps Continue disabled until a non-blank name is entered', () => {
    render(<OrgSetupSurface userId="user-1" vaultSetup={VAULT_SETUP} onComplete={vi.fn()} />);
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
  it('creates the org in one atomic call, then fires onComplete', async () => {
    const onComplete = vi.fn();
    render(<OrgSetupSurface userId="user-1" vaultSetup={VAULT_SETUP} onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Organization Name'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Primary currency'), {
      target: { value: 'BTC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open my books' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(createOrgRpc).toHaveBeenCalledTimes(1);
    expect(createOrgRpc).toHaveBeenCalledWith(
      'create_org_for_current_user',
      expect.objectContaining({
        p_org_name: 'enc:Acme',
        p_key_version: FIELD_KEY_VERSION,
      }),
    );
  });
});

/**
 * The lockout gap.
 *
 * v2 created the vault in the wizard and then dropped the result on the floor
 * at the phase boundary, so org_settings was written without a verifier, a
 * salt, a key version or either wrapped-MEK ciphertext. Nothing failed. The
 * customer finished onboarding, landed on a working dashboard, and could not
 * open their books on the next login, because the unlock screen reads those
 * columns by org_id and there was nothing to read. No repair path exists: the
 * MEK lives only inside the ciphertexts that were never stored.
 *
 * The suite above did not catch it because it asserted that the settings
 * insert HAPPENED, never what it carried. So these assert the payload.
 */
describe('OrgSetupSurface persists the vault material (lockout regression)', () => {
  beforeEach(() => {
    createOrgRpc.mockClear();
    toastError.mockClear();
  });

  async function finish(vaultSetup: OnboardingVaultSetup | null) {
    const onComplete = vi.fn();
    render(<OrgSetupSurface userId="user-1" vaultSetup={vaultSetup} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText('Organization Name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Primary currency'), { target: { value: 'BTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open my books' }));
    return onComplete;
  }

  it('passes all five vault fields to the atomic create call', async () => {
    await finish(VAULT_SETUP);

    await waitFor(() => expect(createOrgRpc).toHaveBeenCalledTimes(1));
    expect(createOrgRpc).toHaveBeenCalledWith(
      'create_org_for_current_user',
      expect.objectContaining({
        p_vault_verifier: 'verifier-abc',
        p_vault_salt: 'salt-abc',
        p_vault_key_version: 1,
        p_enc_mek_ciphertext: 'enc-mek-abc',
        p_recovery_ciphertext: 'recovery-abc',
      }),
    );
  });

  it('writes them in the same transaction as the org, leaving no window without a verifier', async () => {
    await finish(VAULT_SETUP);

    // One transactional call, not three sequential writes. If this ever splits
    // up again, a failure between the parts leaves an organization nobody can
    // open while the customer is told everything worked.
    await waitFor(() => expect(createOrgRpc).toHaveBeenCalledTimes(1));
    expect(createOrgRpc).toHaveBeenCalledWith(
      'create_org_for_current_user',
      expect.objectContaining({ p_vault_verifier: 'verifier-abc' }),
    );
  });

  it('refuses to create anything at all when the vault material is missing', async () => {
    const onComplete = await finish(null);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Nothing was written, so there is no half-made organization to clean up
    // and no dashboard the customer cannot unlock.
    expect(createOrgRpc).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/**
 * OWB-T0110: the `.rpc(...)` call is cast `as any`, so a renamed or
 * misspelled argument is invisible to tsc, and the objectContaining
 * assertions above only ever checked 7 of the 17 names. Someone renaming
 * one of the other 10 (all p_settings_*) would still see 5/5 green: tsc
 * because the cast hides it, this suite because objectContaining does not
 * fail on an unlisted key. At runtime PostgREST cannot resolve the function
 * by its named arguments and every v2 org creation fails with PGRST202.
 *
 * These two tests are the fallback this ticket names when a typed fix
 * (regenerating the Supabase types so `.rpc` is typed and `as any` can be
 * deleted) is not available in this environment: assert all 17 names, and
 * assert an RPC error actually stops the flow.
 */
describe('OrgSetupSurface RPC contract (OWB-T0110)', () => {
  beforeEach(() => {
    createOrgRpc.mockClear();
    updateEq.mockClear();
    toastError.mockClear();
  });

  async function openBooks() {
    const onComplete = vi.fn();
    render(<OrgSetupSurface userId="user-1" vaultSetup={VAULT_SETUP} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText('Organization Name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Primary currency'), { target: { value: 'BTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open my books' }));
    return onComplete;
  }

  it('calls create_org_for_current_user with exactly the 17 argument names the RPC expects', async () => {
    await openBooks();

    await waitFor(() => expect(createOrgRpc).toHaveBeenCalledTimes(1));
    const [rpcName, args] = createOrgRpc.mock.calls[0];
    expect(rpcName).toBe('create_org_for_current_user');

    // A key SET comparison, not objectContaining: objectContaining checks
    // `received[key] === expected[key]` by bracket access, so an expected
    // value of `undefined` cannot tell "key renamed or dropped" apart from
    // "key present and happens to be undefined" -- it would not fail if
    // p_settings_timezone were mistyped p_settings_timeZone. Comparing the
    // full sorted key list catches a rename, a drop, or a stray extra
    // argument by name, which is the actual PGRST202 failure mode.
    expect(Object.keys(args).sort()).toEqual(
      [
        'p_org_name',
        'p_key_version',
        'p_settings_primary_currency',
        'p_settings_secondary_currency',
        'p_settings_bitcoin_display',
        'p_settings_fiscal_year_type',
        'p_settings_encrypted_fiscal_month',
        'p_settings_date_format',
        'p_settings_time_format',
        'p_settings_number_format',
        'p_settings_timezone',
        'p_settings_key_version',
        'p_vault_verifier',
        'p_vault_salt',
        'p_vault_key_version',
        'p_enc_mek_ciphertext',
        'p_recovery_ciphertext',
      ].sort(),
    );
  });

  it('does not call onComplete or touch ledger_status when the RPC returns an error', async () => {
    // The shape PostgREST actually returns on a bad call (e.g. PGRST202 for
    // an unresolvable named-argument set): data null, an error object that
    // is not an Error instance, exactly what line `if (rpcError) throw
    // rpcError` throws today.
    createOrgRpc.mockImplementationOnce(async () => ({
      data: null,
      error: { message: 'Could not find the function in the schema cache', code: 'PGRST202' },
    }));

    const onComplete = await openBooks();

    await waitFor(() => expect(createOrgRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    // The behaviour this PR changed most, and the one with no prior test:
    // an RPC error must stop the flow before the ledger_status write and
    // before onComplete, not just show a toast alongside them.
    expect(updateEq).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
