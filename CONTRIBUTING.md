# Contributing to Orange Way Books

Thank you for helping. This project uses GitHub as a **marketing and trust surface** as well as a code host: strangers should understand **why** a change exists without reading the diff first.

---

## License of your contribution

By opening a pull request, issue, or any other contribution to this repository, you agree that your contribution is licensed under the same [Apache License 2.0](./LICENSE) that covers the rest of the project. This follows the standard "inbound = outbound" convention codified in Apache 2.0 Section 5:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions.

You are responsible for ensuring you have the right to submit the contribution under that license. If your employer holds rights to your work-product, please get their written authorization before contributing.

### No CLA, no DCO required

We do not require a Contributor License Agreement (CLA) or a Developer Certificate of Origin (DCO) sign-off line. Apache 2.0 Section 5 carries the same intent.

If you'd like to add a `Signed-off-by:` trailer to your commits anyway, that's welcome but not required.

---

## Install the git hooks

**On a fresh clone, install the hooks:**

```bash
bash scripts/install-hooks.sh
```

That wires two `git` hooks into `.git/hooks/`:

- **pre-commit** runs `scripts/pre-commit-format.sh`, which auto-formats every staged file with Prettier and re-stages it. So every commit lands Prettier-clean and `bun run format:check` in CI never fires red on a forgotten format.
- **pre-push** runs `scripts/pre-push-gate.sh`, which refuses the push if any of these fail:

1. The `/pr-this` skill has not been recorded against the current `HEAD` (marker at `.git/.pr-this-ran`)
2. The pre-publish leak scanner reports anything other than clean
3. The commits being pushed contain private / internal-only URLs (wiki hostnames, infra hostnames, Tailscale IPs, etc.)
4. `gitleaks` reports a secret-shaped string in the prepared commits

If a push really must go through (true emergency only), the override is `PR_THIS_BYPASS=1 git push` and the gate emits a loud warning that this happened.

---

## Ground rules

1. **Never commit secrets**: no Supabase service keys, production URLs with embedded tokens, or SSH passwords. Use placeholders in docs and host/Supabase env for real values.
2. **Migrations are law**: if you change the database, add a migration and regenerate TypeScript types if your workflow uses `src/integrations/supabase/types.ts`.
3. **Match existing patterns**: encryption goes through `crypto-fields.ts` + `VaultContext`; ledger math through `ledger-engine.ts`.

---

## What we look for

- **A clear "why".** The diff shows the what; your commit message and PR description should explain the why. The commit-message and PR-description sections below walk you through it.
- **Tests where they matter.** The crypto layer, the ledger math, and the auth surface are where bugs hurt most. Tests for changes in those areas are appreciated more than tests for cosmetic changes.
- **Honest framing.** This project's pitch is that the server cannot read your books. Code, comments, and docs that claim more than the architecture delivers undermine every other claim on the page. If you're not sure whether a claim is supportable, mark it as a question in your PR and we'll work it out.

---

## How to write commits and PRs on this repo

When you ship code, your commit message and your PR description are the only record the next person (human or agent) has of why this change exists. Write them for that future reader, not for yourself.

### The one rule

**Explain WHY, not WHAT.**

Git already shows the diff: the reader can see what changed. What they cannot see is:

- what problem you were solving
- what you tried that did not work
- what you deliberately did **not** do, and why
- what future work this unblocks or leaves open
- what risks or trade-offs you accepted

Your job is to write down exactly that.

### Commit message format

```text
<type>(<scope>): <imperative one-line summary, <=72 chars>

<1-3 sentence paragraph: what problem this solves, stated so a
non-engineer could understand it.>

<optional: what you considered and rejected, one line each.
E.g. "Considered querying journal config each call; rejected
because it adds a DB round-trip to a hot path.">

<optional: anything the next contributor must know: follow-ups,
known limitations, pre-existing bugs you fixed incidentally to
unblock this work. Label the last one "Incidental fix:" so it's
easy to spot.>
```

- **`<type>`** is one of: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **`<scope>`** is the area touched, e.g. `vault`, `supabase`, `frontend`, `docs`

**Good example:**

```text
feat(edge-fns): add optional X-Owb-Api-Key middleware

Lets operators lock an internal /graphql proxy behind a shared
verification token when the function is exposed beyond localhost.
If OWB_API_KEY is unset the middleware is a no-op, so existing dev
setups are not broken.

Chose a constant-time byte compare over plain `==` to avoid timing
leaks. Chose per-route middleware over a global layer so health
checks stay unauthenticated.
```

**Bad example (do not do this):**

```text
feat: add auth

Added X-Owb-Api-Key header check.
```

### PR description format

Use this shape **exactly**. One screen, not five. (GitHub pre-fills this from `.github/pull_request_template.md`.)

```text
## Summary
One sentence: what this PR does, in plain language.

## Why
2-4 bullets: the problem and why it matters now. Link issues if any.
If this closes a known limitation listed in a doc, say which doc
and which section.

## What changed
A short list of the concrete edits, grouped by file or area. Not a
diff: a reader's-digest version.

## What I considered and rejected
1-3 bullets. Each one: the alternative, and why you didn't pick it.
If you didn't consider alternatives, say so.

## Risks and trade-offs
Be honest. "This adds a DB round-trip per request" is useful.
"No risks" is almost never true and is a red flag to reviewers.

## How to verify
The exact commands a reviewer should run, or the manual steps to
click through. If you ran tests, paste the summary line (e.g.
"12 tests pass, 0 fail").

## Out of scope
What you deliberately did not touch, so the reviewer knows not to
ask for it here.
```

### Hard rules

- Never write **"update code"** or **"fix stuff"** as a summary.
- Never leave the **body empty** on a non-trivial commit.
- Never claim **"no risks"** or **"trivial change"** unless the diff is literally a typo or a comment.
- If you incidentally fixed a pre-existing bug to unblock your own change, call it out under **`Incidental fix:`** in the commit body. Do not bury it in the diff.
- If you are **closing or superseding** another PR, say so and link to the commit SHA that absorbed the work.

### Test yourself before pushing

Read your own commit message and ask:

> If I had just joined this project and opened this commit six months from now, would I understand why this code exists and whether it is safe to change?

If the answer is no, rewrite it.

---

## Branch model

The active branches are `dev` for integration and `prod` for releases. Open work goes to `dev` via feature branches and is promoted to `prod` in controlled batches. Use `git rebase -i` on feature branches before merge to keep commits tidy.

---

## House style for body copy

- **No em-dashes (U+2014) in body copy or code comments.** Use commas, parens, or colons instead. The pre-commit hook installed by `bash scripts/install-hooks.sh` rejects the commit if any added line in the staged diff contains one. The `/pr-this` skill re-checks at gauntlet time. If your commit fails the gate, replace the character and re-stage. A typographic placeholder (e.g. an "n/a" in a comparison table) should be written as `n/a` or `-`, not the dash glyph.
- **No private hostnames** (internal wikis, Tailscale IPs, personal home paths, internal email domains) in any committed file or commit message. The pre-push gate's `scripts/pre-push-gate.sh` carries the canonical list.
- **Prettier-clean.** The pre-commit hook auto-formats staged files; if you commit without the hook installed, CI will reject the PR on the format check. Run `bun run format` locally to catch it before pushing.

## How to report a security issue

Do **not** open a public issue for security-sensitive findings. See [`SECURITY.md`](./SECURITY.md) for the disclosure address and our response commitment. Credit for verified findings is offered.

---

## Code of conduct

We follow the [Contributor Covenant](./CODE_OF_CONDUCT.md). In short: be the kind of contributor you would want others to be. Disagreement is fine; condescension is not. If something feels off, write to the address in [`SECURITY.md`](./SECURITY.md) (we re-use it for conduct issues until we have a proper channel) and a maintainer will respond.

---

## Where to start

- Read the [README](./README.md) end-to-end. It explains who we're building for and why.
- Skim [`SECURITY.md`](./SECURITY.md) for the threat model.
- Browse [`docs/DOCUMENTATION-INDEX.md`](./docs/DOCUMENTATION-INDEX.md) for the architecture, multi-user design, multi-currency model, and the rest.
- Look at [open issues](https://github.com/The-Orange-Way/Orange-Way-Books/issues) for what's actively in motion.

---

## Questions?

Open a discussion or issue. For security-sensitive reports, see `SECURITY.md`.
