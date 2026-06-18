/**
 * DestinationAccountChips — Phase 3 chips showing where each source wallet lands.
 *
 * Renders entries like "BTC → Bitcoin Cold Storage · USD → USD Operating".
 * Both currency and account name come from already-decrypted data; this is a
 * pure presentational component.
 */

interface ChipEntry {
  /** Plaintext currency label (BTC, USD, …). */
  currency: string;
  /** Plaintext destination account name, or null when unrouted. */
  accountName: string | null;
}

interface DestinationAccountChipsProps {
  entries: ChipEntry[];
}

export function DestinationAccountChips({ entries }: DestinationAccountChipsProps) {
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((e, idx) => (
        <span
          key={`${e.currency}-${idx}`}
          className="inline-flex items-center rounded border border-input bg-muted/30 px-1.5 py-0.5 text-[10px] tracking-wide"
        >
          <span className="font-semibold uppercase mr-1">{e.currency}</span>
          <span className="text-muted-foreground">→</span>
          <span className="ml-1 truncate max-w-[160px]">
            {e.accountName ?? <span className="italic text-muted-foreground">unrouted</span>}
          </span>
        </span>
      ))}
    </div>
  );
}
