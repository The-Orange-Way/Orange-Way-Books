/**
 * OrgSetupSurface, the DL-0718 post-onboarding org setup surface, slice 2.
 *
 * These assertions are the DL-0718 brief's gate, and the Bitcoin one is the
 * DEC-0281 conditional the Auditor asked to see:
 *   - the CTA is disabled with no primary currency and enables once one is set;
 *   - the CTA is enabled with the secondary currency left empty (DEC-0282);
 *   - the Bitcoin display block renders while either picker is BTC and not
 *     while neither is (DEC-0281).
 *
 * The pickers are native select elements, so a currency change is a plain
 * fireEvent.change and needs none of the pointer polyfills a Radix listbox
 * would require and this repo's vitest setup does not provide.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OrgSetupSurface from '../OrgSetupSurface';

// Screen 1 is the organization name; a non-blank name is required before the
// Continue button advances to the currency screen.
function renderAtCurrencyScreen() {
  const onComplete = vi.fn();
  render(<OrgSetupSurface onComplete={onComplete} />);
  fireEvent.change(screen.getByLabelText('Organization Name'), {
    target: { value: 'Satoshi Holdings Ltd' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return { onComplete };
}

describe('OrgSetupSurface screen 1 (organization name)', () => {
  it('keeps Continue disabled until a non-blank name is entered', () => {
    render(<OrgSetupSurface onComplete={vi.fn()} />);
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

  it('fires onComplete once when "Open my books" is pressed with a valid primary', () => {
    const { onComplete } = renderAtCurrencyScreen();
    fireEvent.change(screen.getByLabelText('Primary currency'), {
      target: { value: 'BTC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open my books' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
