export type BucketGranularity = 'DAY' | 'FIVE_MINUTES';

export function startOfUtcDay(date: Date | string): Date {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function floorToFiveMinutesUtc(date: Date | string): Date {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  const five = 5 * 60 * 1000;
  return new Date(Math.floor(d.getTime() / five) * five);
}

export function bucketFor(date: Date | string, granularity: BucketGranularity): Date {
  return granularity === 'DAY' ? startOfUtcDay(date) : floorToFiveMinutesUtc(date);
}

/** Free tier always returns DAY; pro tier (future) returns FIVE_MINUTES for crypto pairs. */
export function granularityForPair(_base: string, _quote: string): BucketGranularity {
  return 'DAY';
}

export function bucketTsToIso(bucket: Date): string {
  return bucket.toISOString();
}
