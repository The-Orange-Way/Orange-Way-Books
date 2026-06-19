/**
 * invite-org-member — Supabase Edge Function
 *
 * Phase 4.3 adds the hybrid-KEM wrap pipeline on top of the 4.2 capability
 * grant. The client now decides — BEFORE calling this function — whether
 * the recipient has a public key available and either:
 *
 *   (a) Wraps the org DEK client-side and passes the wrap payload in the
 *       request body, OR
 *   (b) Passes no wrap payload because the recipient hasn't published
 *       their keypair yet — this function records a `pending_invites`
 *       row; a trigger (see 20260424000000_phase4_3_invites.sql) flips
 *       that row to `ready_to_wrap` when the recipient first unlocks
 *       their vault.
 *
 * Authorization:
 *   - Caller must hold the `users.invite` capability in the target org,
 *     evaluated via the `user_has_capability` SQL function.
 *
 * Request body (JSON):
 *   {
 *     "email":               "user@example.com",
 *     "org_id":              "<uuid>",
 *     "role_definition_id":  "<uuid>",
 *     "expires_at"?:         "<ISO string>",  // Phase 4.4 — Auditor only
 *     "source"?:             "direct" | "auditor_invite", // default "direct"
 *     "wrapped_dek"?: {              // optional (path (a))
 *       "wrapped_dek": "<base64>",
 *       "iv":          "<base64>",
 *       "wrap_algo":   "hybrid-x25519-mlkem768"
 *     }
 *   }
 *
 *   Phase 4.4 rules (D12 Auditor time-box):
 *     - When the chosen role is Auditor, `expires_at` MUST be supplied
 *       and MUST be in the future and <= 1 year from now.
 *     - For every other role, `expires_at` is ignored (stored as NULL).
 *     - `source` is 'auditor_invite' when Auditor is invited with an
 *       expiry; 'direct' otherwise. `support_grant` never comes through
 *       this function (use admin-update-user grant_support_session).
 *
 * Response (200):
 *   { success, user_id, email, invited, role_name, wrap_status, message }
 *   wrap_status is one of: 'wrapped' | 'pending'
 *
 * Audit:
 *   Writes a `user.invited` row to vault_security_events with
 *   wrap_status, caller, target, org, and role bundled into metadata.
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

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

// Allowed wrap algorithm identifiers — keep in sync with
// src/lib/key-wrapping.ts KEY_WRAP_STRATEGIES. Hard-coded here to defend
// against a client trying to smuggle an unknown strategy string into
// org_keys (which would break all future unwrap paths).
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
    // 1) Caller auth.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    // Rate limit: 10 invites per user per minute.
    const rl = await rateLimit(adminClient, {
      scope: 'invite-org-member',
      subject: caller.id,
      maxPerWindow: 10,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    // 2) Parse + validate the body.
    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: {
      email?: string;
      org_id?: string;
      role_definition_id?: string;
      expires_at?: unknown;
      source?: unknown;
      wrapped_dek?: unknown;
    };
    try {
      body = JSON.parse(raw | '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    const roleDefId = typeof body.role_definition_id === 'string'
      ? body.role_definition_id.trim()
      : '';
    if (!email || !orgId || !roleDefId) {
      return jsonResponse(
        { error: 'email, org_id, and role_definition_id are required' },
        400,
        cors,
      );
    }
    if (!EMAIL_RE.test(email)) {
      return jsonResponse({ error: 'Invalid email' }, 400, cors);
    }
    if (!UUID_RE.test(orgId) || !UUID_RE.test(roleDefId)) {
      return jsonResponse({ error: 'org_id and role_definition_id must be UUIDs' }, 400, cors);
    }

    // Wrap payload is optional; when present it must be well-formed.
    // If the client ships something that looks like a wrap but doesn't
    // validate, reject outright — silently treating it as pending would
    // hide a real client bug behind a "pending_invite" row.
    let wrapPayload: WrappedDekPayload | null = null;
    if (body.wrapped_dek !== undefined && body.wrapped_dek !== null) {
      if (!isValidWrapPayload(body.wrapped_dek)) {
        return jsonResponse({ error: 'Invalid wrapped_dek payload' }, 400, cors);
      }
      wrapPayload = body.wrapped_dek;
    }

    // Optional expires_at (ISO string). Validated later
    // against the chosen role — Auditor requires it, other roles ignore
    // it.
    let expiresAtIso: string | null = null;
    if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== '') {
      if (typeof body.expires_at !== 'string') {
        return jsonResponse({ error: 'expires_at must be an ISO string' }, 400, cors);
      }
      const parsed = Date.parse(body.expires_at);
      if (Number.isNaN(parsed)) {
        return jsonResponse({ error: 'expires_at could not be parsed as a date' }, 400, cors);
      }
      const now = Date.now();
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      if (parsed <= now) {
        return jsonResponse({ error: 'expires_at must be in the future' }, 400, cors);
      }
      if (parsed > now + oneYear) {
        return jsonResponse({ error: 'expires_at must be at most 1 year from today' }, 400, cors);
      }
      expiresAtIso = new Date(parsed).toISOString();
    }

    // Phase 4.4 source enum. 'support_grant' is reserved for the
    // admin-update-user grant_support_session action and is rejected here.
    let source: 'direct' | 'auditor_invite' = 'direct';
    if (body.source !== undefined && body.source !== null) {
      if (body.source === 'direct' || body.source === 'auditor_invite') {
        source = body.source;
      } else {
        return jsonResponse(
          { error: 'source must be "direct" or "auditor_invite"' },
          400,
          cors,
        );
      }
    }

    // 3) Validate role_definition visibility for this org.
    const { data: roleDef, error: roleErr } = await adminClient
      .from('role_definitions')
      .select('id, name, is_system, org_id')
      .eq('id', roleDefId)
      .maybeSingle();
    if (roleErr) {
      console.error('invite-org-member role_definitions lookup failed:', roleErr);
      return jsonResponse({ error: 'Failed to load role definition' }, 500, cors);
    }
    if (!roleDef) {
      return jsonResponse({ error: 'Unknown role_definition_id' }, 400, cors);
    }
    if (!roleDef.is_system && roleDef.org_id !== orgId) {
      return jsonResponse(
        { error: 'Role is not available in this organization' },
        400,
        cors,
      );
    }

    // Auditor role requires an expiry date within 1 year.
    // Normalize source to 'auditor_invite' when Auditor + expiry are
    // both present. Non-Auditor roles ignore any client-supplied
    // expires_at (stored as NULL) — we silently drop it rather than
    // erroring, so a client that always sends the field for consistency
    // isn't forced to branch.
    const isAuditor = roleDef.name === 'Auditor';
    if (isAuditor) {
      if (!expiresAtIso) {
        return jsonResponse(
          { error: 'Auditor access requires an expiry date.' },
          400,
          cors,
        );
      }
      source = 'auditor_invite';
    } else {
      // Drop expires_at for non-Auditor invites; D12 only scopes to Auditor.
      expiresAtIso = null;
      if (source === 'auditor_invite') {
        // Defensive — refuse the combination rather than silently flipping.
        return jsonResponse(
          { error: 'source="auditor_invite" is only valid for the Auditor role.' },
          400,
          cors,
        );
      }
    }

    // 4) Capability check.
    const { data: canInvite, error: capErr } = await adminClient.rpc(
      'user_has_capability',
      { p_user_id: caller.id, p_capability: 'users.invite', p_org_id: orgId },
    );
    if (capErr) {
      console.error('invite-org-member capability check failed:', capErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    if (!canInvite) {
      return jsonResponse(
        { error: 'You do not have permission to invite members to this organization' },
        403,
        cors,
      );
    }

    // 5) Find or invite the auth user. Paginate listUsers defensively.
    const normalizedEmail = email.toLowerCase();
    let existingUser: { id: string; email?: string | null } | null = null;
    let page = 1;
    while (page <= 50) {
      const { data: listPage, error: listErr } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (listErr) break;
      const hit = listPage.users.find(
        (u: { id: string; email?: string | null }) => u.email?.toLowerCase() === normalizedEmail,
      );
      if (hit) {
        existingUser = { id: hit.id, email: hit.email ?? null };
        break;
      }
      if (listPage.users.length < 1000) break;
      page += 1;
    }

    let userId: string | null = null;
    let invitedNew = false;

    if (existingUser) {
      userId = existingUser.id;
      const { data: dup } = await adminClient
        .from('org_members')
        .select('id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();
      if (dup) {
        return jsonResponse({ error: 'User is already a member of this organization' }, 409, cors);
      }
    }

    // 6) Wrap-present path: persist org_keys + org_members + org_member_roles.
    //    Wrap-missing path: persist a pending_invites row.
    //    BOTH paths dispatch the invite email if the user is new.
    //
    //    Ordering matters for cleanup — we insert org_members first
    //    (without the grant) so a failure later can reverse everything
    //    via a targeted DELETE. If org_members insert itself fails
    //    there's nothing to roll back.

    if (wrapPayload) {
      // Wrap was provided. Must have a concrete user_id to target.
      // The client's invite-wrap flow only produces a payload when
      // `lookupRecipientPublicKey` found a row, which implies the
      // recipient already exists in auth.users.
      if (!userId) {
        return jsonResponse(
          { error: 'wrapped_dek provided but recipient not found in auth.users' },
          400,
          cors,
        );
      }

      // Create org_members row.
      const { error: memberInsertErr } = await adminClient.from('org_members').insert({
        org_id: orgId,
        user_id: userId,
      });
      if (memberInsertErr) {
        console.error('invite-org-member insert org_members failed:', memberInsertErr);
        return jsonResponse({ error: 'Failed to add member' }, 500, cors);
      }

      // Upsert org_keys row with the wrap payload. Use insert rather
      // than upsert: by RLS + the uniqueness check above, we've already
      // confirmed this (org_id, user_id) pair is new.
      //
      // Phase 4.5: detect the active DEK version and whether a real
      // (non-placeholder) wrap exists for it. If yes, the invitee is
      // wrapping the REAL shared DEK -> is_placeholder = FALSE. If no,
      // they're wrapping the Phase 4.3 placeholder -> is_placeholder =
      // TRUE, and Phase 4.5 first-time-setup will migrate later.
      const { data: active } = await adminClient
        .from('active_key_versions')
        .select('active_dek_key_version')
        .eq('org_id', orgId)
        .maybeSingle();
      const activeDekVersion =
        (active as { active_dek_key_version?: number } | null)?.active_dek_key_version ?? 1;
      const { data: realWrapProbe } = await adminClient
        .from('org_keys')
        .select('id')
        .eq('org_id', orgId)
        .eq('key_version', activeDekVersion)
        .eq('is_placeholder', false)
        .limit(1)
        .maybeSingle();
      const isPlaceholder = realWrapProbe ? false : true;

      const { error: keyInsertErr } = await adminClient.from('org_keys').insert({
        org_id: orgId,
        user_id: userId,
        wrapped_dek: wrapPayload.wrapped_dek,
        iv: wrapPayload.iv,
        wrap_algo: wrapPayload.wrap_algo,
        key_version: activeDekVersion,
        is_placeholder: isPlaceholder,
      });
      if (keyInsertErr) {
        console.error('invite-org-member insert org_keys failed:', keyInsertErr);
        await adminClient.from('org_members').delete()
          .eq('org_id', orgId).eq('user_id', userId);
        return jsonResponse({ error: 'Failed to record wrapped key' }, 500, cors);
      }

      // Insert the capability grant. Phase 4.4: carry expires_at +
      // source so the sweep job knows which rows are time-boxed and
      // why.
      const { error: grantErr } = await adminClient.from('org_member_roles').insert({
        org_id: orgId,
        user_id: userId,
        role_definition_id: roleDef.id,
        granted_by: caller.id,
        expires_at: expiresAtIso,
        source,
      });
      if (grantErr) {
        console.error('invite-org-member insert org_member_roles failed:', grantErr);
        await adminClient.from('org_keys').delete()
          .eq('org_id', orgId).eq('user_id', userId);
        await adminClient.from('org_members').delete()
          .eq('org_id', orgId).eq('user_id', userId);
        return jsonResponse({ error: 'Failed to grant role to new member' }, 500, cors);
      }

      // Audit: invite completed synchronously (wrap already in place).
      await writeAudit(caller.id, userId, orgId, roleDef.id, 'wrapped');

      // Even if the recipient already exists, we still want an email
      // letting them know they've been added. Use inviteUserByEmail —
      // for existing accounts Supabase treats this as a magic-link
      // notification rather than a fresh signup.
      //
      // We intentionally ignore errors here: the invite is already
      // recorded in-DB, and a failed notification email is not a
      // reason to roll back the whole flow.
      try {
        const redirectTo = resolveRedirect(req);
        await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo });
      } catch (mailErr) {
        console.warn('invite-org-member notification email failed:', mailErr);
      }

      return jsonResponse({
        success: true,
        user_id: userId,
        email: normalizedEmail,
        invited: invitedNew,
        role_name: roleDef.name,
        wrap_status: 'wrapped',
        message: `${normalizedEmail} added to organization`,
      }, 200, cors);
    }

    // Wrap NOT provided — pending invite path.
    // The recipient may or may not exist yet. Either way we:
    //   (i)   Ensure an auth user exists (invite them if new)
    //   (ii)  Upsert a pending_invites row so the Owner's client can
    //         see it and, when the recipient later publishes a
    //         keypair, be notified via realtime to complete the wrap.
    //
    // We deliberately do NOT write org_members or org_member_roles
    // yet: the grant activates once the wrap lands. This keeps RLS
    // from mistakenly granting access to an org whose DEK the user
    // can't decrypt.

    if (!existingUser) {
      const redirectTo = resolveRedirect(req);
      const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
        normalizedEmail,
        { redirectTo },
      );
      if (inviteErr || !invited?.user) {
        console.error('invite-org-member inviteUserByEmail failed:', inviteErr);
        return jsonResponse({ error: 'Failed to send invitation' }, 500, cors);
      }
      userId = invited.user.id;
      invitedNew = true;
    } else {
      // Existing user without a keypair yet (client called us without
      // a wrap payload). Re-send the invite email as a friendly nudge;
      // any failure here is non-fatal.
      try {
        const redirectTo = resolveRedirect(req);
        await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo });
      } catch (mailErr) {
        console.warn('invite-org-member nudge email failed:', mailErr);
      }
    }

    // If the recipient already exists AND has a user_vault_keys row,
    // we can flip straight to ready_to_wrap — the Owner's client will
    // pick this up via realtime and complete the wrap without a
    // round-trip through the DB trigger. If no keypair yet, stay at
    // awaiting_recipient and let the trigger handle the transition.
    let initialStatus: 'awaiting_recipient' | 'ready_to_wrap' = 'awaiting_recipient';
    if (userId) {
      const { data: existingKey } = await adminClient
        .from('user_vault_keys')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();
      if (existingKey) {
        initialStatus = 'ready_to_wrap';
      }
    }

    // Upsert the pending invite. Composite UNIQUE (org_id, email) lets
    // us "onConflict" safely: re-inviting the same email for the same
    // org bumps the role + inviter + expiry instead of erroring.
    const { error: pendingErr } = await adminClient.from('pending_invites').upsert({
      org_id: orgId,
      email: normalizedEmail,
      role_definition_id: roleDef.id,
      inviter_id: caller.id,
      recipient_user_id: userId,
      status: initialStatus,
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'org_id,email' });
    if (pendingErr) {
      console.error('invite-org-member insert pending_invites failed:', pendingErr);
      return jsonResponse({ error: 'Failed to record pending invite' }, 500, cors);
    }

    await writeAudit(caller.id, userId, orgId, roleDef.id, 'pending');

    return jsonResponse({
      success: true,
      user_id: userId,
      email: normalizedEmail,
      invited: invitedNew,
      role_name: roleDef.name,
      wrap_status: 'pending',
      message: invitedNew
        ? `Invitation sent to ${normalizedEmail}`
        : `Invite recorded for ${normalizedEmail}; they'll get access once their vault is set up.`,
    }, 200, cors);
  } catch (err) {
    console.error('invite-org-member error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});

/**
 * Prefer the caller's Origin header so previews land on the right
 * deployment; fall back to INVITE_REDIRECT_URL for server-initiated
 * nudges.
 */
function resolveRedirect(req: Request): string {
  const origin = req.headers.get('Origin');
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin.replace(/\/+$/, '')}/`;
  }
  const envRedirect = Deno.env.get('INVITE_REDIRECT_URL');
  if (envRedirect) return envRedirect;
  return `${SUPABASE_URL.replace('.supabase.co', '.app')}/`;
}

/**
 * Audit event for user.invited. Scoped on the target user so it
 * appears in that user's own audit trail; caller + wrap_status
 * land in metadata. A failed insert is logged but not propagated.
 */
async function writeAudit(
  callerId: string,
  targetUserId: string | null,
  orgId: string,
  roleDefinitionId: string,
  wrapStatus: 'wrapped' | 'pending',
): Promise<void> {
  try {
    // vault_security_events.user_id is NOT NULL and references auth.users.
    // When the recipient doesn't exist yet (pending path for a brand-new
    // email that failed to get a user_id) we scope the event to the
    // actor so at minimum the caller's own audit trail records it.
    const scopedUserId = targetUserId ?? callerId;
    const { error } = await adminClient.from('vault_security_events').insert({
      user_id: scopedUserId,
      event: 'user.invited',
      metadata: {
        actor_user_id:      callerId,
        target_user_id:     targetUserId,
        org_id:             orgId,
        role_definition_id: roleDefinitionId,
        wrap_status:        wrapStatus,
      },
    });
    if (error) {
      console.warn('invite-org-member audit insert failed:', error);
    }
  } catch (err) {
    console.warn('invite-org-member audit insert threw:', err);
  }
}
