# subscription-lifecycle

Daily cron that advances subscription `status` based on the grace-period
table defined in the lifecycle module header (`index.ts`).

## Auth

Calls must carry either:

- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`, or
- `X-Cron-Secret: <CRON_SECRET>` (env var on the edge function).

## Scheduling — pick one

### Option A: Supabase pg_cron

```sql
select cron.schedule(
  'flash-lifecycle-daily',
  '17 4 * * *',  -- 04:17 UTC daily
  $$
    select net.http_post(
      url    := 'https://<project-ref>.supabase.co/functions/v1/subscription-lifecycle',
      headers:= '{"X-Cron-Secret":"<CRON_SECRET>"}'::jsonb
    )
  $$
);
```

### Option B: external cron

```bash
curl -X POST \
  -H "X-Cron-Secret: $CRON_SECRET" \
  https://<project-ref>.supabase.co/functions/v1/subscription-lifecycle
```

## Response

```json
{
  "ok": true,
  "report": {
    "scanned": 12,
    "trialing_to_past_due": 1,
    "active_to_past_due": 0,
    "past_due_to_read_only": 0,
    "read_only_to_locked": 0,
    "locked_to_deleted": 0
  }
}
```

Each transition writes a row to `subscription_lifecycle_events`. Email
sends are stubbed (logged only) until the Resend / Supabase SMTP daemon
is wired up. See `supabase/functions/_shared/emails/send.ts`.
