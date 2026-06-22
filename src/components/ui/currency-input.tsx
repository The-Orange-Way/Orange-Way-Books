import * as React from 'react';
import { Input } from '@/components/ui/input';
import { getCurrency } from '@/lib/exchange/currency-registry';
import { cn } from '@/lib/utils';

export interface CurrencyInputProps {
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function getSymbol(currency: string): string {
  return getCurrency(currency)?.symbol ?? currency;
}

/** Strips everything except digits, a single decimal point, and a leading minus. */
function sanitize(raw: string): string {
  let result = '';
  let hasDecimal = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '-' && i === 0) {
      result += ch;
    } else if (ch === '.' && !hasDecimal) {
      hasDecimal = true;
      result += ch;
    } else if (ch >= '0' && ch <= '9') {
      result += ch;
    }
  }
  return result;
}

const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(function CurrencyInput(
  { value, onChange, currency = 'USD', placeholder, disabled, className },
  ref,
) {
  const symbol = getSymbol(currency);

  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(sanitize(e.target.value));
    },
    [onChange],
  );

  return (
    <div className={cn('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
        {symbol}
      </span>
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        className="pl-8"
      />
    </div>
  );
});
CurrencyInput.displayName = 'CurrencyInput';

export { CurrencyInput };
