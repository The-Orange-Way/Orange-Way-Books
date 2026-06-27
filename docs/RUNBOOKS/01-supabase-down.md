# Runbook 01: Supabase down

The hosted Supabase project (DB + auth + storage + edge functions) is
unreachable or returning 5xx across the board.

## What it looks like

- Customers report "can't sign in" or "page hangs after vault unlock".
- Cloudflare Pages frontend loads (HTML reachable) but every fetch to
  `*.supabase.co` returns 5xx, 504, or hangs to TCP timeout.
- The Supabase status page at `status.supabase.com` shows a regional
  incident, or our project shows `INACTIVE` / `PAUSED` in the
  dashboard.

## Confirm

```bash
# 1. project status (one-shot, ~2s)
curl -s -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('region'))"

# 2. trivial query against the project
curl -s --max-time 30 -X POST \
  "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/database/query" \
  -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"select 1 as ok;"}'
```

If status is `INACTIVE`, the project auto-paused. Go to dashboard,
click Restore, wait 30s.

If status is `ACTIVE_HEALTHY` but queries hang, the platform side is
degraded; this is a Supabase incident, not a project incident.

## Immediate actions

1. Post a single message in the customer-facing channel and on the
   site banner (if one exists) saying "We are aware of the issue.
   Next update by [explicit timestamp, e.g. in 30 min]." Do this in
   the first five minutes; the customer-trust cost of silence is
   higher than the cost of being wrong about scope. Set a per-incident
   cadence rather than a standing one so customers do not read it as
   an availability SLA.
2. Confirm dev environment is also affected. If only prod, the issue
   is project-specific; if both, it is regional / platform-level.
3. If `INACTIVE`: click Restore in the dashboard. Wait until the
   trivial query above returns `{"ok": 1}`.
4. If platform-level: monitor `status.supabase.com`. Do not page
   anyone; we cannot fix a platform incident. Re-post the customer
   update every 15 min.
5. Once recovered, run a single transaction round-trip end-to-end (a
   new transaction created on the dev account, decrypted on read, on
   the production app) to confirm the data plane is healthy, not just
   the connect plane.

## Escalation

- Internal: ping the founder on Signal with the project ref and the
  `status` output.
- External: Supabase support via the dashboard support widget. Free
  tier has no SLA; paid tier responds within a few hours during a
  platform incident.

## Postmortem template

- Severity band (SEV-1 / SEV-2 / SEV-3) and rationale.
- User-visible window of impact (start, end, duration).
- Root cause (five-whys if applicable).
- Detection time: how long from first signal to on-call ack?
- Did the runbook help? What step was wrong or missing?
- Action items with owners, due dates, and tracking location (the
  dated wiki entry for this incident).
