-- connection_account_map.last_or_synced_at, incremental-import cursor.
--
-- Today every OR sync asks for the full transaction list and the bridge
-- short-circuits duplicates client-side (an earlier change collapsed the dedup pass
-- to O(1) queries, but the OR call itself still returns every tx). With
-- a cursor we can tell OR "give me what's new since <ts>" and skip the
-- payload entirely for already-imported runs.
--
-- The column is per (or_connection_id, or_external_wallet_id) mapping
-- because OR returns transactions per source-wallet inside a connection,
-- and different mapped destinations could drift on what they've sucked
-- in (e.g. a new mapping added later starts at NULL = "all history").
--
-- NULL = no successful sync yet for this mapping → ask OR for everything.
-- Non-NULL = the upper bound of `or_ts` that's already in the ledger.
--
-- Forward-additive. Pre-existing rows stay NULL until the first cursor
-- write, so behaviour is unchanged.
--
-- Refs:
--   Feature-parity work for the connector pipeline.

ALTER TABLE public.connection_account_map
  ADD COLUMN IF NOT EXISTS last_or_synced_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.connection_account_map.last_or_synced_at IS
  'High-water mark of or_ts already imported for this (or_connection_id, or_external_wallet_id) → wallet mapping. NULL = no successful sync yet. The bridge sends this as `since` to OR''s or-transactions-list and writes the max(or_ts) of the just-imported batch after a successful run.';
