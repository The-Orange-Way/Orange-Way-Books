# `@orangerails/webhooks`, vendored

Verbatim source copy of `packages/webhooks/src/` from
`MorningRevolution/orangerails` (OR), pinned to a specific merge sha
`b97d4bc`.

## Why vendored?

`@orangerails/webhooks` is `private: true` in the OR monorepo and has not
been published to npm. Until OR ships it to a registry, consumers vendor
the source. This keeps every receiver on a byte-identical verification
path with zero hand-rolled HMAC.

Relative imports here use explicit `.ts` extensions so the source loads
under the Deno edge runtime without bundling.

## Updating

When OR cuts a new SDK release, re-copy these five files from the same
path in OR and bump the pinned sha above. Do not hand-edit. If you find
yourself wanting to patch the SDK locally, fix it in OR and re-vendor.

Files: `index.ts`, `construct-event.ts`, `verify.ts`, `types.ts`,
`errors.ts`. No test files, the SDK's own test suite runs in OR's CI.
