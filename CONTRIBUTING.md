# Contributing

Thanks for thinking about contributing to Orange Way Books. This file is the project-wide policy. For the day-to-day engineering process (branch model, commit-message conventions, pre-push hooks, the `/pr-this` gauntlet) see [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).

## License of your contribution

By opening a pull request, issue, or any other contribution to this repository, you agree that your contribution is licensed under the same [Apache License 2.0](./LICENSE) that covers the rest of the project. This follows the standard "inbound = outbound" convention codified in Apache 2.0 Section 5:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions.

You are responsible for ensuring you have the right to submit the contribution under that license. If your employer holds rights to your work-product, please get their written authorization before contributing.

### No CLA, no DCO required

We do not require a Contributor License Agreement (CLA) or a Developer Certificate of Origin (DCO) sign-off line. Apache 2.0 Section 5 carries the same intent.

If you'd like to add a `Signed-off-by:` trailer to your commits anyway, that's welcome but not required.

## What we look for

- **A clear "why".** The diff shows the what; your commit message and PR description should explain the why. The `/pr-this` skill (see [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)) walks you through it.
- **Tests where they matter.** The crypto layer, the ledger math, and the auth surface are where bugs hurt most. Tests for changes in those areas are appreciated more than tests for cosmetic changes.
- **Honest framing.** This project's pitch is that the server cannot read your books. Code, comments, and docs that claim more than the architecture delivers undermine every other claim on the page. If you're not sure whether a claim is supportable, mark it as a question in your PR and we'll work it out.

## How to report a security issue

Do **not** open a public issue for security-sensitive findings. See [`SECURITY.md`](./SECURITY.md) for the disclosure address and our response commitment. Credit for verified findings is offered.

## Code of conduct

We follow the [Contributor Covenant](./CODE_OF_CONDUCT.md). In short: be the kind of contributor you would want others to be. Disagreement is fine; condescension is not. If something feels off, write to the address in [`SECURITY.md`](./SECURITY.md) (we re-use it for conduct issues until we have a proper channel) and a maintainer will respond.

## Where to start

- Read the [README](./README.md) end-to-end. It explains who we're building for and why.
- Skim [`SECURITY.md`](./SECURITY.md) for the threat model.
- Browse [`docs/DOCUMENTATION-INDEX.md`](./docs/DOCUMENTATION-INDEX.md) for the architecture, multi-user design, multi-currency model, and the rest.
- Look at [open issues](https://github.com/The-Orange-Way/Orange-Way-Books/issues) for what's actively in motion.
