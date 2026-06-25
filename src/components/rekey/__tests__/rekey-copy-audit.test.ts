/**
 * @vitest-environment node
 *
 * Phase 4.5 polish — customer-facing copy audit.
 *
 * The D31 copy pass replaces every customer-facing use of "rotate" /
 * "rotation" with "refresh" wording (customer phrase: "banks rotate
 * keys; customers refresh"). This test is a grep-guard so a future
 * edit that re-introduces "rotate" into the three UI files will fail
 * the suite.
 *
 * Scope: JSX text nodes and string literals inside the three sweep
 * files. We intentionally EXCLUDE:
 *   - Code comments (`//` and `slash-star ... star-slash`)
 *   - Identifier-only occurrences inside imports / type-only code
 *     (`RekeyStage` is a type ident, not user copy — but we look for
 *     the lowercase `rotate`/`rotation`, which these don't contain)
 *   - Substring hits inside attribute names like `data-rotate` (none
 *     exist in the codebase today; guarded for defense-in-depth)
 *
 * The test lives next to RekeyWizard.tsx so a future contributor
 * adding new copy in the same directory trips this check promptly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UI_FILES = [
  'src/components/rekey/RekeyWizard.tsx',
  'src/components/rekey/MaintenanceBanner.tsx',
  'src/pages/settings/Security.tsx',
];

/**
 * Strip every line-comment and block-comment from a TypeScript / TSX
 * source file. We don't use a real parser — a regex pass is good
 * enough for this audit because our files use standard comment
 * syntax without exotic string-embedded delimiters.
 */
function stripComments(source: string): string {
  return (
    source
      // block comments /* ... */ (possibly multi-line)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // line comments // ...
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

describe('Phase 4.5 copy audit — no "rotate"/"rotation" in customer-facing strings', () => {
  for (const relPath of UI_FILES) {
    it(`${relPath} contains no user-visible "rotate" or "rotation"`, () => {
      const absPath = resolve(process.cwd(), relPath);
      const source = readFileSync(absPath, 'utf8');
      const stripped = stripComments(source);

      // Allow-list identifiers: code symbols stay in the rotate /
      // rotation vernacular per the task's hard rule. These are NOT
      // customer-visible strings. Matching is case-sensitive so we
      // still catch "Rotate" in user copy.
      const ALLOWED_IDENTIFIERS = [
        // Table names + columns
        'key_rotation_jobs',
        'last_rotated_at',
        'rotation_history',
        'advance_rotation_job',
        'setLastRotatedAt',
        'lastRotatedAt',
        // Type names + interfaces
        'RotationJobSummary',
        // Lucide icon import
        'RotateCcw',
        // Audit event names
        'rekey.status_changed',
        // Supabase realtime channel prefix
        'key-rotation-',
        // Data attributes (no known hits today; guard for future)
        'data-rotate',
      ];

      // Build a single stripping regex out of the identifier list so
      // any occurrence of an allowed token gets blanked before we
      // scan for the lowercase/uppercase customer-facing word.
      const identRegex = new RegExp(
        ALLOWED_IDENTIFIERS.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|'),
        'g',
      );

      const lines = stripped.split(/\r?\n/);
      const offending: Array<{ line: number; text: string }> = [];
      lines.forEach((line, idx) => {
        // Blank out allowed identifiers first.
        const cleaned = line.replace(identRegex, '');
        // Case-insensitive scan on whatever is left.
        if (!/rotate|rotation/i.test(cleaned)) return;
        offending.push({ line: idx + 1, text: line.trim() });
      });

      if (offending.length > 0) {
        const pretty = offending.map((o) => `  L${o.line}: ${o.text}`).join('\n');
        throw new Error(
          `Found "rotate"/"rotation" in ${relPath} (customer-facing files must use "refresh"):\n${pretty}`,
        );
      }

      expect(offending).toHaveLength(0);
    });
  }
});
