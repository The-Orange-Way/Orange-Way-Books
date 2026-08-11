import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepShell } from './onboarding-flow';
import {
  getFiatCurrencies,
  getCryptoCurrencies,
  getSymbol,
} from '@/lib/exchange/currency-registry';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { useVault } from '@/context/VaultContext';
import { encryptOrgSettings } from '@/lib/crypto-fields';
import { initChartOfAccounts } from '@/lib/init-chart-of-accounts';
import { captureException } from '@/lib/observability/sentry';
import type { BitcoinDisplay } from '@/types';
import type { User } from '@supabase/supabase-js';

/**
 * Post-onboarding organization setup surface (DL-0718, DEC-0280/0281/0282).
 *
 * Renders after the shared 7-step wizard reaches success, and deliberately NOT
 * as an extra step inside buildOnboardingSteps. step-registry.ts names three
 * places the organization work could land; this is option 1, chosen so the 7
 * steps stay identical to the sibling app and the aha moment stays early.
 *
 * Two screens, render plus local state only:
 *   1. Organization name (validate-only, lifted from v1 StepOrganization).
 *   2. Currency: a required primary, an optional secondary, and a Bitcoin
 *      display preference that appears only while a picker is set to BTC.
 *
 * Nothing is persisted here: no createVault, no org or chart-of-accounts
 * creation, no schema change, and no v1 path is touched. onComplete carries no
 * value on purpose. The real org creation (client encrypted, after the vault
 * precondition DL-0414) is a later slice. This stays dark behind
 * VITE_ONBOARDING_V2 with the rest of v2.
 *
 * The two currency pickers are native select elements on purpose. The v1 step
 * uses the Radix Select, but this repo's vitest setup has no pointer polyfills,
 * so a Radix listbox cannot be opened in jsdom and the CTA-gating assertions
 * could not be written against it. "Design twins means the same design, not the
 * same DOM" (see onboarding-flow.tsx), so a native control styled to match and
 * deterministically testable is the right trade here.
 */
interface OrgSetupSurfaceProps {
  userId: string;
  onComplete: () => void;
}

const FIAT_CURRENCIES = getFiatCurrencies();
const CRYPTO_CURRENCIES = getCryptoCurrencies();

// getSymbol returns the code itself for USDT/USDC/DAI on purpose (a '$' on a
// stablecoin implies a dollar balance it is not), so building the label from
// the registry gets that property for free. When the symbol is just the code,
// show the code once rather than repeating it.
function currencyLabel(code: string, name: string): string {
  const symbol = getSymbol(code);
  return symbol === code ? `${code} - ${name}` : `${symbol}  ${code} - ${name}`;
}

// Same visual weight as the shadcn Input this surface already uses, so the
// native control reads as part of the same form.
const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

// The Bitcoin display preference is conditional (DEC-0281): it appears only
// while a picker is set to BTC.
const BTC_DISPLAY_OPTIONS = [
  { value: 'btc', label: 'BTC 1.50000000' },
  { value: 'btc-easy', label: 'BTC 0.00 050 000' },
  { value: 'sats', label: 'sats 1,500,000' },
  { value: 'bitcoins', label: 'BTC 1,500,000' },
];

function CurrencyOptions() {
  return (
    <>
      <optgroup label="Fiat">
        {FIAT_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {currencyLabel(c.code, c.name)}
          </option>
        ))}
      </optgroup>
      <optgroup label="Crypto">
        {CRYPTO_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {currencyLabel(c.code, c.name)}
          </option>
        ))}
      </optgroup>
    </>
  );
}

export default function OrgSetupSurface({ userId, onComplete }: OrgSetupSurfaceProps) {
  const { encryptText } = useVault();
  const [screen, setScreen] = useState<0 | 1>(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [primaryCurrency, setPrimaryCurrency] = useState('');
  const [secondaryCurrency, setSecondaryCurrency] = useState('');
  const [bitcoinDisplay, setBitcoinDisplay] = useState('btc');

  // Same rule as v1 StepOrganization: a name is present once it is non-blank.
  const nameValid = name.trim().length > 0;

  // DEC-0281: the primary currency is required and gates the CTA. DEC-0282: the
  // secondary is optional, so an empty secondary never blocks the button.
  const currencyValid = primaryCurrency.length > 0;

  // DEC-0281: ask for the Bitcoin display preference only while a picker is set
  // to BTC. SATS is intentionally not a trigger: it is one of the display
  // formats below, not a separate currency choice that needs one.
  const showBitcoinDisplay = primaryCurrency === 'BTC' || secondaryCurrency === 'BTC';

  // Mirror of v1 OnboardingWizard.waitForAuthenticatedUser: the org insert
  // needs the authenticated user, which may still be settling right after
  // sign-up. Resolve as soon as the session matches the userId we were given.
  const waitForAuthenticatedUser = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.id === userId) {
      return session.user;
    }

    return await new Promise<User>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error('Authentication is still loading. Please wait a moment and try again.'));
      }, 5000);

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (nextSession?.user?.id === userId) {
          window.clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve(nextSession.user);
        }
      });
    });
  };

  // Create the organization on the final CTA. This mirrors the v1 finish path
  // (OnboardingWizard.handleFinish) so behaviour matches the live app. All
  // client-side encryption: the server only ever stores ciphertext.
  const handleFinish = async () => {
    setSaving(true);
    try {
      const user = await waitForAuthenticatedUser();
      const orgId = crypto.randomUUID();

      // 1. Insert organization with a client-encrypted name.
      const encOrgName = await encryptText(name);
      const { error: orgError } = await supabase
        .from('organizations')
        .insert({ id: orgId, name: encOrgName, key_version: 2 });
      if (orgError) throw orgError;

      // 2. Guarantee the creator's OWNER row. A post-insert trigger on
      // organizations already inserts it, so this upsert is idempotent.
      const { error: memberError } = await supabase
        .from('org_members')
        .upsert(
          { org_id: orgId, user_id: user.id, role: 'OWNER' },
          { onConflict: 'user_id,org_id' },
        );
      if (memberError) throw memberError;

      // 3. Insert org_settings, every field client-encrypted. Fields this
      // surface does not yet collect take the v2 defaults: a calendar fiscal
      // year (start month 1), US number format, and null date/time/timezone.
      const secondary = secondaryCurrency.length > 0 ? secondaryCurrency : null;
      const btcDisplay: BitcoinDisplay =
        primaryCurrency === 'BTC' || secondary === 'BTC'
          ? (bitcoinDisplay as BitcoinDisplay)
          : 'sats';
      const encSettings = await encryptOrgSettings(
        {
          primary_currency: primaryCurrency,
          secondary_currency: secondary,
          bitcoin_display: btcDisplay,
          fiscal_year_type: 'calendar',
          fiscal_start_month: 1,
          date_format: null,
          time_format: null,
          number_format: 'us',
          timezone: null,
        },
        encryptText,
      );
      const { error: settingsError } = await supabase.from('org_settings').insert({
        org_id: orgId,
        ...encSettings,
      } as any);
      if (settingsError) throw settingsError;

      // 4. Seed the chart of accounts in the background (v1 parity): mark the
      // org provisioning, dispatch initChartOfAccounts fire-and-forget, and let
      // the user into the app immediately. The IIFE closes over encryptText,
      // which keeps working after this surface unmounts because the MEK lives
      // in VaultContext.
      await (supabase as any)
        .from('organizations')
        .update({ ledger_status: 'provisioning', ledger_status_error: null })
        .eq('id', orgId);

      const coaToast = toast.loading('Encrypting accounts...', {
        description: 'Server only sees ciphertext. Safe to keep using the app.',
        duration: Infinity,
      });

      void (async () => {
        try {
          await initChartOfAccounts(orgId, encryptText, (done, total) => {
            toast.loading(`Encrypting accounts (${done}/${total})...`, {
              id: coaToast,
              description: 'Server only sees ciphertext.',
              duration: Infinity,
            });
          });
          await (supabase as any)
            .from('organizations')
            .update({ ledger_status: 'ready', ledger_status_error: null })
            .eq('id', orgId);
          toast.success('Chart of accounts ready', { id: coaToast, duration: 3000 });
        } catch (coaErr) {
          const errMsg = coaErr instanceof Error ? coaErr.message : String(coaErr);
          console.error('Chart of accounts seeding failed:', coaErr);
          captureException(coaErr, { tags: { source: 'onboarding-v2-coa-seed' } });
          await (supabase as any)
            .from('organizations')
            .update({ ledger_status: 'failed', ledger_status_error: errMsg })
            .eq('id', orgId)
            .then(
              () => undefined,
              () => undefined,
            );
          toast.error('Chart of accounts setup hit an issue', {
            id: coaToast,
            description: errMsg || 'You can retry from the dashboard.',
            duration: 10000,
          });
        }
      })();

      toast.success('Organization created successfully!');
      onComplete();
    } catch (err) {
      console.error('Onboarding failed:', err);
      const message =
        err instanceof Error ? err.message : 'Failed to create organization. Please try again.';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {screen === 0 ? (
        <StepShell
          title="Your organization"
          onNext={() => setScreen(1)}
          onBack={() => {}}
          isFirst
          isLast={false}
          hideBack
          nextLabel="Continue"
          nextDisabled={!nameValid}
        >
          <p className="mb-6">
            Name your company or entity. You can change this later in Admin settings.
          </p>
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization Name</Label>
            <Input
              id="org-name"
              placeholder="e.g. Satoshi Holdings Ltd"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
        </StepShell>
      ) : (
        <StepShell
          title="Your currencies"
          onNext={handleFinish}
          onBack={() => setScreen(0)}
          isFirst={false}
          isLast
          nextLabel="Open my books"
          nextDisabled={!currencyValid || saving}
        >
          <p className="mb-6">
            Pick the currency your books are kept in. You can add a second display currency now or
            later in Admin settings.
          </p>
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="primary-currency">Primary currency</Label>
              <select
                id="primary-currency"
                className={selectClass}
                value={primaryCurrency}
                onChange={(e) => setPrimaryCurrency(e.target.value)}
              >
                <option value="" disabled>
                  Select a currency
                </option>
                <CurrencyOptions />
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secondary-currency">Secondary currency (optional)</Label>
              <select
                id="secondary-currency"
                className={selectClass}
                value={secondaryCurrency}
                onChange={(e) => setSecondaryCurrency(e.target.value)}
              >
                <option value="">None</option>
                <CurrencyOptions />
              </select>
            </div>

            {showBitcoinDisplay ? (
              <div className="space-y-2 pl-1">
                <Label htmlFor="bitcoin-display">Bitcoin display preference</Label>
                <select
                  id="bitcoin-display"
                  className={selectClass}
                  value={bitcoinDisplay}
                  onChange={(e) => setBitcoinDisplay(e.target.value)}
                >
                  {BTC_DISPLAY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </StepShell>
      )}
    </div>
  );
}
