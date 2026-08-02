# Runbook 03: Vault unlock loop

A customer (often more than one) cannot unlock their vault after
signing in. The unlock screen accepts the password, derives the key,
and then refuses to advance, often returning the customer back to the
unlock screen.

## What it looks like

- Customer reports "I type my password, the spinner spins, and I
  land back on the unlock screen".
- Browser console shows `vault_key_version` mismatch errors, or a
  Supabase RLS denial on the first decrypted field fetch, or an
  Argon2id derivation followed by no further activity.
- The user may say "this used to work yesterday".

## Confirm

The Supabase Management API `/database/query` endpoint does not accept
SQL parameters; the queries below inline the email / user id literally.
Set the local `EMAIL` variable in your shell first (never paste the
literal value into the curl command line, your shell history captures
it).

```bash
read -s -p "customer email: " EMAIL && echo
read -s -p "customer user_id (from auth.users.id, optional, leave blank to look up): " USER_ID && echo

# Per-user vault key state. Email lookup runs inline because Mgmt API
# does not bind parameters.
jq -n --arg email "$EMAIL" '{query: ("select user_id, vault_key_version, has_master_recovery, created_at from user_vault_keys where user_id = (select id from auth.users where email = " + ("'\''" + $email + "'\''") + " limit 1);")}' \
  | curl -s -X POST "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/database/query" \
      -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @-

# Org-side salt. If you have the user_id from the previous query, use
# it; otherwise the inline sub-select on email also works.
jq -n --arg uid "$USER_ID" --arg email "$EMAIL" '{query: ("select org_id, vault_salt is not null as has_salt, vault_key_version from org_settings where org_id in (select org_id from org_members where user_id = " + (if $uid == "" then ("(select id from auth.users where email = '\''" + $email + "'\'')") else ("'\''" + $uid + "'\''") end) + ");")}' \
  | curl -s -X POST "https://api.supabase.com/v1/projects/$OWB_PROD_SUPABASE_PROJECT_ID/database/query" \
      -H "Authorization: Bearer $OWB_PROD_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @-
```

If `vault_key_version` on `org_settings` is not `1`, the vault is in
a state the current code refuses to open (the registry only knows v1
after the key-derivation collapse). This was the historical class of
bug; if it surfaces again, the fix is to drop the upgrade RPCs
(already done by the signature-agnostic drop migration) and to set
the row back to `1` after manually unwrapping the MEK with the
customer's password.

If `vault_salt` is null, the org row is corrupt and recovery requires
the customer's recovery kit.

## Immediate actions

1. Confirm the issue is one customer vs many. If many, check the
   most recent migration that touched `org_settings` or
   `user_vault_keys`; this is likely a schema regression rather than
   a per-customer issue.
2. If one customer: walk them through the in-app recovery flow
   (Settings, security section). If they have lost the recovery kit too, the data is unrecoverable by design; tell them clearly
   and offer to reset their account to a clean state. Confirm any
   reset in writing via the support channel so the consent is
   captured against a later "they wiped my data" dispute.
3. If many customers: revert the most recent dev->prod promotion and
   re-test on dev. Do not push another migration to prod until the
   regression is understood.

## Escalation

- Internal: founder on Signal. Vault recovery is irreversible; do
  not act on a customer's vault without the founder's go.
- The customer themselves is the only person who can hold the
  password or recovery kit. We cannot help past that point.

## Postmortem template

- Severity band (SEV-1 / SEV-2 / SEV-3) and rationale.
- Duration of customer-visible impact (start, end, duration; one
  customer or many).
- Root cause (five-whys if applicable): code regression, operational
  state mismatch, or legitimate "customer forgot the password" case?
- If a regression: which migration introduced it? Did CI miss a path?
- Did the customer understand that we cannot recover their data
  without the recovery kit? Was the in-app messaging clear?
- Action items with owners, due dates, and tracking location.
