import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import localRules from './eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      local: localRules,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': 'off',
      // Bans runtime `|`. The codebase has no legitimate bitwise-OR
      // sites; every `|` historically present has been `||` typoed.
      // The general `no-bitwise` rule would also flag `&`, `^`, `<<`,
      // which the codebase does use legitimately (e.g. `sample & 0x7ff`
      // in BIP-39 word extraction). Narrows to just `|`.
      'local/no-bitwise-or': 'error',
      // Pre-existing `any` usage across ~560 sites in the codebase. Each
      // call site needs a hand-written type to be safe; the blanket fix
      // is unsafe to apply mechanically. Demoted to a warning so CI is
      // honest and a follow-up cleanup pass can chip away at the count
      // without holding back the rest of the lint signal.
      '@typescript-eslint/no-explicit-any': 'warn',
      // The strict rules introduced in eslint-plugin-react-hooks v7
      // (set-state-in-effect, static-components, purity, immutability,
      // preserve-manual-memoization) flag patterns that are legitimate
      // in this codebase (Date.now in render, conditional state init,
      // component factories returning typed elements). Demoted to
      // warnings while we evaluate each rule individually. The classic
      // rules-of-hooks + exhaustive-deps remain at their default
      // severities so the genuinely-load-bearing checks still fail CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
);
