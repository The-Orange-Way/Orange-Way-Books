import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ManualRate } from '@/lib/exchange/build-je-line-insert';

const RATE_SOURCES = [
  'OANDA.com',
  'CPA-quoted',
  'Spot rate from bank',
  'Exchange rate from invoice',
  'Other',
] as const;

const REASON_MIN_LENGTH = 40;

interface ManualRateDialogProps {
  open: boolean;
  onClose: () => void;
  /** The wallet (transaction) currency, e.g. "MXN" */
  walletCurrency: string;
  /** The primary (functional) currency, e.g. "BTC" */
  primaryCurrency: string;
  /** The journal entry date (YYYY-MM-DD) */
  date: string;
  onConfirm: (rate: ManualRate) => void;
}

export function ManualRateDialog({
  open, onClose, walletCurrency, primaryCurrency, date, onConfirm,
}: ManualRateDialogProps) {
  const [rateInput, setRateInput] = useState('');
  const [source, setSource] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reasonRemaining = Math.max(0, REASON_MIN_LENGTH - reason.length);
  const rateValue = parseFloat(rateInput.replace(/,/g, ''));

  const handleConfirm = () => {
    setError(null);
    if (!rateInput || !Number.isFinite(rateValue) || rateValue <= 0) {
      setError('Enter a valid positive exchange rate.');
      return;
    }
    if (!source) {
      setError('Select a rate source.');
      return;
    }
    if (reason.length < REASON_MIN_LENGTH) {
      setError(`Reason must be at least ${REASON_MIN_LENGTH} characters (${reasonRemaining} more needed).`);
      return;
    }
    onConfirm({ rate: rateValue, reason, source });
    // Reset for next open
    setRateInput(''); setSource(''); setReason(''); setError(null);
  };

  const handleClose = () => {
    setRateInput(''); setSource(''); setReason(''); setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enter Exchange Rate Manually</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          The automatic rate for <strong>{walletCurrency} → {primaryCurrency}</strong> on{' '}
          <strong>{date}</strong> could not be fetched. Enter the rate from a reliable source.{' '}
          <a
            href="/docs/OWB-MultiCurrency-Brain.md#9-edge-cases"
            className="underline text-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            Why is this required?
          </a>
        </p>

        <div className="space-y-4 pt-2">
          <div className="space-y-1">
            <Label htmlFor="manual-rate-value">
              1 {walletCurrency} = ? {primaryCurrency}
            </Label>
            <Input
              id="manual-rate-value"
              type="text"
              inputMode="decimal"
              placeholder={`e.g. 0.00000090`}
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="manual-rate-source">Rate source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="manual-rate-source">
                <SelectValue placeholder="Select source…" />
              </SelectTrigger>
              <SelectContent>
                {RATE_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="manual-rate-reason">
              Reason{' '}
              <span className="text-muted-foreground font-normal">
                ({reasonRemaining > 0 ? `${reasonRemaining} more chars needed` : 'minimum met'})
              </span>
            </Label>
            <Textarea
              id="manual-rate-reason"
              rows={3}
              placeholder="Describe why this rate was used, e.g. 'OXR historical API unavailable for this date; used OANDA historical rate from their public chart on 2026-04-17.'"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Minimum {REASON_MIN_LENGTH} characters — required for audit compliance (IAS 21 / ASC 830).
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button onClick={handleConfirm}>Confirm Rate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
