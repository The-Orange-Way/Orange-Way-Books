import type { BitcoinDisplay } from '@/types';
import { formatCrypto, formatFiat } from '@/lib/formatters';
import { isCrypto } from '@/lib/exchange/currency-registry';
import { cn } from '@/lib/utils';

export interface AmountDisplayProps {
  amount: number;
  asset: string;
  displayMode?: BitcoinDisplay;
  showCurrency?: boolean;
  className?: string;
}

export function AmountDisplay({
  amount,
  asset,
  displayMode = 'sats',
  showCurrency = false,
  className,
}: AmountDisplayProps) {
  const formatted = isCrypto(asset) ? formatCrypto(amount, displayMode) : formatFiat(amount, asset);

  return (
    <span className={cn('tabular-nums', isCrypto(asset) && 'font-mono', className)}>
      {formatted}
      {showCurrency && !isCrypto(asset) && (
        <span className="ml-1 text-muted-foreground text-xs">{asset}</span>
      )}
    </span>
  );
}
