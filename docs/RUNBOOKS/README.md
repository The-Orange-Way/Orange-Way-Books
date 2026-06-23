# Runbooks

One file per incident class. The point of each runbook is to make the
on-call think less, not read more, in the first ten minutes.

Each runbook follows the same shape:

1. **What it looks like.** The symptoms a customer or an alert would
   surface.
2. **Confirm.** A small set of commands to confirm this is in fact the
   class of incident the runbook covers, before doing anything else.
3. **Immediate actions.** Three to seven steps the on-call runs in
   order. Designed so the on-call can copy-paste from the doc into a
   terminal.
4. **Escalation.** Who to ping, in what order, on what channel. The
   point is to surface "this is bigger than the runbook" early.
5. **Postmortem template.** The questions the post-incident write-up
   has to answer. Lifted into a wiki entry after the incident closes.

These are v1 runbooks. Each one ships with the canonical structure
and a first pass of "Immediate actions" that an on-call can run at
minute zero; a real incident in the class refines the steps during
the postmortem.

## Before you start

Every runbook references the same set of environment variables. Set
them once in your shell before running any command.

| Variable                       | Source                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `OWB_PROD_SUPABASE_PROJECT_ID` | Supabase dashboard, prod project, project ref             |
| `OWB_PROD_ACCESS_TOKEN`        | Supabase dashboard, account, Management API token         |
| `OWB_PROD_SUPABASE_URL`        | Project settings, API, project URL (no `https://` prefix) |
| `OWB_DEV_*`                    | Same fields for the dev project                           |

For founders running with a Proton Pass vault, all four are stored
under the canonical item titles documented in the operator handbook.
Never paste these values into chat or commit them to a file.

## Severity classification

Use the same severity bands across all runbooks. The band determines
who is paged, how fast, and what the customer-facing posture is.

| Band  | Definition                                                                     | Examples                                                       | Paging                                 |
| ----- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------- |
| SEV-1 | Customer data confidentiality is at risk; or the product is down for everyone. | Cross-tenant read, service-role-key leak, total Supabase loss. | Page founder immediately. Banner up.   |
| SEV-2 | A core flow is broken for many customers; or a single-tenant data-loss path.   | OR-proxy 5xx blocking sync for all, RLS too-tight on a table.  | Page founder within 15 min. Banner up. |
| SEV-3 | A single customer cannot use the product; or a non-critical surface is broken. | Single vault-unlock loop, optional report missing.             | Asynchronous, next-business-day OK.    |

## Incident-evidence retention

Capture relevant logs to `incidents/YYYY-MM-DD/` before they roll off
the dashboard (Supabase log retention is short on the free / current
paid tiers). Each runbook calls this out at the specific step where
log evidence matters.

## Index

- [`01-supabase-down.md`](./01-supabase-down.md)
- [`02-or-proxy-500.md`](./02-or-proxy-500.md)
- [`03-vault-unlock-loop.md`](./03-vault-unlock-loop.md)
- [`04-rls-regression.md`](./04-rls-regression.md)
- [`05-leaked-anon-key.md`](./05-leaked-anon-key.md)

## Maintenance

When a real incident happens, the runbook for that class gets revised
during the postmortem write-up. The diff has to land on `dev` within
two weeks of the incident close, with the relevant on-call as a
reviewer. If the incident class is new, file a new runbook in this
directory and add it to the index. Postmortem documents live in the
operator's incident log (a dated wiki entry) and reference action
items with owners and due dates so corrective actions are tracked to
closure, not just opened.

For a small operating team where the founder is also the on-call,
incident comms over Signal are not durable audit evidence on their
own; mirror the key timeline and decisions into the dated wiki entry
within 24 hours of close.
