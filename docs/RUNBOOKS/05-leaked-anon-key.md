# Runbook 05: Leaked or rotated anon key

The Supabase `anon` key has been intentionally rotated, or has leaked
into a place that was supposed to be private (a CI secret, a customer
report, a screenshot, a search-engine cache). The anon key is
public-by-design (it ships in the client bundle), so "leaked" alone is
not a breach; the relevant scenarios are:

- A rotation that the deployed clients have not picked up yet.
- A `SUPABASE_SERVICE_ROLE_KEY` (not the anon key) leak (this is a
  breach class, not the anon key).

## What it looks like

- Deploy logs show `JWT secret mismatch` or `Invalid Compact JWS` on
  every signed-in request.
- Customers report "everything fails after sign-in" right after a
  scheduled rotation window.
- Someone reports the service role key (not the anon key) in a place
  it should not be (a public repo, a Slack channel, a screenshot in
  a support ticket). **Service-role-key leaks are a critical
  security incident** and require immediate rotation; anon-key
  exposure does not.

## Confirm

```bash
# 1. project-side key fingerprint
curl -s -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/api-keys" \
  | python3 -c "import json,sys; [print(k.get('name'), k.get('id'), k.get('description')) for k in json.load(sys.stdin) if isinstance(k, dict)]"

# 2. client bundle: confirm the deployed VITE_SUPABASE_ANON_KEY
#    matches the project's current anon key. If they diverge, every
#    signed-in request fails until the build picks up the new value.
```

If the key fingerprints diverge: the client is on an old key. Re-run
the Cloudflare Pages deploy with the current value in the env.

If the leaked key is the service role key (it starts with
`eyJ...service_role`): treat as a breach.

## Immediate actions

### Anon-key rotation (planned or after exposure)

1. Set the new `VITE_SUPABASE_ANON_KEY` in Cloudflare Pages env (both
   dev and prod scopes).
2. Trigger a Pages deploy. Wait until the new build is live (~2 min).
3. Run a single signed-in request from a fresh browser session
   against prod. If it works, the rotation is complete.
4. **Invalidate the previous anon key in the Supabase dashboard.**
   Leaving the old key alive after a rotation defeats the rotation:
   anyone holding it can keep using it. The window between deploy
   and invalidation should be a few minutes, not days.

### Service-role-key leak

A service-role-key leak is a SEV-1 incident. Two clocks start at
"became aware":

- The **researcher-disclosure clock** in `SECURITY.md` (acknowledge
  the reporter within the stated window).
- The **breach-notification clock** in `TERMS.md §6` (CAI + affected
  individuals within 72 hours where feasible, per Law 25 §3.5 and
  GDPR Art. 33).

These are separate obligations. Handle both.

1. **Audit before rotating, if the window is small enough.** Pull
   the database query log + edge-function log for the period from
   exposure to now and save to
   `incidents/YYYY-MM-DD/05-leaked-anon-key/`. Rotation destroys the
   ability to correlate "which requests used the leaked key" because
   the key itself becomes invalid; capture the evidence first. If
   the exposure window is large or active exploitation is suspected,
   rotate immediately and audit from the saved logs afterward.
2. **Rotate.** Generate a new service-role key in the Supabase
   dashboard. The old key is invalid the moment the new one is
   issued.
3. Update every place the service-role key is used: edge function
   secrets (Supabase dashboard, per function), CI secrets (GitHub
   Actions repo / org / env scope), local `.env` files on the
   founder's laptop.
4. Assess what plaintext customer data was reachable. The service
   role bypasses RLS, so it can read every `enc_*` column, but those
   are ciphertext under per-org keys the server cannot decrypt. The ZKA carve-out from runbook 04 applies: ciphertext
   exposure alone does not automatically trigger Law 25 / GDPR
   notification; plaintext columns (auth.users, non-`enc_*` PII,
   dates joinable to identity) do.
5. If a third party (security researcher, customer) reported the
   leak, acknowledge per the disclosure window in `SECURITY.md`.
6. If the plaintext-exposure threshold from step 4 is met, trigger
   the breach process in `TERMS.md §6` (CAI + affected individuals
   within 72 hours where feasible).
7. Open a postmortem within 24 hours.

## Escalation

- Anon-key rotation: routine; founder + on-call only.
- Service-role-key leak: founder immediately on Signal; treat as a
  breach incident until proven otherwise; engage the
  breach-notification process from `TERMS.md` if any customer data
  was reachable via the leaked key.

## Postmortem template

- Severity band (SEV-1 for service-role; SEV-3 for routine anon-key
  rotation) and rationale.
- Duration of exposure window (start, end, duration).
- Root cause (five-whys if applicable): was this an anon key
  (routine) or a service-role key (breach)? How did the key end up
  where it did? Was the "never inline secrets in commands" rule
  violated? What gate would have caught it?
- Was the gitleaks staged scan green at the time of commit? If yes,
  the regex is incomplete; add a pattern.
- Was any plaintext customer data reachable via the leaked key? If
  yes, when did the 72-hour clock start and when did notification go
  out?
- Action items with owners, due dates, and tracking location.
