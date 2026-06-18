-- Index on public.org_members(user_id).
--
-- Every RLS policy on a customer-data table (organizations, org_members,
-- org_settings, accounts, contacts, journal_entries, journal_entry_lines,
-- transactions, payment_requests, attachments, audit_logs, chart_of_accounts,
-- sync_events, …) runs the subquery
--   org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
-- for every row scanned. The UNIQUE(user_id, org_id) constraint creates a
-- composite index but the planner does not always use it for the user_id-only
-- lookup that RLS performs at scale. A dedicated single-column index keeps the
-- RLS path O(log n) instead of O(n × m) once orgs and members grow.
--
-- Surfaced in the 2026-06-11 full review (finding M1).

CREATE INDEX IF NOT EXISTS idx_org_members_user_id
  ON public.org_members (user_id);
