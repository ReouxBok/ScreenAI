# Compatibility of intake approvals

`codeRevision` is the reference commit approved by an administrator. It is not
rewritten when a compatible deployment starts. An optional `compatibility` digest
binds runtime pins and execution policies to the current authority source manifest.

Without this digest, exact commit matching remains required. With it, the digest
must match `SAV_INTAKE_COMPATIBILITY`; a mismatch never falls back to legacy mode.
Both modes require a valid 40 character lowercase deployment SHA. The existing
`VERCEL_GIT_COMMIT_SHA ?? SAV_CODE_REVISION` resolution remains unchanged.
Mixed legacy/compatible pins do not match at launch.

This PR targets the current `codex/ugo` baseline. That baseline does not yet
include the separate operator recovery / authority reattachment implementation.
No recovery code is imported here. Before composing with that implementation,
replace its artifact equality checks with `intakeArtifactAuthorized` and
`intakeSamePin`, qualify both modes and regenerate the authority manifest.

## What is covered

The manifest covers non-test intake sources, their static local dependencies,
the verifier itself, Next build wiring, dependency locks, resolution settings,
vendored packages, application SQL migrations and their journal. Vercel install
and source filtering configuration are covered too; `npm ci` preserves the
committed lockfile during the platform build. New intake
sources and imports participate automatically. Unresolved imports, unknown
external packages, unsupported resolution aliases and non-literal dynamic
imports fail verification. The generated manifest excludes itself to avoid a
self-referential digest.

This is deliberately conservative: a comment or performance change in a covered
file also changes compatibility. UI files outside that graph and test-only
changes do not. This does not prove semantic equivalence between programs, nor
attest the actual deployed database, provider permissions or configuration.
Those still require their existing deployment and runtime checks.

## Verify and revise

From `studio/`, verification is read-only:

```sh
node scripts/intake-authority.mjs
```

The same check runs when Next loads production build configuration, including a
direct `next build`. It does not read source files on the production server
phase. Tests exercise source mutation, additions, dependencies and build rejection.

After reviewing a change to covered code, choose a new authority revision and
regenerate explicitly, for example:

```sh
node scripts/intake-authority.mjs --write sav-intake-authority-2026-10-23.v6
```

The updater refuses to reuse the current revision. Verification never updates
the manifest or installs an approval. A new digest requires a separate explicit
approval; it cannot silently upgrade an existing policy. The first opt-in also
changes pin/policy hashes and requires approval. No database migration is needed.

## Preserved boundaries

Compatibility replaces only artifact matching. Mailbox, date frontiers, resource
hashes, expiry, admission limits, allowed mutations, active administrator,
revocation, pauses, kill switches and receipt/idempotency checks remain separate.
It grants no permission to replay or reattach an already dispatched effect.

`configHash` remains stable across deployment SHAs only when all existing inputs
remain equal, including model/readers/context revisions, rules and access
bindings. Do not remove these inputs to force stability.

Production requires independent review of the exact base/head, complete tests and
the existing explicit release/configuration approval process. This code change
does not activate compatible approvals or any external action.
