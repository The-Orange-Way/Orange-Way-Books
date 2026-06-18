import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Building2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { BitcoinDisplay } from '@/types';

const currencies = [
  { value: 'BTC', label: 'BTC — Bitcoin' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
];

const btcDisplayOptions: { value: BitcoinDisplay; label: string }[] = [
  { value: 'btc', label: 'BTC 1.50000000' },
  { value: 'btc-easy', label: 'BTC 0.00 050 000' },
  { value: 'sats', label: '⚡ 1,500,000' },
  { value: 'bitcoins', label: '₿ 1,500,000' },
];

interface OrgData {
  name: string;
  primaryCurrency: string;
  bitcoinDisplay: BitcoinDisplay;
}

interface Props {
  data: OrgData;
  onChange: (d: OrgData) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function StepOrganization({ data, onChange, onNext, onBack }: Props) {
  const isValid = data.name.trim().length > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <Building2 className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold text-card-foreground">Your Organization</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Name your company or entity. You can change this later in Admin settings.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org-name">Organization Name</Label>
          <Input
            id="org-name"
            placeholder="e.g. Satoshi Holdings Ltd"
            value={data.name}
            onChange={(e) => onChange({ ...data, name: e.target.value })}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label>Primary Accounting Currency</Label>
          <Select
            value={data.primaryCurrency}
            onValueChange={(v) => onChange({ ...data, primaryCurrency: v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {currencies.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {data.primaryCurrency === 'BTC' && (
          <div className="space-y-2 pl-1">
            <Label>Bitcoin Display Preference</Label>
            <RadioGroup
              value={data.bitcoinDisplay}
              onValueChange={(v) => onChange({ ...data, bitcoinDisplay: v as BitcoinDisplay })}
              className="space-y-1.5"
            >
              {btcDisplayOptions.map((o) => (
                <div key={o.value} className="flex items-center gap-2">
                  <RadioGroupItem value={o.value} id={`btc-primary-${o.value}`} />
                  <Label htmlFor={`btc-primary-${o.value}`} className="font-mono text-sm cursor-pointer">
                    {o.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack} className="flex-1">Back</Button>
        <Button type="button" onClick={onNext} disabled={!isValid} className="flex-1">Continue</Button>
      </div>
    </div>
  );
}
