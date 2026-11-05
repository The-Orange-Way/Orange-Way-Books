import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The deploy workflow sets these at build time. Evaluate each branch rule the
// way Actions would for the three kinds of branch that deploy.
const workflow = readFileSync(
  resolve(__dirname, '../../../../.github/workflows/deploy.yml'),
  'utf8',
);

function valueFor(name: string, ref: string): string {
  const m = workflow.match(new RegExp(`^\\s+${name}: \\$\\{\\{ (.+) \\}\\}$`, 'm'));
  if (!m) throw new Error(`${name} is not set in deploy.yml`);
  const expr = m[1]
    .replace(/github\.ref_name/g, JSON.stringify(ref))
    .replace(/startsWith\(([^,]+), ([^)]+)\)/g, '$1.startsWith($2)')
    .replace(/'/g, '"');
  // Actions `a && b || c` is the same as the JavaScript expression here.
  return String(new Function(`return (${expr});`)());
}

describe('deploy.yml Orange Rails flags', () => {
  it('turns Stealth Sync on for dev only', () => {
    expect(valueFor('VITE_STEALTH_SYNC_ENABLED', 'dev')).toBe('true');
    expect(valueFor('VITE_STEALTH_SYNC_ENABLED', 'prod')).not.toBe('true');
    expect(valueFor('VITE_STEALTH_SYNC_ENABLED', 'hotfix/prod-x')).not.toBe('true');
  });

  it('names the right platform slug on each environment, never empty', () => {
    expect(valueFor('VITE_OR_PLATFORM_SLUG', 'dev')).toBe('orangeway-books');
    expect(valueFor('VITE_OR_PLATFORM_SLUG', 'prod')).toBe('orangewaybooks');
    expect(valueFor('VITE_OR_PLATFORM_SLUG', 'hotfix/prod-x')).toBe('orangewaybooks');
  });
});
