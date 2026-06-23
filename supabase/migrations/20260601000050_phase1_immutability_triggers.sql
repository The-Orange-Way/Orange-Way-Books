-- Phase 1, Migration 5/9: Immutability trigger pair on journal_entries + journal_entry_lines.
--
-- D9 enables this: status is plaintext, so the server can read it to gate
-- the rule. the prior model's elegant `to_jsonb(OLD) - whitelist_cols IS DISTINCT FROM
-- to_jsonb(NEW) - whitelist_cols` diff catches any byte-level change to
-- non-whitelisted columns, including encrypted columns (the diff is binary).
--
-- Workflow-meta whitelist allows these mutations on a finalized row:
--   - status (POSTED → VOID transition during reversal)
--   - updated_at (audit timestamp)
--   - encrypted_period_locked + encrypted_metadata (only on JE header; these
--     can be re-encrypted under a new MEK during rekey without changing
--     business meaning)
--   - key_version (rekey)
--
-- Everything else is locked once status reaches POSTED, VOID, or VOID_REVERSAL.

-- Helper: is this JE locked? Plaintext status read is now possible.
CREATE OR REPLACE FUNCTION public.owb_je_is_locked(p_je_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.journal_entries WHERE id = p_je_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN v_status IN ('POSTED', 'VOID', 'VOID_REVERSAL');
END;
$$;

-- Trigger fn for journal_entries
CREATE OR REPLACE FUNCTION public.owb_protect_finalized_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_locked BOOLEAN;
  v_old_business JSONB;
  v_new_business JSONB;
BEGIN
  -- Compute lock state. NEW.status drives the lock for INSERT (no OLD) and
  -- for transitions into a locked state during this same UPDATE.
  IF TG_OP = 'DELETE' THEN
    v_locked := OLD.status IN ('POSTED', 'VOID', 'VOID_REVERSAL');
  ELSE
    v_locked := OLD.status IN ('POSTED', 'VOID', 'VOID_REVERSAL');
    -- Edge case: same-update transition draft→posted is allowed only with the
    -- status change in isolation. Treat it as "locking now, no other changes allowed".
    IF TG_OP = 'UPDATE'
      AND NOT v_locked
      AND OLD.status NOT IN ('POSTED', 'VOID', 'VOID_REVERSAL')
      AND NEW.status     IN ('POSTED', 'VOID', 'VOID_REVERSAL')
    THEN
      v_locked := TRUE;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_locked THEN
      RAISE EXCEPTION 'Cannot delete finalized journal entry %.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation',
              DETAIL  = 'Finalized journal entries are immutable.',
              HINT    = 'Use the reversal workflow (post a new opposing entry).';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT v_locked THEN
    RETURN NEW;
  END IF;

  -- v_locked = TRUE. Allow ONLY whitelisted mutations.
  v_old_business := to_jsonb(OLD) - ARRAY[
    'status',                   -- POSTED → VOID transition during reversal
    'updated_at',               -- audit timestamp
    'encrypted_metadata',       -- catch-all for re-encrypt during rekey
    'encrypted_period_locked',  -- toggled during period close/unlock
    'key_version'               -- rekey
  ];
  v_new_business := to_jsonb(NEW) - ARRAY[
    'status',
    'updated_at',
    'encrypted_metadata',
    'encrypted_period_locked',
    'key_version'
  ];

  IF v_old_business IS DISTINCT FROM v_new_business THEN
    RAISE EXCEPTION 'Cannot modify finalized journal entry %.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation',
            DETAIL  = 'Only workflow metadata may change after an entry is finalized.',
            HINT    = 'Use the reversal workflow to record an opposing entry.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_finalized_je
  BEFORE UPDATE OR DELETE
  ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.owb_protect_finalized_journal_entry();

-- Trigger fn for journal_entry_lines
CREATE OR REPLACE FUNCTION public.owb_protect_finalized_journal_entry_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_je_id UUID;
BEGIN
  v_je_id := OLD.journal_entry_id;
  IF public.owb_je_is_locked(v_je_id) THEN
    -- Allow rekey-style updates: changing key_version + encrypted_* under
    -- a new MEK with no other column changing.
    IF TG_OP = 'UPDATE' THEN
      DECLARE
        v_old_business JSONB := to_jsonb(OLD) - ARRAY['key_version', 'encrypted_metadata'];
        v_new_business JSONB := to_jsonb(NEW) - ARRAY['key_version', 'encrypted_metadata'];
      BEGIN
        IF v_old_business IS NOT DISTINCT FROM v_new_business THEN
          RETURN NEW;
        END IF;
      END;
    END IF;
    RAISE EXCEPTION 'Cannot % line on finalized journal_entry %.',
        lower(TG_OP), v_je_id
      USING ERRCODE = 'integrity_constraint_violation',
            DETAIL  = 'Finalized journal entry lines are immutable.',
            HINT    = 'Use the reversal workflow on the parent entry.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_finalized_jel
  BEFORE UPDATE OR DELETE
  ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.owb_protect_finalized_journal_entry_line();

COMMENT ON FUNCTION public.owb_protect_finalized_journal_entry() IS
  'D9 immutability enforcer. Reads plaintext journal_entries.status. Once status is POSTED/VOID/VOID_REVERSAL, only workflow-meta columns can change (status itself for the reversal flip, updated_at, encrypted_metadata + encrypted_period_locked + key_version for rekey).';

COMMENT ON FUNCTION public.owb_protect_finalized_journal_entry_line() IS
  'Sibling immutability enforcer for lines. Allows rekey-style updates (key_version + encrypted_metadata only) on a locked parent; rejects all other mutations.';
