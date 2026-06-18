-- Add linked_transfer_id column to transactions table
-- Enables linking two transactions as a transfer pair (money moving between accounts)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS linked_transfer_id uuid REFERENCES transactions(id) ON DELETE SET NULL;

-- Index for efficient lookups of linked pairs
CREATE INDEX IF NOT EXISTS idx_transactions_linked_transfer_id
  ON transactions(linked_transfer_id)
  WHERE linked_transfer_id IS NOT NULL;
