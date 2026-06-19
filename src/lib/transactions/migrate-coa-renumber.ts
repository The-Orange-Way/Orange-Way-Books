/**
 * Chart-of-accounts renumber + rename migrations (client-side).
 *
 * Two independent waves of structural changes to the seed chart shipped
 * over the life of OWB. Each runs idempotently on the user's existing
 * accounts when this module is invoked.
 *
 *   Wave 1 — code 1500 housekeeping (shipped 2026-05-21):
 *     Equipment           1500 → 1600
 *     Other Assets        1600 → 1700
 *     The free 1500 slot is later claimed by the system Transfer
 *     Clearing account on first use.
 *
 *   Wave 2 — chart polish (this module, latest revision):
 *     Inventory           1300 → 1305          (frees 1300 for Prepaid Expenses)
 *     Equity              3000 → "Owner's Equity"   (rename, code unchanged)
 *     Owner's Equity      3100 → "Starting Balance" (rename, code unchanged)
 *     Income              4000 → "Sales"            (rename, code unchanged)
 *     Cost of Goods Sold  5100 → 5000               (renumber upward)
 *     Generic "Expenses" header at 5000 is left in place if a user has
 *     posted to it; new orgs simply don't seed it anymore.
 *
 * Why client-side and not a Supabase SQL migration:
 *
 *   Under OWB's encrypted chart, the on-disk `account_code` and
 *   `account_name` columns carry anonymized placeholders — the real
 *   codes and names live inside the encrypted columns. A server-side
 *   migration cannot read them without breaking the zero-knowledge
 *   guarantee. The only place the plaintext is available is the
 *   client, after MEK unwrap, so the migration has to run there.
 *
 * Safety rules common to both waves:
 *
 *   - Each step matches on the (oldCode, oldName) pair so a user-renamed
 *     account at the same code is never touched.
 *   - Pure renumbers re-encrypt with a new code, same name.
 *   - Pure renames re-encrypt with a new name, same code.
 *   - 3100 must be renamed BEFORE 3000 so the new name on 3000 doesn't
 *     collide with the previous 3100 row.
 *   - If a different row already occupies the destination code, the
 *     step is skipped silently — we never overwrite user data.
 *   - Re-running is a no-op.
 *
 * Only ciphertext leaves the client. Wave 1 fires from
 * `ensureTransferClearingAccount`; Wave 2 fires from the chart-of-
 * accounts loader on next mount.
 *
 * Implemented in-house for OWB.
 */

import { supabase } from '@/lib/supabase';
import {
  decryptChartOfAccount,
  encryptChartOfAccount,
} from '@/lib/crypto-fields';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

// Wave 1: renumber + (implicit) keep-name pairs.
const WAVE_1_PAIRS: Array<{ fromCode: string; toCode: string; name: string }> = [
  // Order matters: shift Other Assets out of 1600 BEFORE Equipment moves into 1600.
  { fromCode: '1600', toCode: '1700', name: 'Other Assets' },
  { fromCode: '1500', toCode: '1600', name: 'Equipment' },
];

/**
 * Wave 2 migration steps. Each step matches a row on its CURRENT (old) code
 * + (old) name, then writes back the (new) code + (new) name.
 *
 * The four rename steps under "Equity" run in a specific order so that the
 * intermediate state never has two rows that decrypt to the same name on the
 * same org — clean-room safe against any future unique-by-name index.
 */
interface Wave2Step {
  /** Decrypted code on the existing row. */
  fromCode: string;
  /** Decrypted name on the existing row. */
  fromName: string;
  /** Code to write back. */
  toCode: string;
  /** Name to write back. */
  toName: string;
}

const WAVE_2_STEPS: Wave2Step[] = [
  // 1. Inventory pure renumber 1300 → 1305 (frees 1300 for Prepaid).
  //    Must run BEFORE any future seed that creates 1300=Prepaid; the
  //    onboarding wizard always seeded 1300=Inventory so an org that
  //    has never been touched will hit this step.
  { fromCode: '1300', fromName: 'Inventory', toCode: '1305', toName: 'Inventory' },

  // 2. 3100 "Owner's Equity" → "Starting Balance" (rename, code unchanged).
  //    Runs BEFORE 3000 rename so we never have two rows decrypting to
  //    "Owner's Equity" at the same time.
  { fromCode: '3100', fromName: "Owner's Equity", toCode: '3100', toName: 'Starting Balance' },

  // 3. 3000 "Equity" → "Owner's Equity" (rename, code unchanged).
  { fromCode: '3000', fromName: 'Equity', toCode: '3000', toName: "Owner's Equity" },

  // 4. 4000 "Income" → "Sales" (rename, code unchanged).
  { fromCode: '4000', fromName: 'Income', toCode: '4000', toName: 'Sales' },

  // 5. 5100 "Cost of Goods Sold" → 5000 (renumber up to the canonical COGS slot).
  //    The existing 5000 "Expenses" generic header is left in place for
  //    safety — if it collides with this step, we skip and the user can
  //    rename/archive it manually. New orgs from the updated seed don't
  //    get the generic 5000 row anymore.
  { fromCode: '5100', fromName: 'Cost of Goods Sold', toCode: '5000', toName: 'Cost of Goods Sold' },
];

type DecodedRow = {
  row: any;
  name: string;
  code: string | null;
  type: string;
  group: string | null;
  category: string | null;
  is_archived: boolean;
};

async function loadDecodedRows(orgId: string, decryptText: DecryptFn): Promise<DecodedRow[]> {
  const { data: rows, error } = await supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const decoded: DecodedRow[] = [];
  for (const row of rows as any[]) {
    try {
      const f = await decryptChartOfAccount(row, decryptText);
      decoded.push({
        row,
        name: (f.account_name | '').trim(),
        code: f.account_code,
        type: f.account_type,
        group: f.account_group,
        category: f.account_category,
        is_archived: f.is_archived,
      });
    } catch {
      // Undecryptable row — skip silently. We'll never touch what we can't read.
    }
  }
  return decoded;
}

export async function migrateEquipmentTransferClearingCodes(
  orgId: string,
  encryptText: EncryptFn,
  decryptText: DecryptFn,
): Promise<{ updated: number }> {
  const decoded = await loadDecodedRows(orgId, decryptText);
  if (decoded.length === 0) return { updated: 0 };

  let updated = 0;
  for (const pair of WAVE_1_PAIRS) {
    const target = decoded.find(
      (d) =>
        d.name.toLowerCase() === pair.name.toLowerCase() &&
        d.code === pair.fromCode,
    );
    if (!target) continue;

    // Sanity: do not overwrite if a different row already owns the toCode
    // (some org may have user-created their own account there).
    const collision = decoded.find(
      (d) => d.row.id !== target.row.id && d.code === pair.toCode,
    );
    if (collision) {
      // Skip silently — we never destroy user data. The Transfer Clearing
      // helper will fall back to its existing find-or-create path.
      continue;
    }

    const enc = await encryptChartOfAccount(
      {
        account_name: pair.name,
        account_code: pair.toCode,
        account_type: target.type,
        account_group: target.group,
        account_category: target.category,
        is_archived: target.is_archived,
      },
      encryptText,
    );
    const { error: updErr } = await supabase
      .from('chart_of_accounts')
      .update(enc as any)
      .eq('id', target.row.id);
    if (updErr) throw updErr;

    // Mirror the change into our in-memory decoded array so subsequent
    // WAVE_1_PAIRS iterations see the new code (prevents the same row
    // being shifted twice in a multi-step rename).
    target.code = pair.toCode;
    updated += 1;
  }

  return { updated };
}

/**
 * Wave 2: rename + renumber the default chart to match the canonical layout.
 *
 * Idempotent. Safe to call on already-migrated orgs (no-op). Safe to call
 * on un-onboarded orgs (no rows = no-op). Refuses to overwrite a row owned
 * by something else at the destination code/name.
 *
 * Invocation: lazy from the chart-of-accounts loader on next dashboard
 * mount, same pattern as Wave 1's hook into ensureTransferClearingAccount.
 */
export async function migrateCoaWave2(
  orgId: string,
  encryptText: EncryptFn,
  decryptText: DecryptFn,
): Promise<{ updated: number; skipped: number }> {
  const decoded = await loadDecodedRows(orgId, decryptText);
  if (decoded.length === 0) return { updated: 0, skipped: 0 };

  let updated = 0;
  let skipped = 0;

  for (const step of WAVE_2_STEPS) {
    const target = decoded.find(
      (d) =>
        d.code === step.fromCode &&
        d.name.toLowerCase() === step.fromName.toLowerCase(),
    );
    if (!target) continue;

    // Collision check applies when the code is actually changing. For a
    // pure rename (toCode === fromCode), the target row itself owns the
    // code and there can't be a collision with itself.
    if (step.toCode !== step.fromCode) {
      const codeCollision = decoded.find(
        (d) => d.row.id !== target.row.id && d.code === step.toCode,
      );
      if (codeCollision) {
        skipped += 1;
        continue;
      }
    }

    // Name collision: refuse to land if another row already decrypts to the
    // new name. Protects against duplicating user-renamed accounts.
    const nameCollision = decoded.find(
      (d) =>
        d.row.id !== target.row.id &&
        d.name.toLowerCase() === step.toName.toLowerCase(),
    );
    if (nameCollision) {
      skipped += 1;
      continue;
    }

    const enc = await encryptChartOfAccount(
      {
        account_name: step.toName,
        account_code: step.toCode,
        account_type: target.type,
        account_group: target.group,
        account_category: target.category,
        is_archived: target.is_archived,
      },
      encryptText,
    );
    const { error: updErr } = await supabase
      .from('chart_of_accounts')
      .update(enc as any)
      .eq('id', target.row.id);
    if (updErr) throw updErr;

    // Mirror the change into our in-memory decoded array so subsequent
    // steps see the new code + name (3100 rename must complete before
    // 3000 rename can match without colliding on the "Owner's Equity"
    // name).
    target.code = step.toCode;
    target.name = step.toName;
    updated += 1;
  }

  return { updated, skipped };
}
