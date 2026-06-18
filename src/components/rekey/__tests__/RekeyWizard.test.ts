/**
 * @vitest-environment node
 *
 * Phase 4.5 polish — RekeyWizard Quick/Deep toggle contract.
 *
 * A full jsdom render of RekeyWizard requires mocking `useVault`,
 * Supabase, and the rekey library — this repo doesn't ship mock
 * infrastructure for those call sites yet, and the rest of the
 * component test surface is covered by the RoleSummary-style
 * node-environment approach (read the source; assert invariants).
 *
 * This test asserts two contracts by parsing the component source:
 *
 *   1. The Quick/Deep refresh segmented choice is present on
 *      Screen 2 and uses the correct customer-facing copy.
 *   2. The initial state of `refreshMode` defaults to 'quick'.
 *
 * Both invariants directly encode D31 (the Phase 4 roadmap
 * decision) as test-level contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WIZARD_PATH = resolve(process.cwd(), 'src/components/rekey/RekeyWizard.tsx');

describe('RekeyWizard — Quick vs Deep refresh', () => {
  const source = readFileSync(WIZARD_PATH, 'utf8');

  it('defaults refreshMode state to "quick"', () => {
    // The useState initializer should literally be 'quick' — Deep is
    // opt-in per D31 so the default is the safe fast path.
    expect(source).toMatch(/useState<RefreshMode>\(\s*['"]quick['"]\s*\)/);
  });

  it("renders the 'Quick refresh (recommended)' option", () => {
    expect(source).toContain('Quick refresh');
    expect(source).toContain('(recommended)');
  });

  it("renders the 'Deep refresh' option", () => {
    expect(source).toContain('Deep refresh');
  });

  it('wires the RadioGroup value to refreshMode state', () => {
    // Guard against someone swapping RadioGroup for a Checkbox and
    // silently breaking the toggle semantics.
    expect(source).toMatch(/RadioGroup[\s\S]*value=\{refreshMode\}/);
    expect(source).toMatch(/onValueChange=\{\(v\)\s*=>\s*setRefreshMode\(v\s+as\s+RefreshMode\)\}/);
  });

  it('passes refreshMode to startRekeyJob', () => {
    // The wizard's kickOff must forward refreshMode to
    // startRekeyJob(orgId, triggerType, refreshMode).
    expect(source).toMatch(/startRekeyJob\(orgId,\s*triggerType,\s*refreshMode\)/);
  });

  it('does NOT leak "rotate" / "rotation" into customer-facing copy', () => {
    // Strip comments first so code-symbol mentions in /** … */ blocks
    // don't trip the guard. Identifier comments stay per the task's
    // hard rule.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped).not.toMatch(/rotate|rotation/i);
  });
});
