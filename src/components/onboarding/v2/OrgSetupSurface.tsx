import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepShell } from './onboarding-flow';
import {
  getFiatCurrencies,
  getCryptoCurrencies,
  getSymbol,
} from '@/lib/exchange/currency-registry';

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

export default function OrgSetupSurface({ onComplete }: OrgSetupSurfaceProps) {
  const [screen, setScreen] = useState<0 | 1>(0);

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
          onNext={onComplete}
          onBack={() => setScreen(0)}
          isFirst={false}
          isLast
          nextLabel="Open my books"
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
      )}
    </div>
  );
}
