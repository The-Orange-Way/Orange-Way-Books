# Orange Way Books: Enterprise Security Tier (v2 roadmap)

> **Status:** Design spec for Phase 4 v2 (after v1 Phase 4 multi-user ships).
> **Purpose:** Prevent single-keypair compromise from becoming a 200-client catastrophe for accountants.
> **Companion:** `OWB-MULTIUSER-DESIGN.md` (v1 Phase 4, one master keypair per user).

---

## 0. Why this exists

v1 Phase 4 ships **one hybrid keypair per user globally**. Simple UX, one unlock, works for 95% of users including solo Owners and small firms.

The 5% problem: **accountants managing 40, 200, 500+ clients** as an Enterprise segment. If their one master keypair is phished, stolen, or exfiltrated by malware, every client is compromised. "One key for 200 clients" is the blast-radius problem.

Adding per-org keypairs was the obvious instinct but it's the wrong fix:

- No security gain against realistic attacks (phishing, malware). An attacker with your password unlocks all your per-org keys anyway.
- Massive UX cost (40+ unlocks, 40+ keypair generations during onboarding).
- Only gain is re-key blast radius, which hardware keys solve more cleanly.

**This doc specifies the three layers Enterprise customers unlock to limit blast radius without moving to per-org keypairs.**

---

## 1. Three layers (additive)

### Layer 1, Hardware-backed master key (WebAuthn / passkey)

The master hybrid keypair's **private key is sealed to a hardware authenticator**, Yubikey, Apple Passkey, Touch ID Secure Enclave, TPM. Unlock requires physical presence.

**What this defends against:**

- Password phishing (the big one): attacker with your password alone cannot unlock
- Credential stuffing: reused password from another breach is useless
- Remote malware stealing the MEK from disk: private key never touches disk

**Implementation primitive:** WebAuthn Level 3 with PRF extension, or Apple Passkey with hardware attestation. The PRF output is combined with the vault password via HKDF to derive the MEK. Losing the authenticator = recovery flow (not a dead account).

**UX:** Touch Yubikey / biometric confirmation on each unlock. Auto-lock after idle.

**Rollout:** Enterprise-only. Core and Advanced users stay on password-only (our Argon2id v4 is strong against offline attack; the real risk is phishing, which hardware keys solve).

### Layer 2, Device attestation + per-device session scoping

Each logged-in browser has a **short-lived session keypair attested to the device**. The session keypair is created on first unlock per device and signed by the master. The session keypair is what actually performs the KEM unwrap operations during normal use, the master private key stays sealed to hardware and only signs new session keys.

**What this defends against:**

- Stolen laptop: revoke the device, its session keypair is cryptographically dead. No re-key of the 200 Org DEK wraps needed.
- Shared devices: auto-revoke session after N days, forcing re-attestation.
- Forensic timeline: audit log shows which device touched which org and when.

**Schema additions:**

```sql
CREATE TABLE public.user_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name       TEXT NOT NULL,                    -- "MacBook Pro - Office"
  platform          TEXT,                             -- 'darwin' | 'windows' | 'linux' | 'ios' | 'android'
  session_pubkey_b64 TEXT NOT NULL,                   -- session hybrid public key
  attestation_sig   TEXT NOT NULL,                    -- master's ML-DSA signature over session pubkey
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);
```

**UX:** Dashboard shows "Active devices" with name, last-seen, one-click revoke. On revoke: all sessions on that device fail immediately; re-login on that device requires hardware key confirmation again.

### Layer 3, Optional per-sensitive-client keypair enrollment

For a specific client flagged high-sensitivity (defense contractor, healthcare, regulated industry, personal-net-worth threshold), the accountant generates a **dedicated hybrid keypair just for that org**.

**Mechanics:**

- The accountant's master never holds the Org DEK wrap for this client.
- A per-client keypair is generated at onboarding, its private key wrapped by the master.
- Switching to that client requires an extra touch of the hardware key to unwrap the per-client private key.
- Compromise of the master does **not** touch this client (attacker lacks the per-client private key without a second hardware-key operation).

**Trade-off:** Extra friction when switching to that client. Customer opts in when the Owner onboards the accountant.

**Schema:**

```sql
ALTER TABLE public.user_vault_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'master'
  CHECK (scope IN ('master', 'per_org_high_sensitivity'));
ALTER TABLE public.user_vault_keys
  ADD COLUMN scoped_org_id UUID REFERENCES public.organizations(id);
-- When scope = 'per_org_high_sensitivity', scoped_org_id is the client org
```

---

## 2. Threat-model coverage

| Attack                                                   | v1 (one master keypair)                                | v2 + Layer 1 (hardware)                                                 | v2 + all 3 layers                                                       |
| -------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Password phishing                                        | All 200 orgs exposed                                   | Attacker has password, no hardware → denied                             | Denied                                                                  |
| Credential-stuffing from reused password                 | All 200 orgs exposed                                   | Denied                                                                  | Denied                                                                  |
| Malware reads MEK from disk                              | All 200 orgs exposed                                   | No MEK on disk (hardware-sealed)                                        | No MEK on disk                                                          |
| Malware reads keypair from browser memory during session | Open orgs only                                         | Open orgs only                                                          | Only the currently-unwrapped client (others are not unwrapped)          |
| Laptop stolen, unlocked                                  | Everything in memory                                   | Everything in memory                                                    | Open session only; revoke device cryptographically kills it             |
| Recovery code theft                                      | All 200 orgs                                           | All 200 orgs (recovery path bypasses hardware by design)                | Depends on recovery path; documented in Shamir custody spec             |
| Rogue client Owner leaks their Org DEK wrap              | That org only (attacker lacks your private key anyway) | That org only                                                           | That org only                                                           |
| Master keypair compromised, need re-enroll               | Re-wrap DEK with all 200 Owners                        | Re-wrap with all 200 Owners (but compromise requires physical attacker) | Re-wrap master; high-sensitivity clients unaffected (distinct keypairs) |

---

## 3. Pricing / packaging

**Enterprise tier feature bundle:**

- Custom roles (D1 decision, already in Advanced)
- Hardware-backed master key (Layer 1)
- Device attestation and revocation (Layer 2)
- Per-sensitive-client enrollment (Layer 3)
- Orange Way Books Recovery (Shamir custody, D4 decision)
- Priority support (OWBSupport concierge with time-boxed scoped access)

**Target:** Accounting firms with 20+ clients, CPAs with high-net-worth or regulated clients, orgs with compliance audit requirements.

**Pricing anchor:** Comparable enterprise services (1Password Business Tier, Bitwarden Enterprise) charge $7–12/user/month. Orange Way Books Enterprise should price in that range plus a per-client multiplier for the firm segment.

---

## 4. Implementation phases

This is **v2 work**, ships after v1 Phase 4 is stable and has paying customers.

**Phase E1, WebAuthn foundation** (4–6 weeks)

- Integrate WebAuthn PRF extension for MEK derivation
- UI: hardware key enrollment flow
- Recovery path when hardware key is lost (Shamir custody pairs naturally here)

**Phase E2, Device attestation** (3–4 weeks)

- `user_devices` table + session keypair lifecycle
- Device management UI (list, rename, revoke)
- Audit events wire-up

**Phase E3, Per-sensitive-client enrollment** (3–4 weeks)

- `user_vault_keys.scope` extension
- Client onboarding toggle "this is a high-sensitivity client"
- Client-switching UX with extra unlock step

**Phase E4, Enterprise packaging + billing** (ongoing)

- Plan gating on the three layers
- Migration path from Advanced to Enterprise for existing customers
- Audit-log retention bump for compliance

---

## 5. Why not just per-org keypairs?

Rejected in v1 design. Reiterated here so future agents don't revisit:

| Concern                                     | Per-org keypairs                                   | Hardware + attestation + per-sensitive                                    |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| UX for 40+ client accountant                | 40+ keypairs to generate and unlock                | 1 master + optional per-sensitive client                                  |
| Security vs phishing                        | Same (attacker with password unlocks all)          | Hardware key prevents phishing entirely                                   |
| Security vs malware                         | Same                                               | Session attestation + hardware sealing limits exposure                    |
| Re-key blast radius after master compromise | Unchanged (your single password still unlocks all) | Device revoke is cheap; hardware-sealed master is very hard to compromise |
| Dev complexity                              | N keypairs per user × M orgs                       | One master + narrow enterprise features                                   |

**Conclusion:** the blast-radius concern is real, but per-org keypairs don't solve the threats that matter. The three-layer enterprise architecture is the correct answer.

---

## 6. Open questions for Enterprise implementation (deferred to v2 design)

These are intentionally left open, we'll resolve them when we start Phase E1, not now:

- Which WebAuthn providers do we support initially? (Probably Yubikey + Apple Passkey + Windows Hello.)
- How does Shamir custody interact with hardware-sealed master keys? Can a Shamir share reconstitute a hardware-sealed private key? (Answer: no, recovery generates a new hardware key + re-wraps the master from a distinct backup. Needs careful design.)
- What's the re-enrollment UX when an accountant replaces their laptop? (Device onboarding + attestation migration.)
- Do per-sensitive-client keypairs support hard re-key independent of the master? (Should, needs separate `key_rotation_jobs` scope.)

---

## 7. References

- `OWB-MULTIUSER-DESIGN.md`, v1 multi-user design
- `OWB-USER-MANAGEMENT-ZKA.md`, Track D framing
- WebAuthn Level 3 Spec, https://www.w3.org/TR/webauthn-3/
- WebAuthn PRF extension, https://github.com/w3c/webauthn/issues/1740
- Apple Passkey, https://developer.apple.com/passkeys/
- Yubikey WebAuthn, https://developers.yubico.com/WebAuthn/

---

_Last updated: 2026-04-21, v2 roadmap doc; no code changes to pair with yet._
