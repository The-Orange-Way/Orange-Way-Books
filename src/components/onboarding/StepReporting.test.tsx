import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StepReporting from './StepReporting';
import type { BitcoinDisplay } from '@/types';

interface ReportingData {
  secondaryCurrency: string;
  secondaryBitcoinDisplay: BitcoinDisplay;
  numberFormat: 'US' | 'EU';
  dateFormat: string;
  timeFormat: string;
  timezone: string;
}

function baseData(timezone: string): ReportingData {
  return {
    secondaryCurrency: 'none',
    secondaryBitcoinDisplay: 'btc',
    numberFormat: 'US',
    dateFormat: 'MM-DD-YYYY',
    timeFormat: '12h',
    timezone,
  };
}

beforeAll(() => {
  // Radix Select relies on a few DOM APIs jsdom does not implement.
  // Without these the trigger never opens in a test environment.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

describe('StepReporting timezone picker', () => {
  it('keeps the detected zone in the list after picking a curated zone', () => {
    // Europe/Madrid is not one of the thirteen curated TIMEZONE_OPTIONS,
    // so it only appears because timezoneOptionsIncluding prepends it.
    const detected = 'Europe/Madrid';
    let data = baseData(detected);
    const onChange = (d: ReportingData) => {
      data = d;
    };

    const { rerender } = render(
      <StepReporting data={data} onChange={onChange} onNext={() => {}} onBack={() => {}} />
    );

    // Selecting a curated zone re-renders the component with the new
    // value, exactly as OnboardingWizard does on a real onChange.
    data = { ...data, timezone: 'America/Chicago' };
    rerender(
      <StepReporting data={data} onChange={onChange} onNext={() => {}} onBack={() => {}} />
    );

    fireEvent.click(screen.getByTestId('onboarding-timezone'));

    expect(screen.getByText(`${detected} (detected)`)).toBeInTheDocument();
  });
});
