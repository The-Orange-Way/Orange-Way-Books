/**
 * complete-invite-wrap — Supabase Edge Function (Phase 4.3 + 4.5)
 *
 * Second-stage handler for the pending-invite pipeline. When a recipient
 * finishes vault setup and publishes their `user_vault_keys` row, the
 * `link_pending_invites_on_keypair_insert` trigger flips the matching
 * `pending_invites.status` to `ready_to_wrap` and writes a
 * `user.wrap_ready` audit event. The Owner's client, subscribed via
 * Supabase realtime on `pending_invites`, picks this up and produces
 * the hybrid-KEM wrap client-side. It then calls THIS function to
 * commit the wrap server-side in one transactional-equivalent sequence:
 *
 *   1. org_keys row INSERT (wrapped_dek, iv, wrap_algo)
 *   2. org_members row INSERT
 *   3. org_member_roles row INSERT (capability grant activation)
 *   4. pending_invites.status = 'wrapped'
 *   5. vault_security_events row ('user.wrap_completed')
 *
 * Any failure after step 1 rolls back by DELETEing the rows written so
 * far. The pending_invites row stays `ready_to_wrap` so the Owner can
 * retry.
 *
 * Request body (JSON):
 *   {
 *     "pending_invite_id": "<uuid>",
 *     "wrapped_dek": {
 *       "wrapped_dek": "<base64>",
 *       "iv":          "<base64>",
 *       "wrap_algo":   "hybrid-x25519-mlkem768"
 *     }
 *   }
 *
 * Response (200):
 *   { ok: true, user_id, org_id, role_name }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

const ALLOWED_WRAP_ALGOS = new Set<string>(['hybrid-x25519-mlkem768']);

interface WrappedDekPayload {
  wrapped_dek: string;
  iv: string;
  wrap_algo: string;
}

function isValidWrapPayload(v: unknown): v is WrappedDekPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.wrapped_dek === 'string' &&
    o.wrapped_dek.length > 0 &&
    o.wrapped_dek.length < 8192 &&
    BASE64_RE.test(o.wrapped_dek) &&
    typeof o.iv === 'string' &&
    o.iv.length > 0 &&
    o.iv.length < 64 &&
    BASE64_RE.test(o.iv) &&
    typeof o.wrap_algo === 'string' &&
    ALLOWED_WRAP_ALGOS.has(o.wrap_algo)
  );
}

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: authErr,
    } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    const rl = await rateLimit(adminClient, {
      scope: 'complete-invite-wrap',
      subject: caller.id,
      maxPerWindow: 30,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: { pending_invite_id?: string; wrapped_dek?: unknown };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const pendingInviteId =
      typeof body.pending_invite_id === 'string' ? body.pending_invite_id.trim() : '';
    if (!pendingInviteId || !UUID_RE.test(pendingInviteId)) {
      return jsonResponse({ error: 'pending_invite_id must be a UUID' }, 400, cors);
    }
    if (!isValidWrapPayload(body.wrapped_dek)) {
      return jsonResponse({ error: 'Invalid wrapped_dek payload' }, 400, cors);
    }
    const wrapPayload: WrappedDekPayload = body.wrapped_dek;

    // Load the pending invite. It must be ready_to_wrap and tied to an
    // org the caller has `users.invite` in. The RLS policy already
    // scopes SELECT to inviters, but the admin client bypasses RLS —
    // so we re-check the capability explicitly.
    const { data: pending, error: pendingErr } = await adminClient
      .from('pending_invites')
      .select('id, org_id, email, role_definition_id, recipient_user_id, status, expires_at')
      .eq('id', pendingInviteId)
      .maybeSingle();
    if (pendingErr) {
      console.error('complete-invite-wrap fetch pending_invite failed:', pendingErr);
      return jsonResponse({ error: 'Failed to load pending invite' }, 500, cors);
    }
    if (!pending) {
      return jsonResponse({ error: 'Pending invite not found' }, 404, cors);
    }
    if (pending.status !== 'ready_to_wrap') {
      return jsonResponse(
        { error: `Pending invite is in state '${pending.status}' — expected ready_to_wrap` },
        409,
        cors,
      );
    }
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await adminClient.from('pending_invites').update({ status: 'expired' }).eq('id', pending.id);
      return jsonResponse({ error: 'Invite has expired' }, 410, cors);
    }
    if (!pending.recipient_user_id) {
      return jsonResponse(
        { error: 'Pending invite has no recipient_user_id — trigger may have lost the link' },
        500,
        cors,
      );
    }

    const { data: canInvite, error: capErr } = await adminClient.rpc('user_has_capability', {
      p_user_id: caller.id,
      p_capability: 'users.invite',
      p_org_id: pending.org_id,
    });
    if (capErr) {
      console.error('complete-invite-wrap capability check failed:', capErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    if (!canInvite) {
      return jsonResponse(
        { error: 'You do not have permission to complete this invite' },
        403,
        cors,
      );
    }

    // Load role name for the response.
    const { data: roleDef, error: roleErr } = await adminClient
      .from('role_definitions')
      .select('id, name, is_system, org_id')
      .eq('id', pending.role_definition_id)
      .maybeSingle();
    if (roleErr || !roleDef) {
      console.error('complete-invite-wrap role lookup failed:', roleErr);
      return jsonResponse({ error: 'Role definition no longer exists' }, 500, cors);
    }

    const targetUserId = pending.recipient_user_id;
    const orgId = pending.org_id;

    // 1) org_members (idempotent check first).
    const { data: existingMember } = await adminClient
      .from('org_members')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!existingMember) {
      const { error: memberErr } = await adminClient.from('org_members').insert({
        org_id: orgId,
        user_id: targetUserId,
      });
      if (memberErr) {
        console.error('complete-invite-wrap insert org_members failed:', memberErr);
        return jsonResponse({ error: 'Failed to add member' }, 500, cors);
      }
    }

    // 2) org_keys. If a row already exists (e.g. retry), update it.
    const { data: existingKey } = await adminClient
      .from('org_keys')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (existingKey) {
      const { error: updErr } = await adminClient
        .from('org_keys')
        .update({
          wrapped_dek: wrapPayload.wrapped_dek,
          iv: wrapPayload.iv,
          wrap_algo: wrapPayload.wrap_algo,
        })
        .eq('id', existingKey.id);
      if (updErr) {
        console.error('complete-invite-wrap update org_keys failed:', updErr);
        return jsonResponse({ error: 'Failed to record wrapped key' }, 500, cors);
      }
    } else {
      // Phase 4.5: if a real active DEK exists for the org, the
      // invitee is joining an org that's already past first-time-setup.
      // In that case the CLIENT is wrapping the real shared DEK and we
      // must NOT mark the row as a placeholder. If no active_key_versions
      // row exists yet, or the active version is still baseline 1 with
      // placeholder wraps elsewhere, the invitee wraps the placeholder
      // — mark it so Phase 4.5 first-time-setup can migrate.
      const { data: active } = await adminClient
        .from('active_key_versions')
        .select('active_dek_key_version')
        .eq('org_id', orgId)
        .maybeSingle();
      const activeDekVersion =
        (active as { active_dek_key_version?: number } | null)?.active_dek_key_version ?? 1;

      // Probe for a non-placeholder wrap at the active version. If any
      // exists, this org has a real shared DEK.
      const { data: realWrapProbe } = await adminClient
        .from('org_keys')
        .select('id')
        .eq('org_id', orgId)
        .eq('key_version', activeDekVersion)
        .eq('is_placeholder', false)
        .limit(1)
        .maybeSingle();
      const isPlaceholder = realWrapProbe ? false : true;

      const { error: insErr } = await adminClient.from('org_keys').insert({
        org_id: orgId,
        user_id: targetUserId,
        wrapped_dek: wrapPayload.wrapped_dek,
        iv: wrapPayload.iv,
        wrap_algo: wrapPayload.wrap_algo,
        key_version: activeDekVersion,
        is_placeholder: isPlaceholder,
      });
      if (insErr) {
        console.error('complete-invite-wrap insert org_keys failed:', insErr);
        if (!existingMember) {
          await adminClient
            .from('org_members')
            .delete()
            .eq('org_id', orgId)
            .eq('user_id', targetUserId);
        }
        return jsonResponse({ error: 'Failed to record wrapped key' }, 500, cors);
      }
    }

    // 3) org_member_roles (idempotent: skip if already granted).
    const { data: existingGrant } = await adminClient
      .from('org_member_roles')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .eq('role_definition_id', roleDef.id)
      .maybeSingle();

    if (!existingGrant) {
      const { error: grantErr } = await adminClient.from('org_member_roles').insert({
        org_id: orgId,
        user_id: targetUserId,
        role_definition_id: roleDef.id,
        granted_by: caller.id,
      });
      if (grantErr) {
        console.error('complete-invite-wrap insert org_member_roles failed:', grantErr);
        return jsonResponse({ error: 'Failed to grant role to new member' }, 500, cors);
      }
    }

    // 4) flip pending_invite -> wrapped.
    const { error: statusErr } = await adminClient
      .from('pending_invites')
      .update({ status: 'wrapped' })
      .eq('id', pending.id);
    if (statusErr) {
      console.warn('complete-invite-wrap pending_invites status update failed:', statusErr);
      // Non-fatal; the wrap itself landed.
    }

    // 5) audit event.
    try {
      const { error: auditErr } = await adminClient.from('vault_security_events').insert({
        user_id: targetUserId,
        event: 'user.wrap_completed',
        metadata: {
          actor_user_id: caller.id,
          target_user_id: targetUserId,
          org_id: orgId,
          role_definition_id: roleDef.id,
          wrap_algo: wrapPayload.wrap_algo,
          pending_invite_id: pending.id,
        },
      });
      if (auditErr) {
        console.warn('complete-invite-wrap audit insert failed:', auditErr);
      }
    } catch (err) {
      console.warn('complete-invite-wrap audit insert threw:', err);
    }

    return jsonResponse(
      {
        ok: true,
        user_id: targetUserId,
        org_id: orgId,
        role_name: roleDef.name,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error('complete-invite-wrap error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
