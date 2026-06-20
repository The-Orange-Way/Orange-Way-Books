/**
 * admin-update-user — Supabase Edge Function
 *
 * Server-side mutations for the Admin → Users → Edit User dialog.
 * Lets a caller with the `users.invite` capability update another
 * member's display name, trigger an email change (with confirmation
 * link), send a password-reset email, or resend an invite email.
 *
 * We route all of this through an Edge Function (rather than the
 * browser supabase-js SDK) because every action requires the service
 * role key — `auth.admin.updateUserById`, `auth.admin.generateLink`,
 * and `auth.admin.inviteUserByEmail` are all admin-only endpoints.
 *
 * Authorization rules (ALL of them):
 *   1. Valid Supabase JWT on the request.
 *   2. Caller must hold `users.invite` in `org_id` (reuses the same
 *      capability the Add User flow checks — no new capability key
 *      is introduced). Evaluated via the `user_has_capability` SQL
 *      function.
 *   3. Caller and target must both be rows in `org_members` for
 *      `org_id`. This is a cheap "you can only edit people in your
 *      own org" scope check on top of (2).
 *
 * Request body:
 *   {
 *     "target_user_id": "<uuid>",  // not required for grant_support_session
 *     "org_id":         "<uuid>",
 *     "action":         "update_name" | "update_email"
 *                       | "send_password_reset" | "resend_invite"
 *                       | "soft_revoke"
 *                       | "extend_role_expiry"        // Phase 4.4 D12
 *                       | "grant_support_session"     // Phase 4.4 D13
 *                       | "end_support_session",      // Phase 4.4 D13
 *     "payload": {
 *       "name"?:  string,                     // update_name
 *       "email"?: string,                     // update_email
 *       "role_grant_id"?: string,             // extend_role_expiry
 *       "new_expires_at"?: string,            // extend_role_expiry (ISO)
 *       "support_email"?: string,             // grant_support_session
 *       "duration_hours"?: 1 | 6 | 12 | 24,   // grant_support_session
 *       "session_id"?: string                 // end_support_session
 *     }
 *   }
 *
 * Responses:
 *   - update_name           → { ok: true, name }
 *   - update_email          → { ok: true, pending: true,
 *                               message: 'Confirmation email sent to new address' }
 *   - send_password_reset   → { ok: true, sent: true }
 *   - resend_invite         → { ok: true, sent: true }
 *   - soft_revoke           → { ok: true, revoked: true }
 *   - extend_role_expiry    → { ok: true, new_expires_at }
 *   - grant_support_session → { ok: true, session_id, expires_at, support_user_id }
 *   - end_support_session   → { ok: true, ended: true }
 *
 *   4xx / 5xx → { error: string }. Copy on the `error` field is shown
 *   verbatim to the user as a toast, so keep it plain-English.
 *
 * Audit: every successful action writes a row to
 * `vault_security_events`. The current schema on that table is
 * (user_id, event, metadata). We store the *target* user in `user_id`
 * so the row shows up in the target's own audit view, and put the
 * caller + org + action in `metadata`. If the insert fails we log a
 * warning and continue — audit rows are nice-to-have, not a
 * blocking dependency for the user-visible action to complete.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

// Upper bound on display name length. Matches the schema-level sanity
// limit we apply elsewhere — long enough for real names, short enough
// to reject the obvious junk payloads.
const MAX_NAME_LEN = 200;

type Action =
  | 'update_name'
  | 'update_email'
  | 'send_password_reset'
  | 'resend_invite'
  | 'soft_revoke'
  | 'extend_role_expiry'
  | 'grant_support_session'
  | 'end_support_session';
const VALID_ACTIONS: readonly Action[] = [
  'update_name',
  'update_email',
  'send_password_reset',
  'resend_invite',
  'soft_revoke',
  'extend_role_expiry',
  'grant_support_session',
  'end_support_session',
] as const;

// Actions gated by the `users.revoke` capability — everything else uses
// `users.invite`. Keeps the authorization model explicit: editing user
// profile fields is a subset of invite; removing them from an org is a
// distinct privilege.
//
// Phase 4.4 actions (extend_role_expiry, grant_support_session,
// end_support_session) are gated on `users.invite` — they're about
// granting or adjusting access, not removing it.
const REVOKE_ACTIONS: ReadonlySet<Action> = new Set(['soft_revoke']);

// Phase 4.4 actions that target a session_id (or work at the org
// level) rather than a single target user. These skip the target-
// user membership check — the action-specific handler validates the
// relevant object (role_grant_id / session_id / support_email).
const ORG_SCOPED_ACTIONS: ReadonlySet<Action> = new Set([
  'extend_role_expiry',
  'grant_support_session',
  'end_support_session',
]);

Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    // 1) Caller auth. The gateway also enforces verify_jwt = true as
    //    defense-in-depth; this check makes the contract explicit so
    //    the function still behaves correctly if someone deploys with
    //    --no-verify-jwt by mistake.
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

    // Rate limit: 30 admin-update calls per caller per minute. Matches
    // lookup-user-profiles — plenty of headroom for an admin doing
    // bulk edits, nowhere near enough to brute-force inbox enumeration.
    const rl = await rateLimit(adminClient, {
      scope: 'admin-update-user',
      subject: caller.id,
      maxPerWindow: 30,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    // 2) Parse + validate the body before any auth queries. A
    //    malformed body should 400 regardless of permissions.
    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: {
      target_user_id?: unknown;
      org_id?: unknown;
      action?: unknown;
      payload?: {
        name?: unknown;
        email?: unknown;
        // Phase 4.4 payloads:
        role_grant_id?: unknown;
        new_expires_at?: unknown;
        support_email?: unknown;
        duration_hours?: unknown;
        session_id?: unknown;
      };
    };
    try {
      body = JSON.parse(raw | '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const targetUserIdRaw = typeof body.target_user_id === 'string' ? body.target_user_id.trim() : '';
    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    const action = typeof body.action === 'string' ? (body.action as Action) : null;
    const payloadName = typeof body.payload?.name === 'string' ? body.payload.name : undefined;
    const payloadEmail = typeof body.payload?.email === 'string' ? body.payload.email : undefined;
    const payloadRoleGrantId = typeof body.payload?.role_grant_id === 'string'
      ? body.payload.role_grant_id.trim() : undefined;
    const payloadNewExpiresAt = typeof body.payload?.new_expires_at === 'string'
      ? body.payload.new_expires_at.trim() : undefined;
    const payloadSupportEmail = typeof body.payload?.support_email === 'string'
      ? body.payload.support_email.trim() : undefined;
    const payloadDurationHours = typeof body.payload?.duration_hours === 'number'
      ? body.payload.duration_hours : undefined;
    const payloadSessionId = typeof body.payload?.session_id === 'string'
      ? body.payload.session_id.trim() : undefined;

    if (!orgId) {
      return jsonResponse({ error: 'org_id is required' }, 400, cors);
    }
    if (!UUID_RE.test(orgId)) {
      return jsonResponse({ error: 'org_id must be a UUID' }, 400, cors);
    }
    if (!action || !VALID_ACTIONS.includes(action)) {
      return jsonResponse({ error: 'Unknown action' }, 400, cors);
    }
    const isOrgScoped = ORG_SCOPED_ACTIONS.has(action);
    // target_user_id is required for every action except the Phase 4.4
    // org-scoped ones (which identify their target via role_grant_id
    // or session_id).
    if (!isOrgScoped) {
      if (!targetUserIdRaw) {
        return jsonResponse({ error: 'target_user_id is required' }, 400, cors);
      }
      if (!UUID_RE.test(targetUserIdRaw)) {
        return jsonResponse({ error: 'target_user_id must be a UUID' }, 400, cors);
      }
    }
    const targetUserId = targetUserIdRaw;
    if (action === 'update_name') {
      const trimmed = (payloadName ?? '').trim();
      if (!trimmed) {
        return jsonResponse({ error: 'Name is required' }, 400, cors);
      }
      if (trimmed.length > MAX_NAME_LEN) {
        return jsonResponse({ error: `Name must be ${MAX_NAME_LEN} characters or fewer` }, 400, cors);
      }
    }
    if (action === 'update_email') {
      const trimmed = (payloadEmail ?? '').trim();
      if (!trimmed || !EMAIL_RE.test(trimmed)) {
        return jsonResponse({ error: 'A valid email address is required' }, 400, cors);
      }
    }

    // 3) Capability check. Revoke actions require `users.revoke`
    //    (distinct capability per D7); everything else uses
    //    `users.invite` — editing a user is a subset of inviting them.
    //
    //    end_support_session is a special case: either the
    //    customer Owner (users.invite) OR the support user themselves
    //    can end an active session. We do the capability check once
    //    and set a flag — the handler below re-checks the "is support
    //    user" path.
    const requiredCapability = REVOKE_ACTIONS.has(action) ? 'users.revoke' : 'users.invite';
    const { data: hasCap, error: capErr } = await adminClient.rpc(
      'user_has_capability',
      { p_user_id: caller.id, p_capability: requiredCapability, p_org_id: orgId },
    );
    if (capErr) {
      console.error('admin-update-user capability check failed:', capErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    if (!hasCap && action !== 'end_support_session') {
      const copy = requiredCapability === 'users.revoke'
        ? "You don't have permission to remove this user."
        : "You don't have permission to edit this user.";
      return jsonResponse({ error: copy }, 403, cors);
    }
    // For end_support_session specifically, defer the authorization
    // decision: we allow the call through if the caller is the support
    // user on the targeted session. The handler below re-validates.

    // 4) Org-scope check: caller must be in org_members for this org.
    //    For target-scoped actions, target must also be a member.
    //    Org-scoped Phase 4.4 actions (extend_role_expiry / support
    //    session grant+end) validate their specific object instead.
    const scopeSubjects = isOrgScoped ? [caller.id] : [caller.id, targetUserId];
    const { data: scopeRows, error: scopeErr } = await adminClient
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .in('user_id', scopeSubjects);
    if (scopeErr) {
      console.error('admin-update-user org_members lookup failed:', scopeErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    const memberIds = new Set((scopeRows ?? []).map((r: { user_id: string }) => r.user_id));
    if (!memberIds.has(caller.id)) {
      return jsonResponse(
        { error: "You don't have permission to perform this action." },
        403,
        cors,
      );
    }
    if (!isOrgScoped && !memberIds.has(targetUserId)) {
      return jsonResponse(
        { error: "You don't have permission to edit this user." },
        403,
        cors,
      );
    }

    // 5) Perform the action. Each branch returns its own success
    //    payload; the generic audit row write happens after the
    //    switch for any branch that falls through to it.
    if (action === 'update_name') {
      const newName = (payloadName ?? '').trim();

      // Fetch current metadata so we can merge rather than clobber.
      // Other keys (avatar_url, locale, etc.) must survive this write.
      const { data: currentData, error: getErr } = await adminClient.auth.admin.getUserById(targetUserId);
      if (getErr || !currentData?.user) {
        console.error('admin-update-user getUserById failed:', getErr);
        return jsonResponse({ error: 'User not found' }, 404, cors);
      }
      const existingMeta = (currentData.user.user_metadata ?? {}) as Record<string, unknown>;

      const { error: updErr } = await adminClient.auth.admin.updateUserById(targetUserId, {
        user_metadata: { ...existingMeta, full_name: newName },
      });
      if (updErr) {
        console.error('admin-update-user updateUserById(name) failed:', updErr);
        return jsonResponse({ error: 'Failed to update name' }, 500, cors);
      }

      await writeAudit(caller.id, targetUserId, orgId, action, { name: newName });
      return jsonResponse({ ok: true, name: newName }, 200, cors);
    }

    if (action === 'update_email') {
      const newEmail = (payloadEmail ?? '').trim();
      // email_confirm: false is the magic knob — it tells Supabase to
      // send a confirmation email to the NEW address instead of
      // silently flipping the auth.users.email column. The user has
      // to click the link before the change takes effect, which is
      // exactly the UX we want for account recovery safety.
      const { error: updErr } = await adminClient.auth.admin.updateUserById(targetUserId, {
        email: newEmail,
        email_confirm: false,
      });
      if (updErr) {
        console.error('admin-update-user updateUserById(email) failed:', updErr);
        const msg = (updErr.message ?? '').toLowerCase();
        if (msg.includes('already') && (msg.includes('registered') || msg.includes('in use') || msg.includes('exists'))) {
          return jsonResponse({ error: 'That email is already used by another account.' }, 400, cors);
        }
        return jsonResponse({ error: 'Failed to update email' }, 500, cors);
      }

      await writeAudit(caller.id, targetUserId, orgId, action, { new_email: newEmail });
      return jsonResponse({
        ok: true,
        pending: true,
        message: 'Confirmation email sent to new address',
      }, 200, cors);
    }

    if (action === 'send_password_reset') {
      const { data: tgtData, error: getErr } = await adminClient.auth.admin.getUserById(targetUserId);
      if (getErr || !tgtData?.user?.email) {
        console.error('admin-update-user getUserById(reset) failed:', getErr);
        return jsonResponse({ error: 'User has no email on file' }, 404, cors);
      }
      const targetEmail = tgtData.user.email;

      const { error: linkErr } = await adminClient.auth.admin.generateLink({
        type: 'recovery',
        email: targetEmail,
      });
      if (linkErr) {
        console.error('admin-update-user generateLink failed:', linkErr);
        return jsonResponse({ error: 'Failed to send password reset email' }, 500, cors);
      }

      await writeAudit(caller.id, targetUserId, orgId, action, {});
      return jsonResponse({ ok: true, sent: true }, 200, cors);
    }

    if (action === 'resend_invite') {
      const { data: tgtData, error: getErr } = await adminClient.auth.admin.getUserById(targetUserId);
      if (getErr || !tgtData?.user?.email) {
        console.error('admin-update-user getUserById(invite) failed:', getErr);
        return jsonResponse({ error: 'User has no email on file' }, 404, cors);
      }
      const targetEmail = tgtData.user.email;

      // Derive redirectTo from the caller's Origin when possible so
      // the confirmation lands on the right deployment (preview vs.
      // prod). Fall back to the same envvar invite-org-member uses.
      let redirectTo: string | undefined = undefined;
      const origin = req.headers.get('Origin');
      if (origin && /^https?:\/\//i.test(origin)) {
        redirectTo = `${origin.replace(/\/+$/, '')}/`;
      } else {
        const envRedirect = Deno.env.get('INVITE_REDIRECT_URL');
        if (envRedirect) redirectTo = envRedirect;
      }

      const { error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
        targetEmail,
        redirectTo ? { redirectTo } : undefined,
      );
      if (inviteErr) {
        const msg = (inviteErr.message ?? '').toLowerCase();
        if (msg.includes('already') && (msg.includes('confirm') || msg.includes('registered'))) {
          return jsonResponse({ error: 'User has already accepted the invite' }, 400, cors);
        }
        console.error('admin-update-user inviteUserByEmail failed:', inviteErr);
        return jsonResponse({ error: 'Failed to resend invite' }, 500, cors);
      }

      await writeAudit(caller.id, targetUserId, orgId, action, {});
      return jsonResponse({ ok: true, sent: true }, 200, cors);
    }

    if (action === 'soft_revoke') {
      // Soft revoke = remove the target user's role grants + org_members
      // row for this org. The D9 trigger on org_member_roles (see
      // 20260423010000_phase4_2_capability_rls.sql) fires when the last
      // active grant transitions to revoked: it DROPs the user's
      // org_keys wrap and writes the org_access_revoked audit event.
      //
      // We flip revoked_at rather than DELETE so the trigger's
      // AFTER UPDATE OF revoked_at path picks up the event; that
      // preserves the grant history for audit. Then we DELETE the
      // org_members row so the Users tab stops listing them.
      //
      // Hard re-key (rotate the org DEK so the removed user cannot
      // decrypt future data they may still hold in browser cache) is
      // Phase 4.5. This soft revoke is effective at the RLS layer
      // today.
      if (caller.id === targetUserId) {
        return jsonResponse(
          { error: "You can't remove yourself from the organization." },
          400,
          cors,
        );
      }

      // Double-check the target is actually a member of this org.
      // `scopeRows` above already told us as much, but re-asserting
      // defends against any future refactor that weakens the check.
      const { data: targetGrants, error: grantReadErr } = await adminClient
        .from('org_member_roles')
        .select('id')
        .eq('org_id', orgId)
        .eq('user_id', targetUserId)
        .is('revoked_at', null);
      if (grantReadErr) {
        console.error('admin-update-user soft_revoke grant read failed:', grantReadErr);
        return jsonResponse({ error: 'Failed to read role grants' }, 500, cors);
      }

      // Flip revoked_at on every active grant. If there are none (the
      // member row exists without any active grant) we still delete the
      // org_members row below so the UI surface reflects reality.
      if ((targetGrants ?? []).length > 0) {
        const { error: revokeErr } = await adminClient
          .from('org_member_roles')
          .update({ revoked_at: new Date().toISOString() })
          .eq('org_id', orgId)
          .eq('user_id', targetUserId)
          .is('revoked_at', null);
        if (revokeErr) {
          console.error('admin-update-user soft_revoke grant update failed:', revokeErr);
          return jsonResponse({ error: 'Failed to revoke role grants' }, 500, cors);
        }
      }

      // Drop org_members so the user disappears from the list.
      // (org_keys is cleaned up by the D9 trigger above.)
      const { error: memberDelErr } = await adminClient
        .from('org_members')
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (memberDelErr) {
        console.error('admin-update-user soft_revoke org_members delete failed:', memberDelErr);
        return jsonResponse({ error: 'Failed to remove member' }, 500, cors);
      }

      await writeAudit(caller.id, targetUserId, orgId, action, {
        hard_rekey: false,
        grants_revoked: (targetGrants ?? []).length,
      });
      return jsonResponse({ ok: true, revoked: true }, 200, cors);
    }

    if (action === 'extend_role_expiry') {
      // Customer can extend an Auditor expiry any time before it
      // elapses. Validates the grant row, bounds the new date to
      // (now, now+1y], updates the row, and audits.
      if (!payloadRoleGrantId || !UUID_RE.test(payloadRoleGrantId)) {
        return jsonResponse({ error: 'role_grant_id is required' }, 400, cors);
      }
      if (!payloadNewExpiresAt) {
        return jsonResponse({ error: 'new_expires_at is required' }, 400, cors);
      }
      const parsed = Date.parse(payloadNewExpiresAt);
      if (Number.isNaN(parsed)) {
        return jsonResponse({ error: 'new_expires_at could not be parsed' }, 400, cors);
      }
      const now = Date.now();
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      if (parsed <= now) {
        return jsonResponse({ error: 'new_expires_at must be in the future' }, 400, cors);
      }
      if (parsed > now + oneYear) {
        return jsonResponse({ error: 'new_expires_at must be at most 1 year from today' }, 400, cors);
      }
      const newIso = new Date(parsed).toISOString();

      // Grant must exist, scope to this org, and not already be revoked.
      const { data: grant, error: grantReadErr } = await adminClient
        .from('org_member_roles')
        .select('id, org_id, user_id, role_definition_id, expires_at, revoked_at, source')
        .eq('id', payloadRoleGrantId)
        .maybeSingle();
      if (grantReadErr) {
        console.error('admin-update-user extend_role_expiry read failed:', grantReadErr);
        return jsonResponse({ error: 'Failed to load role grant' }, 500, cors);
      }
      if (!grant || grant.org_id !== orgId) {
        return jsonResponse({ error: 'Role grant not found in this org' }, 404, cors);
      }
      if (grant.revoked_at) {
        return jsonResponse({ error: 'This role has already been revoked.' }, 409, cors);
      }

      const oldIso = grant.expires_at ?? null;
      const { error: updErr } = await adminClient
        .from('org_member_roles')
        .update({ expires_at: newIso })
        .eq('id', payloadRoleGrantId);
      if (updErr) {
        console.error('admin-update-user extend_role_expiry update failed:', updErr);
        return jsonResponse({ error: 'Failed to update expiry' }, 500, cors);
      }

      await writeAudit(caller.id, grant.user_id, orgId, action, {
        role_grant_id:     payloadRoleGrantId,
        old_expires_at:    oldIso,
        new_expires_at:    newIso,
        source:            grant.source,
      }, 'role.expiry_extended');
      return jsonResponse({ ok: true, new_expires_at: newIso }, 200, cors);
    }

    if (action === 'grant_support_session') {
      // Whole-org support grant with 1/6/12/24h duration picker.
      // If the support email matches an existing user, we reuse them;
      // otherwise we inviteUserByEmail to create the account. The
      // session row is the audit anchor; the org_member_roles row is
      // what activates the RLS capabilities.
      if (!payloadSupportEmail || !EMAIL_RE.test(payloadSupportEmail)) {
        return jsonResponse({ error: 'A valid support_email is required' }, 400, cors);
      }
      const VALID_DURATIONS = new Set([1, 6, 12, 24]);
      if (!payloadDurationHours || !VALID_DURATIONS.has(payloadDurationHours)) {
        return jsonResponse(
          { error: 'duration_hours must be 1, 6, 12, or 24' },
          400,
          cors,
        );
      }
      const supportEmail = payloadSupportEmail.toLowerCase();

      // Look up or invite the support user. Paginate listUsers so large
      // projects still resolve — same pattern as invite-org-member.
      let supportUserId: string | null = null;
      let page = 1;
      while (page <= 50) {
        const { data: listPage, error: listErr } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
        if (listErr) break;
        const hit = listPage.users.find(
          (u: { id: string; email?: string | null }) => u.email?.toLowerCase() === supportEmail,
        );
        if (hit) {
          supportUserId = hit.id;
          break;
        }
        if (listPage.users.length < 1000) break;
        page += 1;
      }
      if (!supportUserId) {
        const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(supportEmail);
        if (inviteErr || !invited?.user) {
          console.error('admin-update-user grant_support_session invite failed:', inviteErr);
          return jsonResponse({ error: 'Failed to invite support user' }, 500, cors);
        }
        supportUserId = invited.user.id;
      }

      // Resolve the OWBSupport preset id.
      const { data: roleDef, error: roleErr } = await adminClient
        .from('role_definitions')
        .select('id')
        .eq('name', 'OWBSupport')
        .eq('is_system', true)
        .is('org_id', null)
        .maybeSingle();
      if (roleErr || !roleDef) {
        console.error('admin-update-user grant_support_session role lookup failed:', roleErr);
        return jsonResponse({ error: 'OWBSupport role is not configured' }, 500, cors);
      }

      const grantedAt = new Date();
      const expiresAt = new Date(grantedAt.getTime() + payloadDurationHours * 60 * 60 * 1000);
      const grantedAtIso = grantedAt.toISOString();
      const expiresAtIso = expiresAt.toISOString();

      // support_sessions row — the audit anchor (enforces the 24h cap
      // via CHECK constraint).
      const { data: sessionRow, error: sessionErr } = await adminClient
        .from('support_sessions')
        .insert({
          org_id:          orgId,
          support_user_id: supportUserId,
          granted_by:      caller.id,
          granted_at:      grantedAtIso,
          expires_at:      expiresAtIso,
        })
        .select('id')
        .single();
      if (sessionErr || !sessionRow) {
        console.error('admin-update-user grant_support_session insert session failed:', sessionErr);
        return jsonResponse({ error: 'Failed to record support session' }, 500, cors);
      }

      // Ensure the support user appears in org_members so the active
      // grant resolves correctly in the UI and RLS. Idempotent.
      const { data: existingMember } = await adminClient
        .from('org_members')
        .select('id')
        .eq('org_id', orgId)
        .eq('user_id', supportUserId)
        .maybeSingle();
      if (!existingMember) {
        const { error: memberInsertErr } = await adminClient.from('org_members').insert({
          org_id: orgId,
          user_id: supportUserId,
        });
        if (memberInsertErr) {
          console.error('admin-update-user grant_support_session org_members insert failed:', memberInsertErr);
          return jsonResponse({ error: 'Failed to add support user to org' }, 500, cors);
        }
      }

      // Finally, the capability grant. Carries source='support_grant'
      // so the sweep attributes the expiry correctly.
      const { error: grantErr } = await adminClient.from('org_member_roles').insert({
        org_id:             orgId,
        user_id:            supportUserId,
        role_definition_id: roleDef.id,
        granted_by:         caller.id,
        granted_at:         grantedAtIso,
        expires_at:         expiresAtIso,
        source:             'support_grant',
      });
      if (grantErr) {
        console.error('admin-update-user grant_support_session grant insert failed:', grantErr);
        // Roll back the session row so a retry can start clean.
        await adminClient.from('support_sessions').delete().eq('id', sessionRow.id);
        return jsonResponse({ error: 'Failed to activate support role grant' }, 500, cors);
      }

      await writeAudit(caller.id, supportUserId, orgId, action, {
        session_id:     sessionRow.id,
        duration_hours: payloadDurationHours,
        expires_at:     expiresAtIso,
      }, 'support.session_granted');

      return jsonResponse({
        ok: true,
        session_id:      sessionRow.id,
        expires_at:      expiresAtIso,
        support_user_id: supportUserId,
      }, 200, cors);
    }

    if (action === 'end_support_session') {
      if (!payloadSessionId || !UUID_RE.test(payloadSessionId)) {
        return jsonResponse({ error: 'session_id is required' }, 400, cors);
      }

      const { data: session, error: sessionReadErr } = await adminClient
        .from('support_sessions')
        .select('id, org_id, support_user_id, granted_by, ended_at')
        .eq('id', payloadSessionId)
        .maybeSingle();
      if (sessionReadErr) {
        console.error('admin-update-user end_support_session read failed:', sessionReadErr);
        return jsonResponse({ error: 'Failed to load support session' }, 500, cors);
      }
      if (!session || session.org_id !== orgId) {
        return jsonResponse({ error: 'Support session not found in this org' }, 404, cors);
      }
      if (session.ended_at) {
        return jsonResponse({ error: 'Support session is already ended.' }, 409, cors);
      }

      // Authorization: either the customer Owner/Admin (users.invite)
      // OR the support user themselves. hasCap was evaluated up-front;
      // if it failed we only accept the request when the caller IS
      // the support user on this session.
      const isSupportUser = caller.id === session.support_user_id;
      if (!hasCap && !isSupportUser) {
        return jsonResponse(
          { error: "You don't have permission to end this support session." },
          403,
          cors,
        );
      }
      const endReason = isSupportUser ? 'support_ended' : 'customer_ended';
      const endedAt = new Date().toISOString();

      // Flip session first, then revoke the matching active support grant.
      const { error: sessionUpdErr } = await adminClient
        .from('support_sessions')
        .update({ ended_at: endedAt, end_reason: endReason })
        .eq('id', session.id);
      if (sessionUpdErr) {
        console.error('admin-update-user end_support_session update failed:', sessionUpdErr);
        return jsonResponse({ error: 'Failed to end support session' }, 500, cors);
      }

      // Revoke the support_grant role row so the support user loses
      // access immediately. The D9 trigger fires on revoked_at and
      // drops the org_keys wrap. Limit the revoke to support_grant
      // rows so a support user holding any other role in the same org
      // (unlikely but possible) is not collateral.
      const { error: revokeErr } = await adminClient
        .from('org_member_roles')
        .update({ revoked_at: endedAt })
        .eq('org_id', orgId)
        .eq('user_id', session.support_user_id)
        .eq('source', 'support_grant')
        .is('revoked_at', null);
      if (revokeErr) {
        console.error('admin-update-user end_support_session revoke failed:', revokeErr);
        return jsonResponse({ error: 'Failed to revoke support role' }, 500, cors);
      }

      await writeAudit(caller.id, session.support_user_id, orgId, action, {
        session_id:  session.id,
        end_reason:  endReason,
        ended_at:    endedAt,
      }, 'support.session_ended');

      return jsonResponse({ ok: true, ended: true }, 200, cors);
    }

    // Shouldn't reach here — VALID_ACTIONS guard covers every branch.
    return jsonResponse({ error: 'Unknown action' }, 400, cors);
  } catch (err) {
    console.error('admin-update-user error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});

/**
 * Write an audit row to vault_security_events. The table schema is
 * (user_id, event, metadata, created_at default now()). We stuff the
 * caller + org + action details into metadata and scope user_id to
 * the *target* so the event appears in that user's own audit trail.
 *
 * Failures are logged but do not propagate — the user-visible action
 * has already succeeded by the time we get here, and losing an audit
 * row is strictly better than failing a legitimate update because
 * of an unrelated DB hiccup.
 */
async function writeAudit(
  callerId: string,
  targetUserId: string,
  orgId: string,
  action: Action,
  extra: Record<string, unknown>,
  eventOverride?: string,
): Promise<void> {
  // Phase 4.3: normalize the event name for soft_revoke so downstream
  // audit views can match on 'user.revoked' (per the roadmap copy)
  // rather than the internal action enum. Every other action keeps the
  // `user.<action>` convention shipped in 4.2. Phase 4.4 actions pass
  // eventOverride to emit 'role.expiry_extended', 'support.session_granted',
  // 'support.session_ended' directly.
  let event: string;
  if (eventOverride) {
    event = eventOverride;
  } else if (action === 'soft_revoke') {
    event = 'user.revoked';
  } else {
    event = `user.${action}`;
  }
  try {
    const { error } = await adminClient.from('vault_security_events').insert({
      user_id: targetUserId,
      event,
      metadata: {
        actor_user_id: callerId,
        target_user_id: targetUserId,
        org_id: orgId,
        action,
        ...extra,
      },
    });
    if (error) {
      console.warn('admin-update-user audit insert failed:', error);
    }
  } catch (err) {
    console.warn('admin-update-user audit insert threw:', err);
  }
}
