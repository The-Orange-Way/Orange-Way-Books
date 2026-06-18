# Orange Way Books — Research: Nostr-based login (optional auth)

> **Pitch:** Orange Way Books: Open-source accounting where not even the developer can see your books. Self-host it, audit the code, own your data.  
> **Updated:** 2026-04-18 | **Research** — not on the 3.0 delivery path; product parked for **v3.1+**.

**GitHub:** `The-Orange-Way/Orange-Way-Books`  
**License:** Open source (Apache 2.0)

**Type:** **Research project** — decision doc only; no implementation until post–3.0 unless roadmap changes. **Product call:** email stays default; **optional Nostr** (link first, sign-in later) when picked up.

**Engineering tracks:** See **`docs/OWB-ZKA-BRIDGE.md`**. **Auth code today:** `src/components/auth/LoginPage.tsx`, `SignupPage.tsx`; vault: `src/lib/vault.ts`, `src/context/VaultContext.tsx`.

---

## Plain English — what we’re talking about

### What is “hybrid C → A”? (email first, Nostr optional)

Think of **three doors** into the same house (your Orange Way Books account):

| Letter | Plain name | What it means |
|--------|----------------|---------------|
| **C** **“Connect Nostr” (optional add-on)** You still **sign in with email + password** like today. In **Settings**, you can **link** your Nostr profile (`npub`) to that same account — like “connect Google” on other sites, but for Nostr. **Lowest risk**, smallest change, good first step. |
| **A** **“Sign in with Nostr” (extra way to log in)** A new user (or you, later) could **log in using only Nostr** (browser extension signs a one-time challenge). Behind the scenes we still create a **normal Supabase user** so all your **permissions and org data keep working**. **Bigger build** — we must prove Supabase allows this cleanly. |
| **B** **“Use someone else’s bridge”** Instead of us writing all of **A**, we plug into a **ready-made service** that translates “Nostr login” into something Supabase already understands (OAuth-style). **Less custom code** *if* a good bridge exists and you are happy depending on it. |

**“Hybrid C → A”** in one sentence: **First ship C** (email stays default; Nostr is optional “connect”). **Later, ship A** if desired (optional “sign in with Nostr”).

### A vs B priority — especially when you self-host Supabase later

- **Path A** = **we build** the challenge + verify + session flow (full control, more work).
- **Path B** = **third-party** Nostr ↔ OIDC (less code if fit is real; dependency risk).

After **self-hosted Supabase**, re-check **B** (OIDC / SSO) before over-investing in custom **A** — hosted vs self-hosted feature sets differ. Not a mandate to use B.

### “npub in audit logs — full vs fingerprint”

**`npub`** is **public** by design — not a secret. **Audit logs** record who did what.

| Choice | Stored | Tradeoff |
|--------|--------|----------|
| **Full npub** Whole string | Easy to match; more identity in every log line. |
| **Fingerprint** Short hash / prefix | Less exposure; slightly harder to grep by full npub. |

Product choice: **visibility** in logs, not encryption of a secret.

### “Invites by npub — in or out of first ship?”

- **Out of first ship (recommended):** **C** only; invites stay **email**.  
- **In first ship:** harder — npub without account, delivery, support.

### Support / ToS when someone loses key + backup

Email gives “forgot password.” **Nostr-only** gives no key recovery unless you design one (phrase, second device, policy). Decide **Terms + support script** **before** Nostr-only login.

### Limitations

1. **RLS uses `auth.uid()`** — Nostr should still end in a **normal Supabase session** (same internal user id) unless you rebuild auth.  
2. **Vault password** stays separate from login identity.  
3. **Optional Nostr** does not replace email recovery for email-primary users.

---

## Executive summary (5 bullets)

1. **`auth.uid()`** drives `org_members` and RLS — Nostr path must preserve a stable Supabase user id or rewrite policies.  
2. **`deriveKey(..., user.id)`** uses Supabase **`user.id`**, not email — linking `npub` to the same `auth.users` row keeps vault behavior stable.  
3. **Recommended:** **C** then **A**; not Nostr-only until recovery is designed.  
4. **B** (OIDC bridge) — evaluate when self-hosting; may reduce custom code.  
5. **Recovery** is the main product gap vs email-only.

---

## Recommendation

**Hybrid: C → A (with B as optional shortcut)**

| Phase | Approach | Rationale |
|-------|----------|-----------|
| **C** **Link Nostr to existing Supabase user** — user stays email-primary; settings page “Connect Nostr” signs a binding event; store `npub` in `user_metadata` or `public.user_nostr_keys` with unique constraint on `npub`. | Zero change to `auth.uid()`; proves demand; trains support on extensions. |
| **A** **Nostr sign-in for new users (or opt-in primary):** Edge Function issues short-lived challenge → client signs with **NIP-07** → server verifies → **create or fetch** `auth.users` row via **Admin API** (service role in Edge only), then return **session** to client. Must validate against current Supabase. | Full story for Bitcoin-native users; highest engineering + compliance load. |
| **B (parallel research)** Evaluate **Nostr ↔ OIDC** providers (self-hostable, AGPL-friendly, etc.); if one maps cleanly to `signInWithOAuth`, implementation shrinks. | Lower custom code if fit is real; dependency + vendor risk. |

**Rejected for v1:** Nostr as **only** identifier in a **public** table while skipping Supabase Auth — would break `authenticated` and `auth.uid()` unless auth is rebuilt.

---

## Risks (threat model)

| Risk | Mitigation / note |
|------|-------------------|
| **Phishing** Bind challenge to `origin`, `kind`, short TTL, **server-stored single-use nonce**. Human-readable signing prompt where the extension allows. |
| **Extension compromise** Same as Web3 wallets — educate; optional passkey or email step-up for high-risk actions. |
| **Nonce reuse / replay** Store nonce with `used_at`; reject replays; short TTL (e.g. 5 min). |
| **`npub` “leak”** `npub` is public — do not treat as secret; correlation across apps is the real concern. |
| **Session fixation** HTTPS-only cookies; avoid tokens in URL fragments in production. |
| **Supabase limits** Custom JWT, Admin API session creation, OIDC differ by hosted vs self-hosted — **spike before dates**. |
| **Migration / lockout** Email users who never link Nostr must keep working; forced Nostr-only needs cutover + recovery plan. |

---

## Supabase-specific notes

- **`org_members.user_id`** and **RLS** use **`auth.uid()`** → keep internal UUID as system id; **`npub`** is an attribute (metadata or profile table).
- **Primary identifier:** internal UUID for FKs and vault salt; **`npub`** for human-facing Nostr identity.
- **`auth.users` population:** For Nostr-primary, often Admin `createUser` after verify (synthetic email only if GoTrue still requires unique email — verify current rules).
- **Edge Functions** (`legacy-proxy`, etc.) expect **`Authorization: Bearer <Supabase JWT>`** — unchanged once the client has a normal session.
- **`vault.ts`:** salt uses **`user.id`** — stable if the same `auth.users` row is used after linking Nostr.

---

## UX (wireframes in words)

| Scenario | Flow |
|----------|------|
| **First visit (Nostr-primary, P2)** Landing → “Sign in with Nostr” → NIP-07 → if missing, explain extension → Edge challenge → sign → session → vault unlock (second password unchanged). |
| **Returning** “Sign in with Nostr” → sign → vault unlock. |
| **Multi-device** Same Nostr key per device OR multiple `npub`s linked to one account. |
| **No extension** Email fallback (phase C) or read-only demo; do not dead-end enterprise users. |

---

## Migration

- **Default:** optional link — email users unchanged.  
- **Forced Nostr-only:** only after recovery + legal + support playbooks; consider export / break-glass period.

---

## Non-goals (this research)

- No change to PBKDF2 iterations, AES-GCM wire format, or MEK derivation from vault password unless a hard conflict is found.  
- No custom crypto beyond **NIP-07 / standard Nostr signed events** for the challenge step.  
- No secrets in repo or docs.

---

## Phased plan (if you proceed)

| Phase | Goal | Rough touches |
|-------|------|----------------|
| **P0** Spike on **Supabase**: Admin API user create + session vs OIDC / hooks for Nostr-verified identity. | Docs + throwaway branch. |
| **P1 (C)** **Link npub** — migration + Admin/Settings UI; optional Edge for binding signature. | `supabase/migrations/*`, `Admin.tsx` or profile, Edge optional. |
| **P2 (A)** **Nostr sign-in** — `nostr-auth-challenge`, `nostr-auth-verify`; `LoginPage.tsx`; rate limits. | `supabase/functions/*`, auth components, tests. |

---

## Open questions for product

1. Nostr-only vs email-optional forever?  
2. Self-host Supabase — does that change A vs B priority?  
3. **`npub` in audit logs** — full vs fingerprint?  
4. **Invites by npub** — in or out of first ship?  
5. **Legal / ToS** — who owns support when user loses extension + backup?

---

## References in repo

- `src/components/auth/LoginPage.tsx`, `SignupPage.tsx`  
- `src/lib/vault.ts`, `src/context/VaultContext.tsx` — `deriveKey(..., user.id)`  
- `supabase/migrations/*` — `auth.uid()` + `org_members`
