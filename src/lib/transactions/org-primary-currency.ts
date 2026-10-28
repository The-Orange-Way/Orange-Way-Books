/**
 * The org's primary (functional) currency, read at save time.
 *
 * Every journal entry line is priced from its wallet currency into the
 * ORG's primary currency. A save path must not use the picked wallet's
 * currency for that, and must not fall back to a default while settings are
 * still loading: either would price the line against the wrong currency and
 * the books would carry it silently. So this reads org_settings directly and
 * refuses when the primary currency cannot be read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptOrgSettings } from '../crypto-fields';

type DecryptFn = (ciphertext: string) => Promise<string>;

export const ORG_PRIMARY_UNAVAILABLE =
  "Could not read this organization's primary currency, so nothing was saved. " +
  'Please refresh the page and try again.';

export class OrgPrimaryCurrencyError extends Error {
  constructor() {
    super(ORG_PRIMARY_UNAVAILABLE);
    this.name = 'OrgPrimaryCurrencyError';
  }
}

export async function loadOrgPrimaryCurrency(
  client: SupabaseClient,
  orgId: string,
  decryptText: DecryptFn,
): Promise<string> {
  const { data, error } = await client
    .from('org_settings')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new OrgPrimaryCurrencyError();
  const settings = await decryptOrgSettings(data, decryptText);
  const primary = (settings.primary_currency ?? '').trim().toUpperCase();
  if (!primary) throw new OrgPrimaryCurrencyError();
  return primary;
}
