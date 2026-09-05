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
import { encryptOrgSettings, FIELD_KEY_VERSION } from '@/lib/crypto-fields';
import { initChartOfAccounts } from '@/lib/init-chart-of-accounts';
import { MONTH_NAMES, monthNumber } from '@/lib/months';
import { browserTimezone, timezoneOptionsForDetection } from '@/lib/timezones';
import { captureException } from '@/lib/observability/sentry';
import type { OnboardingVaultSetup } from './onboarding-state';
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
 * Three screens, render plus local state only:
 *   1. Organization name (validate-only, lifted from v1 StepOrganization).
 *   2. Currency: a required primary, an optional secondary, and a Bitcoin
 *      display preference that appears only while a picker is set to BTC.
 *   3. Fiscal year start and timezone (OWB-T0102), both lifted from the v1
 *      StepCalendar and StepReporting steps. They are asked rather than
 *      defaulted because a wrong fiscal start puts every period boundary in
 *      the ledger in the wrong place and a wrong timezone moves which day a
 *      transaction lands on, and neither is visible to the customer at
 *      signup.
 *
 * Slice 3 (DL-0718): the final CTA now creates the organization, mirroring the
 * v1 OnboardingWizard.handleFinish path. Both wizards call the atomic
 * create_org_for_current_user RPC (DL-1348), which writes the organizations
 * row, the OWNER org_members row and the client-encrypted org_settings row in
 * one database transaction, and then seed the chart of accounts in the
 * background. Zero-knowledge holds by
 * construction: the org name and every settings field are encrypted in the
 * browser via encryptText, a closure over the MEK held in VaultContext, and no
 * key material crosses a prop boundary (only userId is threaded in).
 * encryptOrgSettings is reused verbatim from v1, so there is no new derivation,
 * salt, or KDF. The three fields this surface still does not collect (date
 * format, time format, number format) take the v2 defaults: they are display
 * preferences, changeable in Admin at any time with no wrong books in the
 * meantime.
 *
 * The org_settings row the RPC writes also carries the five vault fields the
 * wizard produced. In this product the vault is per-organization: org_settings is
 * where the verifier, the salt, the key version and both wrapped-MEK
 * ciphertexts live, and the unlock screen reads them from that row by org_id.
 * The row therefore has to be written with them, because the organization it
 * keys does not exist until this function runs.
 * This stays dark behind VITE_ONBOARDING_V2 with the rest of v2.
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
  /**
   * The persistable output of the wizard's vault creation. Not the MEK, not
   * the password, not the recovery code: a verifier, a public salt, a key
   * version and two wrapped-MEK ciphertexts, all of which v1 stores in this
   * same table. Null only if this surface is rendered outside the wizard,
   * which handleFinish refuses rather than working around.
   */
  vaultSetup: OnboardingVaultSetup | null;
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

export default function OrgSetupSurface({ userId, vaultSetup, onComplete }: OrgSetupSurfaceProps) {
  const { encryptText } = useVault();
  const [screen, setScreen] = useState<0 | 1 | 2>(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [primaryCurrency, setPrimaryCurrency] = useState('');
  const [secondaryCurrency, setSecondaryCurrency] = useState('');
  const [bitcoinDisplay, setBitcoinDisplay] = useState('btc');

  // v1 parity: the fiscal year start is held as a month NAME and mapped to a
  // 1-based number at finish through the shared months module, so the two
  // wizards cannot drift on what the same answer means.
  const [fiscalYearStart, setFiscalYearStart] = useState('january');

  // Detected once, on mount. The option list is built from the detected zone
  // rather than the current one so that picking a listed zone does not drop
  // the detected entry out of the list underneath the customer.
  const [detectedTimezone] = useState(browserTimezone);
  const timezoneOptions = timezoneOptionsForDetection(detectedTimezone);
  const [timezone, setTimezone] = useState(detectedTimezone || timezoneOptions[0].value);

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
      // Refuse before writing anything, rather than degrading. Without the
      // vault fields every insert below still succeeds and the customer lands
      // on a working dashboard, so the failure is completely silent until
      // their next login, at which point the unlock screen has no verifier to
      // check the password against and the books cannot be opened by anyone,
      // including us. There is no repair path: the MEK exists only inside the
      // two ciphertexts we would have failed to store. Checking here rather
      // than at the settings insert also means a refusal leaves no orphaned
      // organization behind. An error costs a retry; continuing costs the
      // customer their books.
      if (!vaultSetup) {
        throw new Error(
          'Your vault was not set up. Please restart onboarding rather than continuing, so your books stay openable.',
        );
      }

      // The RPC takes the caller from auth.uid(), so the session has to have
      // settled before it runs. Straight after sign-up it may not have.
      await waitForAuthenticatedUser();

      // 1. Encrypt the organization name in the browser.
      const encOrgName = await encryptText(name);

      // 2. Encrypt every settings field. The fiscal year start and the
      // timezone are the customer's own answers (OWB-T0102). Date format,
      // time format and number format still take the v2 defaults.

      const secondary = secondaryCurrency.length > 0 ? secondaryCurrency : null;
      const btcDisplay: BitcoinDisplay =
        primaryCurrency === 'BTC' || secondary === 'BTC'
          ? (bitcoinDisplay as BitcoinDisplay)
          : 'sats';

      // Mirror of v1 OnboardingWizard.handleFinish. monthNumber returns 0 for
      // an unrecognized name, and callers must treat that as an error rather
      // than coerce it, because coercing it silently picks January, which is
      // the exact failure the shared months module exists to prevent.
      const fiscalStartMonth = monthNumber(fiscalYearStart);
      if (fiscalStartMonth === 0) {
        throw new Error(`Unrecognized fiscal year start month: ${fiscalYearStart}`);
      }
      // A start month other than January means the org keeps a fiscal rather
      // than a calendar year. That is what makes the Settings screen surface
      // and apply the month.
      const fiscalYearType = fiscalStartMonth === 1 ? 'calendar' : 'fiscal';

      const encSettings = await encryptOrgSettings(
        {
          primary_currency: primaryCurrency,
          secondary_currency: secondary,
          bitcoin_display: btcDisplay,
          fiscal_year_type: fiscalYearType,
          fiscal_start_month: fiscalStartMonth,
          date_format: null,
          time_format: null,
          number_format: 'us',
          timezone: timezone || null,
        },
        encryptText,
      );
      // 3. One atomic call instead of three sequential client-side writes.
      // create_org_for_current_user is SECURITY DEFINER and wraps the
      // organizations row, the OWNER org_members row and the org_settings row
      // in a single database transaction, so a lost connection or a closed tab
      // rolls the whole thing back instead of leaving a half-created
      // organization behind. It also closes the window where a settings row
      // could exist without its verifier: an organization is never visible
      // without the material that opens it. Caller identity comes from
      // auth.uid() inside the function, never from a parameter here. Exactly
      // four values below are not sealed material: p_key_version,
      // p_settings_key_version and p_vault_key_version, which record which key
      // sealed the rest, and p_vault_salt, which is public by design. Every
      // other value is ciphertext, the number format included: it goes through
      // encryptOrgSettings like every other settings field, so the server
      // never sees it. The org id is generated server side and returned.
      const { data: newOrgId, error: rpcError } = await (supabase as any).rpc(
        'create_org_for_current_user',
        {
          p_org_name: encOrgName,
          p_key_version: FIELD_KEY_VERSION,
          p_settings_primary_currency: encSettings.primary_currency,
          p_settings_secondary_currency: encSettings.secondary_currency,
          p_settings_bitcoin_display: encSettings.bitcoin_display,
          p_settings_fiscal_year_type: encSettings.fiscal_year_type,
          p_settings_encrypted_fiscal_month: encSettings.encrypted_fiscal_month,
          p_settings_date_format: encSettings.date_format,
          p_settings_time_format: encSettings.time_format,
          p_settings_number_format: encSettings.number_format,
          p_settings_timezone: encSettings.timezone,
          p_settings_key_version: encSettings.key_version,
          p_vault_verifier: vaultSetup.verifier,
          p_vault_salt: vaultSetup.vaultSalt,
          p_vault_key_version: vaultSetup.vaultKeyVersion,
          p_enc_mek_ciphertext: vaultSetup.encMekCiphertext,
          p_recovery_ciphertext: vaultSetup.recoveryCiphertext,
        },
      );
      if (rpcError) throw rpcError;
      const orgId = newOrgId as string;

      // 4. Seed the chart of accounts in the background (v1 parity): mark the
      // org provisioning, dispatch initChartOfAccounts fire-and-forget, and let
      // the user into the app immediately. The IIFE closes over encryptText,
      // which keeps working after this surface unmounts because the MEK lives
      // in VaultContext.
      await supabase
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
          await supabase
            .from('organizations')
            .update({ ledger_status: 'ready', ledger_status_error: null })
            .eq('id', orgId);
          toast.success('Chart of accounts ready', { id: coaToast, duration: 3000 });
        } catch (coaErr) {
          const errMsg = coaErr instanceof Error ? coaErr.message : String(coaErr);
          console.error('Chart of accounts seeding failed:', coaErr);
          captureException(coaErr, { tags: { source: 'onboarding-v2-coa-seed' } });
          await supabase
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
      ) : screen === 1 ? (
        <StepShell
          title="Your currencies"
          onNext={() => setScreen(2)}
          onBack={() => setScreen(0)}
          isFirst={false}
          isLast={false}
          nextLabel="Continue"
          nextDisabled={!currencyValid}
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
      ) : (
        <StepShell
          title="Your fiscal year"
          onNext={handleFinish}
          onBack={() => setScreen(1)}
          isFirst={false}
          isLast
          nextLabel="Open my books"
          nextDisabled={saving}
        >
          <p className="mb-6">
            Your fiscal year start decides every period boundary in your books, and your timezone
            decides which day a transaction lands on. Both can be changed later in Admin settings.
          </p>
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="fiscal-year-start">Fiscal year starts</Label>
              <select
                id="fiscal-year-start"
                className={selectClass}
                value={fiscalYearStart}
                onChange={(e) => setFiscalYearStart(e.target.value)}
              >
                {MONTH_NAMES.map((m) => (
                  <option key={m} value={m.toLowerCase()}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="timezone">Timezone</Label>
              <select
                id="timezone"
                className={selectClass}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </StepShell>
      )}
    </div>
  );
}
