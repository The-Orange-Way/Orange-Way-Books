# Runbook 02: `owb-or-proxy` edge function returning 5xx

The OrangeRails proxy edge function is returning 5xx to clients; bank
and exchange sync paths are broken on the customer side. The rest of
the app keeps working (the proxy is the only Orange-Rails surface).

## What it looks like

- Customers report "can't refresh bank connection" or "exchange sync
  stuck".
- Browser network panel shows `POST .../functions/v1/owb-or-proxy`
  returning 500 / 502 / 503 / 504.
- Edge-function logs in Supabase dashboard show the proxy's own
  errors.

## Confirm

```bash
# 1. unauthenticated probe should return 401 (JWT required), not 500
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://$OWB_PROD_SUPABASE_URL/functions/v1/owb-or-proxy"

# 2. listing function status via mgmt api
curl -s -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/functions" \
  | python3 -c "import json,sys
for f in json.load(sys.stdin):
  if 'or-proxy' in (f.get('slug') or ''):
    print(f.get('slug'), f.get('status'), 'v'+str(f.get('version')))"
```

If the unauth probe returns 401, the function is up and the failure
is downstream (Orange Rails platform, customer-specific data, or a
specific code path). If it returns 5xx, the function is the failure.

## Immediate actions

1. Pull the last 100 lines of the edge function log via the
   dashboard. Filter to ERROR. **Capture the log slice to
   `incidents/YYYY-MM-DD/02-or-proxy-500/edge-logs.txt`** before
   Supabase rolls it off. Identify whether the failure mode is
   (a) every request, (b) only requests for a specific endpoint, or
   (c) only requests for a specific org.
2. If every request fails identically: roll back to the previous
   deployed version via the Supabase dashboard (Functions -> History
   -> Restore).
3. If only specific endpoints / orgs fail: this is likely an
   Orange-Rails platform issue. Check the operator-known OR platform
   status URL (kept current in the operator handbook; ask the founder
   if you do not know it). If OR is down, the proxy correctly
   surfaces the failure; there is no client-side fix.
4. If Orange Rails is up: confirm the `OR_PLATFORM_API_KEY` env var
   on the function has not been rotated without a redeploy. Compare
   the first and last 4 characters of the key in the function's env
   to the canonical value in Proton Pass; never print the full key.
5. Post a customer update once you know whether the fix is local
   (rollback) or upstream (OR platform).

## Escalation

- Internal: founder on Signal with the failing request shape (org_id,
  endpoint, status code).
- Orange Rails operator (founder): same person; the OR project is
  also in-house.

## Postmortem template

- Severity band (SEV-1 / SEV-2 / SEV-3) and rationale.
- Duration of customer-visible impact (start, end, duration).
- Root cause (five-whys if applicable): was the function actually
  broken, or was the failure upstream and the proxy correctly
  surfaced it?
- If broken: was the broken state introduced by the last deploy? Did
  CI catch any signal we ignored?
- Was the customer-facing error message useful, or did it look
  generic ("Internal Server Error" with no hint)?
- Action items with owners, due dates, and tracking location.
