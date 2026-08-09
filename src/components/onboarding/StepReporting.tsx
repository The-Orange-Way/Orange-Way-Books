import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { BarChart3 } from 'lucide-react';
import type { BitcoinDisplay } from '@/types';
import { getAllCurrencies } from '@/lib/exchange';

const secondaryCurrencies = [
  { value: 'none', label: 'None' },
  ...getAllCurrencies().map((c) => ({
    value: c.code,
    label: `${c.code} - ${c.name}`,
  })),
];

const btcDisplayOptions: { value: BitcoinDisplay; label: string }[] = [
  { value: 'btc', label: 'BTC 1.50000000' },
  { value: 'btc-easy', label: 'BTC 0.00 050 000' },
  { value: 'sats', label: '⚡ 1,500,000' },
  { value: 'bitcoins', label: '₿ 1,500,000' },
];

interface ReportingData {
  secondaryCurrency: string;
  secondaryBitcoinDisplay: BitcoinDisplay;
  numberFormat: 'US' | 'EU';
  dateFormat: string;
  timeFormat: string;
  timezone: string;
}

interface Props {
  data: ReportingData;
  onChange: (d: ReportingData) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function StepReporting({ data, onChange, onNext, onBack }: Props) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <BarChart3 className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold text-card-foreground">Reporting Preferences</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Choose your secondary display currency and number format for reports.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Secondary Currency</Label>
          <Select
            value={data.secondaryCurrency}
            onValueChange={(v) => onChange({ ...data, secondaryCurrency: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {secondaryCurrencies.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {data.secondaryCurrency === 'BTC' && (
          <div className="space-y-2 pl-1">
            <Label>Bitcoin Display Preference</Label>
            <RadioGroup
              value={data.secondaryBitcoinDisplay}
              onValueChange={(v) =>
                onChange({ ...data, secondaryBitcoinDisplay: v as BitcoinDisplay })
              }
              className="space-y-1.5"
            >
              {btcDisplayOptions.map((o) => (
                <div key={o.value} className="flex items-center gap-2">
                  <RadioGroupItem value={o.value} id={`btc-secondary-${o.value}`} />
                  <Label
                    htmlFor={`btc-secondary-${o.value}`}
                    className="font-mono text-sm cursor-pointer"
                  >
                    {o.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}

        <div className="space-y-2">
          <Label>Number Format</Label>
          <RadioGroup
            value={data.numberFormat}
            onValueChange={(v) => onChange({ ...data, numberFormat: v as 'US' | 'EU' })}
            className="space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="US" id="fmt-us" />
              <Label htmlFor="fmt-us" className="cursor-pointer">
                US / Standard{' '}
                <span className="font-mono text-xs text-muted-foreground ml-1">1,250.00</span>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="EU" id="fmt-eu" />
              <Label htmlFor="fmt-eu" className="cursor-pointer">
                EU / International{' '}
                <span className="font-mono text-xs text-muted-foreground ml-1">1.250,00</span>
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label>Date Format</Label>
          <RadioGroup
            value={data.dateFormat}
            onValueChange={(v) => onChange({ ...data, dateFormat: v })}
            className="space-y-1.5"
          >
            {[
              { value: 'MM-DD-YYYY', label: 'MM-DD-YYYY' },
              { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY' },
              { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
            ].map((o) => (
              <div key={o.value} className="flex items-center gap-2">
                <RadioGroupItem value={o.value} id={`df-${o.value}`} />
                <Label htmlFor={`df-${o.value}`} className="cursor-pointer font-mono text-sm">
                  {o.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label>Time Format</Label>
          <RadioGroup
            value={data.timeFormat}
            onValueChange={(v) => onChange({ ...data, timeFormat: v })}
            className="space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="12h" id="tf-12" />
              <Label htmlFor="tf-12" className="cursor-pointer">
                12-hour clock
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="24h" id="tf-24" />
              <Label htmlFor="tf-24" className="cursor-pointer">
                24-hour clock
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label>Timezone</Label>
          <Select value={data.timezone} onValueChange={(v) => onChange({ ...data, timezone: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                { value: 'America/New_York', label: 'Eastern Time (US)' },
                { value: 'America/Chicago', label: 'Central Time (US)' },
                { value: 'America/Denver', label: 'Mountain Time (US)' },
                { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
                { value: 'America/Toronto', label: 'Toronto (Eastern)' },
                { value: 'America/Vancouver', label: 'Vancouver (Pacific)' },
                { value: 'Europe/London', label: 'London (GMT)' },
                { value: 'Europe/Paris', label: 'Paris (CET)' },
                { value: 'Europe/Berlin', label: 'Berlin (CET)' },
                { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
                { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
                { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
                { value: 'Pacific/Auckland', label: 'Auckland (NZST)' },
              ].map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button type="button" onClick={onNext} className="flex-1">
          Continue
        </Button>
      </div>
    </div>
  );
}
