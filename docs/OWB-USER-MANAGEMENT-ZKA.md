# Orange Way Books — User management & zero-knowledge keys (Track D)

> **Pitch:** Orange Way Books: Open-source accounting where not even the developer can see your books. Self-host it, audit the code, own your data.  
> Cryptographic primitive changed from RSA-OAEP-4096 to **hybrid post-quantum KEM (X25519 + ML-KEM-768)** plus ML-DSA-65 for the optional Org Signing Key. Capability-based role engine (replacing the fixed 8-role set) and detailed stress tests now live in the companion **`OWB-MULTIUSER-DESIGN.md`**. This doc retains the Track D framing + DDL sketches; read both together.

**GitHub:** `The-Orange-Way/Orange-Way-Books`  
**License:** Open source (Apache 2.0)

**Single spec** for multi-user Vault: roles, per-org encryption keys, invites, revocation, optional custody, and support access — without breaking ZKA (server never sees readable books).

**Audience:** Product, engineers, and agents. **Status:** Blueprint — foundation pieces (per-org `org_keys`, hybrid-KEM wrap) are **not** all in the active release branches yet; check `dev` for current integration work and `prod` for deployed reality; see **§1** below.

**Also known as:** Track D (role-scoped keys). This doc is the canonical Track D specification in the repo.

**Engineering index:** Tracks for ledger storage, ledger engine, and encryption wiring + research live in **`docs/OWB-ZKA-BRIDGE.md`**.

---

## 1. Repository reality check

| Topic                                              | In repo **today** This spec **targets**                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Vault key                                          | Argon2id v4 (see `src/lib/vault.ts`).                                       | No change.                                                                                                                 |
| Per-org DEK + `org_keys`                           | **Not** in migrations at time of consolidation — **add** when implementing. | One org DEK (AES-256); wrapped per member via hybrid KEM.                                                                  |
| Hybrid KEM wrap (Bitwarden-style invite, PQC-safe) | Not yet implemented.                                                        | `user_vault_keys` + Owner wraps DEK with invitee's hybrid public key (X25519 + ML-KEM-768).                                |
| `org_members.role`                                 | Column exists; RLS is mostly "any org member".                              | **Capability-based RLS** via `capabilities` + `role_definitions` + `role_capabilities` (see `OWB-MULTIUSER-DESIGN.md` §2). |
| `payment_requests`                                 | Tables + authorship migration exist.                                        | Wire **capability checks** (`payments.approve`, `payments.pay`) to approve / pay state machine + UI.                       |
| Admin invites                                      | UI / flow partial — must create real membership + key grants.               | Full invite + hybrid-KEM wrap pipeline.                                                                                    |

Do not assume migrations exist until they land in `supabase/migrations/`.

---

## 2. Problem statement

Today, Vault effectively assumes **one user password story** per person: a **MEK** decrypts org data, but there is **no** standard way to:

- Give **another user** their own vault password **and** access to the **same** encrypted org without sharing the same MEK material wrongly.
- **Revoke** crypto access without either (a) trusting they forget the password or (b) **re-encrypting everything**.
- Enforce **accounting roles** (approver vs payer vs bookkeeper) **cryptographically** where it matters, not only hiding buttons.

The fix is **one org data key (DEK)** encrypted for each member, plus **server gates (RLS)** and **clear revoke semantics** (soft vs hard).

---

## 3. Plain English — ZKA user management

### Two problems

1. **Gate (who may call the API)** — Supabase Auth + RLS: “Is this logged-in user in this org?” The server sees identity and membership, **not** the vault password.
2. **Key (who can decrypt)** — Only the browser after unlock. “Who holds a **wrapped copy** of the org DEK?” defines crypto access.

**Zero-knowledge preserved:** Server stores ciphertext, wrapped keys, public keys, role names, expiries — not plaintext books. **Hard re-key** still runs in a **trusted browser** (usually Owner); server only receives new ciphertext.

### Soft revoke vs hard re-key

|                                                                                                                     | Plain English                                                     | Speed |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----- |
| **Soft revoke** Remove membership + **delete their wrapped DEK** (and role rows). They cannot unwrap on next login. | Instant. Does not erase RAM on their machine from an old session. |
| **Hard re-key** New DEK; **re-encrypt** all org rows; re-wrap for remaining members.                                | Slow; resumable job; strongest if device was compromised.         |

---

## 4. Industry research & design choice

### Systems compared

| System                           | Key model                | Sharing                                                    | Revocation |
| -------------------------------- | ------------------------ | ---------------------------------------------------------- | ---------- |
| **Bitwarden** Org symmetric key  | RSA-OAEP wrap per member | Re-wrap / remove grant — **no** full re-encrypt by default |
| **Proton Drive** Per-share / PGP | Address keys             | Remove share — strong, heavy stack                         |
| **Tresorit** Folder keys         | RSA wrap                 | **New key + re-encrypt** — strongest, expensive            |
| **1Password** Per-vault keys     | SRP wrapping             | Re-wrap                                                    |

### Choice for Orange Way Books

**Bitwarden-style core with post-quantum safety:** one **org DEK**, wrapped per member using a **hybrid KEM (X25519 + ML-KEM-768)** — Owner wraps the DEK for an invitee **without knowing their vault password**. The hybrid combiner (HKDF-SHA-256) means an attacker needs to break **both** X25519 **and** ML-KEM-768 to recover a wrap, so we stay safe even if either primitive is later weakened. **Soft revoke** matches Bitwarden's practical model.

**Why not RSA-OAEP-4096?** RSA is quantum-vulnerable, and retrofitting post-quantum crypto later is expensive. Going with hybrid KEM up front avoids a future cutover.

**Tresorit-style when needed:** **hard re-key** on Owner action or high-risk revoke (compromised device, support session ended).

**Why not separate “data keys per folder”?** In accounting, **Auditor** and **Accountant** both need **broad read** of the same ledger. Splitting keys per folder adds huge complexity for little gain; the important split is **read vs write** and **who may approve vs pay** (RLS + optional signing key — see below).

---

## 5. Key hierarchy (canonical)

**Naming:** **MEK** = master encryption key from vault password (per user). **Org DEK** = random AES-256 key for **this org’s row ciphertext** (what `crypto-fields` ultimately uses, once wired through).

```
Vault password (+ salt / user id per vault.ts)
    → MEK (Argon2id v4)
        → wraps hybrid keypair private key (X25519 + ML-KEM-768)
        → hybrid public key on server (base64, plaintext)

Org DEK (random AES-256, never on server plaintext)
    → wrapped with User A's hybrid public key via hybridEncapsulate → org_keys row A
    → wrapped with User B's hybrid public key via hybridEncapsulate → org_keys row B
    …

Application rows  →  encrypt / decrypt with Org DEK (in browser)
```

**Password change:** Re-wrap the **hybrid private key** with new MEK; **Org DEK unchanged** — no full data re-encrypt (same pattern as "re-wrap DEK only" in advanced designs).

**Optional later — org signing key:** ECDSA key only wrapped for **write-capable** roles; **Auditor** never receives it — **cryptographic** enforcement of read-only in addition to RLS + UI. Phased after DEK + RLS ship.

**Earlier draft note:** Some docs used “OK + HKDF(DEK)” — equivalent to a single **Org DEK** for row crypto; HKDF subkeys can be added if you need key separation without extra user-facing complexity.

### Key inventory

| Secret / key           | Type                   | Where born | Server sees                                                |
| ---------------------- | ---------------------- | ---------- | ---------------------------------------------------------- |
| MEK                    | AES (Argon2id-derived) | Browser    | Never                                                      |
| User hybrid keypair    | X25519 + ML-KEM-768    | Browser    | Public key (base64) + private **ciphertext** (MEK-wrapped) |
| Org DEK                | AES-256                | Browser    | Only **wrapped** per user                                  |
| Signing key (optional) | ML-DSA-65              | Browser    | Public + wrapped for writers only                          |

### Cryptographic libraries

Pure-TypeScript, audited, no WASM. Land the modules in `src/lib/pqc/` in Phase 4.0.

| Need                                  | Library / API                                             |
| ------------------------------------- | --------------------------------------------------------- |
| Password KDF                          | `hash-wasm` Argon2id (already used by `src/lib/vault.ts`) |
| X25519 (classical half of hybrid KEM) | `@noble/curves/ed25519`                                   |
| ML-KEM-768 (post-quantum half)        | `@noble/post-quantum/ml-kem`                              |
| ML-DSA-65 (optional)                  | `@noble/post-quantum/ml-dsa`                              |
| HKDF combiner                         | `@noble/hashes/hkdf` + `sha256`                           |
| Row encrypt                           | WebCrypto AES-256-GCM (existing)                          |

See `orange-rails/src/lib/pqc.ts` for the reference implementation of `hybridEncapsulate` / `hybridDecapsulate` and byte-length constants.

---

## 6. Roles — additive model

**One** `org_members` row per (user, org). **Many** roles via **`org_member_roles`** (one row per role grant). Effective permissions = **union** of roles (QuickBooks-style bill pay split: approver / payer / clerk).

Example canonical roles (tune names in migration `CHECK`):

| Role                                                                                   | Typical powers |
| -------------------------------------------------------------------------------------- | -------------- |
| **Owner** Full decrypt, write, user + key management                                   |
| **Admin** Write + users; keys policy per product                                       |
| **Accountant** Full financial write                                                    |
| **Member** Create/edit own work; **limited** delete/archive / closed period — RLS + UI |
| **PaymentsApprover** Approve payment requests                                          |
| **PaymentsPayer** Mark paid / execute pay step                                         |
| **Auditor** Read-only; **time-bounded** `expires_at`                                   |
| **OWBSupport** **Scoped** + short TTL; never combined with other roles                 |

**Separation of duties:** UI warning if same user is both Approver and Payer (configurable per org).

**Read-only — three layers:** (1) Optional signing key withheld from Auditor. (2) RLS denies writes. (3) UI hides write actions.

---

## 7. Schema (target — implement in migrations)

**Tables / changes (names may be adjusted in PR):**

- **`org_member_roles`** — `(org_id, user_id, role, granted_by, granted_at, expires_at, revoked_at)` with `UNIQUE(org_id, user_id, role)` where not revoked.
- **`user_vault_keys`** — `user_id`, `public_key_b64` (X25519 ‖ ML-KEM-768), `encrypted_private_key` (+ IV), algorithm string. One row per user (or versioned if rotating).
- **`org_keys`** — `org_id`, `user_id`, wrapped DEK (+ IV), `key_version`, optional `grant_scope` (`full` | `read_only` | `support_scoped`), `granted_by`, `expires_at`, `revoked_at`.
- **`org_custody`** (paid tier) — Shamir metadata, encrypted Share C, tier enum, etc.
- **`support_sessions`** — scoped support DEK wrap, TTL, revoke.
- **`key_rotation_jobs`** (optional) — resumable hard re-key progress.
- **`key_audit_log`** (optional) — grant / revoke / rotate events (may merge with existing `audit_logs` policy).

**RLS:** Replace “member of org” with “member of org **and** role satisfies capability for this operation **and** grant not expired/revoked.”

---

## 8. Flows (summary)

1. **Owner creates org** — Generate Org DEK; generate user hybrid keypair (X25519 + ML-KEM-768); MEK-wrap the hybrid private key; wrap Org DEK with own hybrid public key via `hybridEncapsulate`; store rows; encrypt data with Org DEK as today.
2. **Owner invites** — Invite email (or Nostr later) → invitee signs up, sets vault, uploads hybrid public key → **Owner client** unwraps Org DEK, re-wraps for invitee's hybrid public key via `hybridEncapsulate`, writes `org_keys` + `org_member_roles`. **Owner must be online** for wrap (Bitwarden pattern).
3. **Auditor** — Gets Org DEK grant + **no** signing key if implemented; RLS read-only.
4. **Soft revoke** — Delete `org_keys` row + roles + `org_members` for that user; audit.
5. **Hard re-key** — New Org DEK; re-wrap all members; batch decrypt old / encrypt new per table; bump `key_version`; optional logout everyone first.
6. **Support** — Owner issues **scoped** key + short `expires_at`; sweep removes access; consider enqueue hard re-key if support had live decrypt capability.
7. **Custody (paid)** — 2-of-3 Shamir for recovery key that protects wrapped Org DEK backup; use **audited** SSS library; ops runbook for releasing custodian share — **not** only code.

---

## 9. Phased delivery

| Phase                                                                                                            | Deliverable |
| ---------------------------------------------------------------------------------------------------------------- | ----------- |
| **1** Migrations + hybrid keypair (X25519 + ML-KEM-768) lifecycle in vault unlock / setup; solo org still works. |
| **2** `useRoles()` + RLS capability checks + Admin UI visibility.                                                |
| **3** Real invites + Owner-side wrap + soft revoke + audit events.                                               |
| **4** Time-bounded Auditor + Support sessions + sweeps.                                                          |
| **5** Hard re-key job + progress UI + resume.                                                                    |
| **6** Paid custody (Shamir) + billing + support runbooks.                                                        |

Each phase should leave **`dev`** deployable to staging and keep the `dev` → `prod` release path clean. Scope by **phase deliverables** above.

---

## 10. Security properties

| Property                        | How                                                                     |
| ------------------------------- | ----------------------------------------------------------------------- |
| Server never reads books        | Org DEK only in browser; server stores wraps + ciphertext               |
| Distinct vault passwords        | Each user's MEK unwraps only their hybrid private key                   |
| Invite without sharing password | Hybrid-KEM wrap of Org DEK to invitee's public key                      |
| Post-quantum safety             | X25519 + ML-KEM-768 combiner — breaks require defeating both primitives |
| Revoke                          | Soft = remove wrap; hard = new DEK + re-encrypt                         |
| Optional stronger read-only     | signing key withheld from Auditor + RLS + UI                            |

---

## 11. Open questions

- Viewer / reports-only: live decrypt vs snapshot-only?
- Org ownership transfer: wrap-only handoff flow?
- Multi-org: already in UI — confirm one hybrid key per user (recommended) vs per org.
- Session: auto-lock after idle for unwrapped keys?
- KYC / policy for releasing paid-tier custodian share.
- Billing: custody as add-on line vs bundle.
- Which rows default to “support visible” vs explicit tag.

---

## 12. References

- Bitwarden security whitepaper — bitwarden.com/help/bitwarden-security-white-paper/
- NIST FIPS 203 (ML-KEM) — csrc.nist.gov/pubs/fips/203/final
- NIST FIPS 204 (ML-DSA) — csrc.nist.gov/pubs/fips/204/final
- RFC 7748 (X25519) — datatracker.ietf.org/doc/html/rfc7748
- `@noble/post-quantum` — github.com/paulmillr/noble-post-quantum
- `@noble/curves` — github.com/paulmillr/noble-curves
- MDN `wrapKey` — developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/wrapKey
- Shamir: use an **audited** library (e.g. reviewed SSS port); do not roll crypto.

---

## 13. Related docs

- **`docs/OWB-MULTIUSER-DESIGN.md`** — Capability-based role engine, 9 role presets, 12 stress-test scenarios, invite/revoke/re-key sequence diagrams, monetization levers, phased delivery. **Read alongside this doc — it carries the post-RSA cryptographic design.**
- **`docs/COMPETITIVE-ANALYSIS.md`** — Survey of 8 accounting platforms (QuickBooks, Xero, Wave, Zoho, FreshBooks, Odoo, ERPNext, Akaunting) with cited patterns.
- **`docs/OWB-ZKA-BRIDGE.md`** — Tracks for ledger storage, ledger engine, and encryption wiring + pointer to this Track D spec and research.
- **`docs/DOCUMENTATION-INDEX.md`** — Full doc map.

---

## 14. Appendix: DDL sketches (for implementers)

### What is DDL? (plain English)

**DDL** means **Data Definition Language** — the kind of SQL that **defines** database objects (tables, columns, indexes, constraints), not the kind that inserts business rows (`INSERT` / `UPDATE`). When engineers say “DDL sketch,” they mean: **here is roughly what tables we need** so migrations can be written and reviewed **before** anyone ships production SQL.

**Important:** The blocks below are **sketches only**. They are **not** applied migrations. Real PRs must add files under `supabase/migrations/`, match existing RLS style, add indexes, and reconcile names with whatever already exists (`org_members`, etc.).

---

### Sketch: additive roles

```sql
-- One row per (user, org, role). "Member" is one role; "PaymentsApprover" is another row.
CREATE TABLE public.org_member_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'Owner', 'Admin', 'Accountant', 'PaymentsApprover',
    'PaymentsPayer', 'Member', 'Auditor', 'OWBSupport'
  )),
  granted_by UUID REFERENCES auth.users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,           -- NULL = permanent; set for Auditor / Support
  revoked_at TIMESTAMPTZ,
  UNIQUE (org_id, user_id, role)
);

CREATE INDEX org_member_roles_org_user_idx
  ON public.org_member_roles (org_id, user_id)
  WHERE revoked_at IS NULL;
```

**Product note:** Today `org_members.role` may still exist — migrations might **migrate** data into `org_member_roles` then drop or deprecate the old column (design choice).

---

### Sketch: per-user hybrid KEM wrap keys (Bitwarden-style, post-quantum safe)

```sql
CREATE TABLE public.user_vault_keys (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key_b64        TEXT NOT NULL,                     -- X25519 | ML-KEM-768 public, base64 (1216 bytes)
  encrypted_private_key TEXT NOT NULL,                     -- hybrid private ciphertext (MEK-wrapped in app)
  iv                    TEXT NOT NULL,                     -- IV / nonce for the private-key wrap
  key_algorithm         TEXT NOT NULL DEFAULT 'x25519-mlkem768-v1',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### Sketch: org DEK wrapped per member

```sql
CREATE TABLE public.org_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_dek TEXT NOT NULL,               -- Org DEK ciphertext (hybrid KEM to user's public key)
  wrapped_dek_iv TEXT,                   -- if wrap uses separate IV / encoding
  key_version INTEGER NOT NULL DEFAULT 1, -- bump on hard re-key
  grant_scope TEXT NOT NULL DEFAULT 'full'
    CHECK (grant_scope IN ('full', 'read_only', 'support_scoped')),
  granted_by UUID REFERENCES auth.users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (org_id, user_id, key_version)
);

CREATE INDEX org_keys_org_active_idx
  ON public.org_keys (org_id)
  WHERE revoked_at IS NULL;
```

---

### Sketch: paid custody metadata (Shamir tier — optional table)

```sql
CREATE TABLE public.org_custody (
  org_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('none', 'free_kit', 'paid_2of3')),
  owb_share_ct TEXT,                      -- Share C sealed for Orange Way Books (ciphertext only)
  owb_share_iv TEXT,
  shamir_version INTEGER NOT NULL DEFAULT 1,
  enrolled_at TIMESTAMPTZ,
  -- Avoid storing long-lived secrets in plaintext; policy lives in ops runbook
  metadata_encrypted TEXT                 -- optional: client-encrypted JSON for UI hints
);
```

---

### Sketch: time-boxed support access

```sql
CREATE TABLE public.support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  support_user_id UUID NOT NULL REFERENCES auth.users(id),
  granted_by UUID NOT NULL REFERENCES auth.users(id),
  scope_description TEXT NOT NULL,       -- human or structured scope; may be ciphertext
  wrapped_sdek TEXT NOT NULL,              -- narrowly scoped key material for support
  wrapped_sdek_iv TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX support_sessions_expiry_idx
  ON public.support_sessions (expires_at)
  WHERE revoked_at IS NULL;
```

---

### Sketch: resumable hard re-key job (optional)

```sql
CREATE TABLE public.key_rotation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  started_by UUID NOT NULL REFERENCES auth.users(id),
  old_key_version INTEGER NOT NULL,
  new_key_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed')),
  cursor_table TEXT,                       -- which table is being processed
  cursor_id UUID,                          -- last processed row id (example)
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### Sketch: key-operation audit (optional — may merge with `audit_logs`)

```sql
CREATE TABLE public.key_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,                  -- grant | revoke | rotate | support_open | …
  target_user_id UUID REFERENCES auth.users(id),
  metadata JSONB,                        -- non-sensitive structure; ciphertext if needed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### RLS sketch (pattern only)

Policies today often use `org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())`. Track D extends that with role capability, for example:

```sql
-- Example pattern — NOT drop-in for every table until role matrix is final.
CREATE POLICY example_insert_requires_writer_role
  ON public.some_table
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id IN (
      SELECT omr.org_id
      FROM public.org_member_roles omr
      WHERE omr.user_id = auth.uid()
        AND omr.revoked_at IS NULL
        AND (omr.expires_at IS NULL OR omr.expires_at > now())
        AND omr.role IN ('Owner', 'Admin', 'Accountant', 'Member')
    )
  );
```

Replace `some_table` / role lists per table after the **role matrix** is frozen in product.

---

**Updated:** append this appendix when implementing — bump the **Updated** date in the doc header if you change §14.
