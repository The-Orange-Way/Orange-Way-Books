import { useState } from 'react';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BitcoinDisplay } from '@/types';
import StepReporting from '../StepReporting';

vi.mock('@/lib/timezones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/timezones')>()),
  browserTimezone: () => 'Europe/Madrid',
}));

// Radix Select needs browser pointer APIs that jsdom does not implement. This
// native-select stand-in preserves the value/change contract and renders the
// real option list, which is the behavior this regression exercises.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

interface ReportingData {
  secondaryCurrency: string;
  secondaryBitcoinDisplay: BitcoinDisplay;
  numberFormat: 'US' | 'EU';
  dateFormat: string;
  timeFormat: string;
  timezone: string;
}

function Harness() {
  const [data, setData] = useState<ReportingData>({
    secondaryCurrency: 'none',
    secondaryBitcoinDisplay: 'btc',
    numberFormat: 'US',
    dateFormat: 'MM-DD-YYYY',
    timeFormat: '12h',
    timezone: 'Europe/Madrid',
  });

  return <StepReporting data={data} onChange={setData} onNext={() => {}} onBack={() => {}} />;
}

describe('StepReporting timezone picker (OWB-T0152)', () => {
  it('keeps the browser-detected zone after a curated zone is selected', () => {
    render(<Harness />);
    const timezone = screen.getAllByRole('combobox')[1];

    expect(within(timezone).getByRole('option', { name: 'Europe/Madrid (detected)' })).toBeTruthy();

    fireEvent.change(timezone, { target: { value: 'America/Chicago' } });

    expect(timezone).toHaveValue('America/Chicago');
    expect(within(timezone).getByRole('option', { name: 'Europe/Madrid (detected)' })).toBeTruthy();
  });
});
