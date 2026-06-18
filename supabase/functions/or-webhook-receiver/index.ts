/**
 * or-webhook-receiver — receives sync.completed events from OrangeRails.
 *
 * Resolves the inbound subaccount_id to an OWB org_id (OWB subaccounts
 * are 1-per-org) and enqueues the downstream work. HMAC signature
 * verification matches Stripe's v2 style.
 *
 * Wire format (OR's v2):
 *   POST  application/json
 *   Headers:
 *     X-OR-Signature      : v1 legacy — hex(HMAC-SHA-256(secret, body))
 *     X-OR-Signature-V2   : v2 — `t=<unix>,v1=<hex>` (Stripe-style)
 *     X-OR-Event-Id       : UUID stable across retries (dedupe key)
 *   Body:   { type: "sync.completed", data: { subaccount_id,
 *             connection_id, synced_count, ts } }
 *
 * Verification is delegated to the vendored `@orangerails/webhooks` SDK
 * at `../_shared/or-webhooks/` — the same SDK other OrangeRails consumers use, so all
 * three receivers verify byte-identically.
 *
 * Auth model: PUBLIC endpoint (no Supabase JWT). OR cannot mint user
 * JWTs. Authentication is the HMAC signature alone — the shared secret
 * `OR_WEBHOOK_SECRET` is set on both sides at registration time and
 * verified constant-time by the SDK on every request.
 *
 * On verified events we:
 *   1. Resolve org_id from subaccount_id via organizations.or_subaccount_id.
 *      That column is written by or-proxy after a successful or-provision.
 *   2. Insert (upsert on or_event_id) a row into public.sync_events.
 *      The Connections page subscribes via Supabase realtime so the UI
 *      refreshes without polling.
 *
 * What we do NOT do:
 *   - Mirror OR's connections list locally. OR remains source of truth.
 *   - Trigger any client-visible side effect beyond the row insert.
 *
 * Registration runbook (one-time, per environment):
 *   1. Generate a fresh shared secret:
 *        SECRET=$(openssl rand -hex 32)
 *   2. Set as Supabase edge function secret on OWB:
 *        DEV   project-ref (set via Supabase env)
 *        PROD  project-ref mgnlerblrfetziusbjrt
 *   3. Register receiver URL + secret on OR's `platforms` row for
 *      slug='orangeway-books':
 *        UPDATE platforms
 *           SET webhook_url    = 'https://<owb-ref>.supabase.co/functions/v1/or-webhook-receiver',
 *               webhook_secret = '<SECRET>'
 *         WHERE slug = 'orangeway-books';
 *   4. Smoke: trigger any or-sync from OWB → check sync_events table
 *      receives a row within ~30s (OR backoff).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse, readBoundedText } from "../_shared/http.ts";
import { constructEvent, SignatureVerificationError } from "../_shared/or-webhooks/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OR_WEBHOOK_SECRET = Deno.env.get("OR_WEBHOOK_SECRET");

const service = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Resolve org_id from OR's subaccount_id via organizations.or_subaccount_id.
 * The mapping is written by or-proxy after a successful or-provision call.
 *
 * If we can't resolve, the receiver returns 202 (accepted but skipped)
 * so OR's dispatcher considers the delivery successful and won't retry
 * forever on a permanent mapping gap.
 */
async function resolveOrgId(subaccountId: string): Promise<string | null> {
  const { data, error } = await service
    .from("organizations")
    .select("id")
    .eq("or_subaccount_id", subaccountId)
    .maybeSingle();
  if (error) {
    console.error("[or-webhook-receiver] org lookup error:", error.message);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!OR_WEBHOOK_SECRET) {
    return jsonResponse({ error: "OR_WEBHOOK_SECRET not configured" }, 500);
  }

  const body = await readBoundedText(req);
  if (body === null) {
    return jsonResponse({ error: "Request body too large" }, 413);
  }

  let event;
  try {
    event = await constructEvent({
      rawBody: body,
      headers: {
        "x-or-signature": req.headers.get("x-or-signature"),
        "x-or-signature-v2": req.headers.get("x-or-signature-v2"),
        "x-or-event-id": req.headers.get("x-or-event-id"),
      },
      secret: OR_WEBHOOK_SECRET,
      tolerance: 300,
    });
  } catch (err) {
    if (err instanceof SignatureVerificationError) {
      console.warn(`[or-webhook-receiver] verification failed (${err.code}): ${err.message}`);
      return jsonResponse({ error: "Invalid signature" }, 401);
    }
    console.error("[or-webhook-receiver] unexpected SDK error:", err);
    return jsonResponse({ error: "Verification error" }, 500);
  }

  // Mapping from OR event type → sync_events.status. New types added
  // here must also be added to the CHECK constraint in the
  // sync_events_status migration.
  const STATUS_BY_TYPE: Record<string, "completed" | "failed" | "deleted"> = {
    "sync.completed": "completed",
    "connection.failed": "failed",
    "connection.deleted": "deleted",
  };

  const status = STATUS_BY_TYPE[event.type];
  if (!status) {
    // Unknown event type — 202-ACK so OR stops retrying, log so we can
    // see new types arrive. Plumb the data path when we know the shape.
    console.warn(
      `[or-webhook-receiver] unhandled event type "${event.type}" — accepting without persisting`,
    );
    return jsonResponse({ status: "accepted_unhandled", type: event.type }, 202);
  }

  const orgId = await resolveOrgId(event.data.subaccount_id);
  if (!orgId) {
    console.warn(
      `[or-webhook-receiver] unknown subaccount_id ${event.data.subaccount_id} — no org match`,
    );
    return jsonResponse({ status: "accepted_no_org" }, 202);
  }

  const { error: insertErr } = await service.from("sync_events").upsert(
    {
      org_id: orgId,
      or_connection_id: event.data.connection_id,
      // synced_count is only meaningful on completed events; failed +
      // deleted leave it null so the UI doesn't render a misleading "0".
      synced_count: status === "completed" ? event.data.synced_count : null,
      or_ts: event.data.ts,
      or_event_id: event.id,
      status,
    },
    { onConflict: "or_event_id", ignoreDuplicates: true },
  );

  if (insertErr) {
    console.error("[or-webhook-receiver] sync_events upsert failed:", insertErr.message);
    return jsonResponse({ error: "Persist failed" }, 500);
  }

  return jsonResponse({ status: "ok", recordedAs: status }, 200);
});
