-- Convert public.legacy_account_map.parent_legacy_account_id from text to uuid.
--
-- Migration 20260416080000 introduced the column as TEXT NULL. Subsequent
-- migrations (20260417222959 and 20260418000300) treat the column as UUID
-- and attempt to add a FK to legacy_account_map.legacy_account_id (uuid). On
-- a fresh database the FK creation crashes with "incompatible types:
-- text and uuid".
--
-- On the original database the column had already been converted
-- to uuid through the dashboard, so the FK migrations succeeded there.
-- This migration replays that conversion so fresh projects walk the same
-- path.
--
-- An earlier migration (20260417000400) already created a BEFORE-INSERT
-- /UPDATE trigger (trg_legacy_account_parent_same_org) that depends on this
-- column, which blocks ALTER TYPE directly. We drop the trigger, change
-- the type, then recreate the trigger using the exact same function and
-- shape as 20260417000400.
--
-- Safe by design: we only run the conversion if the column is currently
-- text. On any database where the column is already uuid, the DO block
-- is a no-op.

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'legacy_account_map'
     AND column_name  = 'parent_legacy_account_id';

  IF col_type = 'text' THEN
    DROP TRIGGER IF EXISTS trg_legacy_account_parent_same_org
      ON public.legacy_account_map;

    ALTER TABLE public.legacy_account_map
      ALTER COLUMN parent_legacy_account_id TYPE uuid
      USING parent_legacy_account_id::uuid;

    CREATE TRIGGER trg_legacy_account_parent_same_org
      BEFORE INSERT OR UPDATE OF parent_legacy_account_id, org_id
      ON public.legacy_account_map
      FOR EACH ROW
      EXECUTE FUNCTION public.check_legacy_account_parent_same_org();
  END IF;
END $$;
