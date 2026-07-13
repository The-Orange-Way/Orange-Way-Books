import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TERMS_VERSION,
  WITHDRAWAL_CONSENT_HELPER,
  WITHDRAWAL_CONSENT_LABEL,
  WITHDRAWAL_CONSENT_UNTICKED_HINT,
} from '../withdrawal-consent';

// The edge function runs in Deno and is bundled from supabase/functions, so it
// cannot import this module. It keeps its own copy of the two constants that
// end up in the evidence row, and the server copy is the one that gets stored.
// We read it as text rather than importing it, because a Deno module is not
// loadable from a Vite test run.
const SERVER_CONSTANTS_PATH = new URL(
  '../../../supabase/functions/_shared/withdrawal-consent.ts',
  import.meta.url,
);

function serverConstant(name: string): string {
  const source = readFileSync(SERVER_CONSTANTS_PATH, 'utf8');
  const match = source.match(new RegExp(`export const ${name} =\\s*'([^']*)'`));
  if (!match) {
    throw new Error(`${name} not found in the edge function consent constants`);
  }
  return match[1];
}

describe('withdrawal consent copy', () => {
  it('pins the legally reviewed label exactly', () => {
    // If this fails you are changing a legal claim. Get a fresh review and
    // bump TERMS_VERSION in the same change, or old records stop matching
    // the text the customer actually agreed to.
    expect(WITHDRAWAL_CONSENT_LABEL).toBe(
      'Start my Orange Way Books subscription now. I understand that by asking it to start now, I give up the 14 day right to withdraw (cancel) that EU and UK consumer law gives consumers.',
    );
  });

  it('carries both required elements: request to start now, and loss of the right', () => {
    expect(WITHDRAWAL_CONSENT_LABEL).toContain('Start my Orange Way Books subscription now');
    expect(WITHDRAWAL_CONSENT_LABEL).toContain('I give up the 14 day right to withdraw');
  });

  it('keeps the helper and the unticked hint out of the stored string', () => {
    // These two are comfort copy, reworded freely. They must never become
    // part of the evidence, or a copy tweak silently rewrites a consent row.
    expect(WITHDRAWAL_CONSENT_LABEL).not.toContain(WITHDRAWAL_CONSENT_HELPER);
    expect(WITHDRAWAL_CONSENT_LABEL).not.toContain(WITHDRAWAL_CONSENT_UNTICKED_HINT);
  });

  it('stamps a dated terms version', () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stores exactly what the customer reads: server label matches the rendered label', () => {
    // The label on screen comes from this module. The label written into
    // consent_text comes from the edge function's copy. If they ever differ,
    // the record no longer proves what the customer saw, so this is a
    // blocking failure, not a style nit.
    expect(serverConstant('WITHDRAWAL_CONSENT_LABEL')).toBe(WITHDRAWAL_CONSENT_LABEL);
  });

  it('keeps the terms version in step on both sides', () => {
    expect(serverConstant('TERMS_VERSION')).toBe(TERMS_VERSION);
  });
});
