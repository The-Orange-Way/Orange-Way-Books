# Parity test fixtures

Synthetic data shaped like what the operator's Wave books look like, used to
verify the ledger engine produces a Trial Balance that matches the expected
output to the penny.

When the OR Wave converter ships, additional fixture directories slot in
here using the same `accounts.json` + `journal-lines.json` +
`expected-trial-balance.json` shape. The parity test (`tests/parity/
trial-balance-parity.test.ts`) runs every fixture and diffs against expected.

Fixtures committed today are SYNTHETIC and contain no real PII. Real
Wave-derived fixtures will be produced later by the OR converter; those
must live somewhere private (Jarvis workspace, not in this repo) since
they contain real-org financial data and must not enter the public repo.

## Fixtures

### `inspire-2024-mini/`

Hand-built 18-line dataset modelling Inspire Potential Inc. style activity:
opening balance, consulting revenue, invoice + payment, recurring software,
domain renewal, marketing, tax software, credit-card payoff. Nine accounts
across the five types. Trial Balance totals $16,000 / $16,000.

The numbers and vendor names are realistic for the entity's profile (small
Canadian consulting corp) but no row corresponds to a real transaction.
