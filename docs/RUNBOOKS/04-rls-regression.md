# Runbook 04: Row-level-security regression

A row-level-security (RLS) policy on a tenant table is either too
loose (cross-tenant read possible) or too tight (legitimate users
locked out of their own data). The first class is a security
incident; the second is a customer-impact incident.

## What it looks like

### Too loose

- A customer reports "I can see another org's data" or a security
  researcher reports a cross-tenant read path.
- Internal grep finds `USING (true)` on a tenant table that should be
  scoped by `org_id` / `user_id`.

### Too tight

- A customer reports "I can't see my own data" after signing in.
- The browser console shows empty arrays from queries the user
  should have rows for.

## Confirm

```bash
# 1. dump all SELECT policies on tenant tables
curl -s -X POST "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/database/query" \
  -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select tablename, policyname, qual::text from pg_policies where tablename in (select tablename from pg_tables where schemaname = '"'"'public'"'"') and cmd = '"'"'SELECT'"'"' order by tablename, policyname;"}'

# 2. spot-check a known-isolated table (transactions): the qual must
#    reference auth.uid() or an org_members subquery, not "true".
```

If you see `qual = "true"` on a tenant table, that table is publicly
readable to any authenticated user.

## Immediate actions

### Too loose

1. **Triage scope.** Which tables, which columns, which orgs. The
   blast radius is `(rows visible) x (auth users on the platform)`;
   if the answer is "everyone can see everyone's transactions", this
   is a SEV-1 confidentiality incident.
2. **Capture the current policy definition** from the `pg_policies`
   dump in Confirm before changing anything. Save to
   `incidents/YYYY-MM-DD/04-rls-regression/before.sql` so the
   postmortem has the pre-change state.
3. **Stop the bleed.** Drop the broken policy and replace with a
   restrictive default (`USING (false)`) or tighten the existing one.
   This may cause too-tight symptoms briefly; that is acceptable.
4. **Assess what was actually exposed.** Cross-tenant reads can
   happen through the PostgREST surface without touching edge
   functions, so edge logs alone undercount. Query the Supabase log
   panel (PostgREST request logs + `pg_stat_statements` if enabled)
   for the affected table to identify which user ids issued reads
   they should not have.
5. **Apply the ZKA carve-out before notifying.** Most tenant tables
   hold `enc_*` ciphertext that the receiver cannot decrypt. A
   cross-tenant SELECT of ciphertext alone is not automatically a
   Law 25 §3.5 / GDPR Art. 33 confidentiality incident. The
   notification threshold is met when plaintext personal data
   leaked: dates joinable to identity, any column in `auth.users`,
   any non-`enc_*` PII column, or any indication of exfiltration.
6. **If the threshold is met, notify affected orgs.** Trigger the
   breach process in `TERMS.md §6`: the Commission d'accès à
   l'information (CAI) plus affected individuals where feasible
   within 72 hours of becoming aware, per Law 25 §3.5 and GDPR
   Art. 33. "Became aware" anchors on the operator's reasonable
   assessment that an incident occurred, not the first ambiguous
   report.

### Too tight

1. **Confirm the customer is signed in correctly.** A missing JWT or
   stale session looks identical to "RLS locked me out". Have them
   sign out and back in.
2. **If still locked out**: read the policy. Identify which clause
   in the `USING` predicate is failing for this specific user (often
   a join that returns zero rows when it should return one).
3. **Patch via a new migration, not a manual UPDATE.** The fix has
   to land in dev and replay cleanly on prod.

## Escalation

- Internal: founder on the operator's escalation channel (listed in
  the operator handbook). For "too loose", this is a security
  incident; treat the disclosure pipeline as live until the founder
  says otherwise.
- External: if cross-tenant read of plaintext is confirmed and
  affected orgs are identifiable, follow the breach-notification
  process in `TERMS.md §6` (CAI + affected individuals within 72
  hours where feasible). Ciphertext-only exposure does not
  automatically meet the statutory threshold; assess per step 5
  above.

## Postmortem template

- Severity band (SEV-1 / SEV-2 / SEV-3) and rationale.
- Duration of customer-visible impact (start, end, duration).
- Root cause (five-whys if applicable): which side of the regression
  was it (too loose / too tight)?
- Was the policy introduced in a recent migration, or was it always
  this way and we only noticed now?
- Did our pre-merge multi-tenant audit miss it? If yes, what query
  would have caught it? Add that query to the audit checklist.
- Did any plaintext customer data leave the trust boundary? If yes,
  what is the legal notification status, when did the 72-hour clock
  start, and when did notification go out?
- Action items with owners, due dates, and tracking location.
