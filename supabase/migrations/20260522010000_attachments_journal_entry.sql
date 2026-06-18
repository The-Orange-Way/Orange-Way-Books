-- ============================================================================
-- P2 — attachments on journal entries
-- ============================================================================
--
-- Extends attachments.entity_type CHECK to include 'journal_entry'. Without
-- this, the existing CHECK ('transaction', 'payment_request') blocks any
-- attempt to attach a receipt directly to a journal entry — which is the
-- shape we need for Wave-imported JEs and for receipts that don't pair with
-- a single bank-side transaction (e.g., accrual journals).
--
-- This is a pure CHECK-constraint widening. Existing rows are unaffected.
-- No data migration needed. RLS policies on attachments already allow any
-- entity_id reachable by the calling user; the entity_type whitelist is
-- the only gate that changes.
--
-- Audit trail still works via the existing attachments insert path. The
-- bulk linker that uses this (P2 v2) will look up JEs by
-- hmac_import_external_id (added in 20260522000000 for P5 idempotency) so
-- the OR receipt-matching flow can attach receipts to imported JEs without
-- decrypting anything server-side.

ALTER TABLE public.attachments
  DROP CONSTRAINT IF EXISTS attachments_entity_type_check;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN ('transaction', 'payment_request', 'journal_entry'));

COMMENT ON COLUMN public.attachments.entity_type IS
  'Allowed values: transaction (wallet-side), payment_request (AP), journal_entry (any JE — manual, imported via OR, or auto-posted from invoicing/payments).';
