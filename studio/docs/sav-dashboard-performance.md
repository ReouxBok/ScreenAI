# SAV dashboard: SQL projection and navigation

## Read contract

`SAV_DASHBOARD_SQL=true` selects the new path. Unset/false keeps the existing reference reader. The flag never changes permissions, cutover, pilot selection, prompts, provider policy or the source of a human decision.

The shared classifier in `dashboard-source.ts` remains the authority. Multiple current source rows for one thread are rejected as ambiguous instead of being silently collapsed; preparation must resolve such source corruption before activation. A projection stores thread/message IDs, timestamps, classification flags, versions and a private search index. Summaries, original messages, drafts and CRM context stay in their existing encrypted sources. SQL counts, filters, sorts and selects one page; only those source threads are hydrated and decrypted. Related history within a selected dossier can still be large. Metrics distinguish latest joined source rows from associated rows returned by the related queries; they are logical result counts, not PostgreSQL physical scan counts. Use EXPLAIN/BUFFERS for physical work.

Source triggers atomically invalidate affected thread versions, including writes by the preceding application release. The builder locks projection rows before reading a repeatable-read snapshot and acknowledges only that version. It retries a serialization/deadlock failure once. Mailboxes, messages, threads, decisions, runs, reviews, drafts, verdicts, actions, observations, cycles, candidates and pilot membership are covered. Only opening/external-completion audits invalidate; reanalysis envelopes and unrelated audits do not. Cutover and the private observation registry are included in the generation.

Active knowledge affects displayed draft freshness and is read again when hydrating the page. It does not affect membership/counts/search summaries, so publishing knowledge does not rebuild the entire projection. Sensitive writes retain their existing independent source/freshness guards; this table never authorizes an action.

A read first checks dirty generations/versions and missing source-thread coverage. Repair can recreate missing cache entries without changing source rows. It can repair **25 threads**, then retry once. If any required rows remain dirty, it returns a typed pending state, with no stale counters or misleading empty result. Cron repairs at most 100 threads per passage when the flag is enabled. Initial preparation or a mass configuration change requires explicit warmup; request repair is not a replacement for it. A busy builder can temporarily produce pending rather than wait on source locks.

## Search and confidentiality

The index reproduces the existing normalized literal substring predicate: French lowercase, trimmed query, 200 UTF-16 code units, identical source fields joined by spaces. It supports one/two-unit searches and ordered three-unit segments, preserving repetition, literal SQL wildcard characters and partial surrogates. GIN narrows candidates; the ordered stream rejects noncontiguous segment matches. No plaintext search copy or unkeyed dictionary hash is stored.

HMAC-SHA256 derives a separate domain key from `SAV_ENCRYPTION_KEY_V1` using `sav-dashboard-search.v1`; tokens are truncated to 128 bits. This is **deterministic private indexing, not anonymization or semantic encryption**. Equality, approximate length, ordered repetition and cross-row pattern frequencies leak to a database reader. Short strings have especially small domains. Key compromise also compromises this index; token collisions are cryptographically unlikely, not mathematically impossible. This design requires independent review before activation.

Changing the root encryption key must follow the existing payload-key migration contract; replacing it just for this index would make existing payloads unreadable. Changing the index domain/revision triggers a rebuild. SQL parameters, row IDs, search text, ciphertext and keys are not emitted by read metrics. Keep access restricted to the existing SAV server boundary. Data deletion cascades/deletes the affected projection or invalidates it; operational backups retain the usual data-retention obligations.

Every classifier/search contract change must bump `SAV_DASHBOARD_PROJECTION_REVISION` and requalify/rebuild. Do not run incompatible projection generations against one database simultaneously. Generation changes require flag-off rollout/preparation before re-enabling.

## Durable opening interface (SAV-71 boundary)

Only the authenticated explicit inbox POST creates `sav_email_opening_requested` in `audit_logs`; GET/render/prefetch do not create an intention. Pending commands for the same message are deduplicated under a thread lock. The committed command and Studio consultation precede the redirect. After-response dispatch starts a Workflow; cron redispatches committed commands if that dispatch was lost.

The worker owns a five-minute lease and token. Immediately before Gmail modification it atomically fences ownership and persists dispatch evidence. An expired command with dispatch evidence is reconciled from a committed final receipt, or becomes uncertain; it never blindly repeats an uncertain mutation. Live/duplicate workers return pending. Existing actor, exact-message, mailbox, cutover, pilot, kill-switch and provider-result checks remain in `opened-email.ts`. The Gmail labels/unread behavior is unchanged. A new explicit click after a finished command still uses those guards and the provider's observed current labels.

The status endpoint is authenticated, thread-bound and `private, no-store`. The UI distinguishes acknowledgment, pending, confirmed/disabled/failed and uncertain results. Polling expiry reports unconfirmed, never success. A status read does not execute a command. Cron only dispatches up to ten opening Workflows, not ten provider calls inside the reconciliation request. Opening dispatch retries are throttled for two minutes; recovery of expired worker claims waits for the lease.

Context refresh is read-only at providers. A versioned request commits before after-response dispatch. In-flight requests for the same thread/message are reused for five minutes. Failed SDK starts remain recoverable; cron can redispatch five requests after five minutes, respecting terminal receipts. This is not general analysis/ingestion retry, and does not implement SAV-74 learning/admission. Human validation can still request fresh context once a previous request has finished; no unreviewed cross-request CRM freshness cache is introduced.

## Preparation / rollout (separate authorization required)

1. Review the exact base/head and migration number against the integration branch. Back up the target, restore that backup in an isolated PostgreSQL instance, and check journal/schema, ciphertext, human versions and pauses.
2. Keep SQL flag off. Apply additive `0039_sav_dashboard_projection.sql` using the normal migrator. It bootstraps IDs only and installs triggers/indexes, without models, ingestion, replay or provider actions. Ordinary index creation and trigger installation acquire table locks: use a low-traffic window, inspect table sizes and lock duration, and abort/retry if the planned budget is exceeded. Do not use an ad hoc production SQL copy.
3. Deploy compatible code with SQL still off. Existing reference reads remain available. Confirm the command Workflow/cron/status boundary independently.
4. With the target's authorized server environment, run `node --conditions=react-server --import tsx scripts/prepare-sav-dashboard.ts` for aggregate read-only status. `--apply --batches=100` explicitly repairs up to 10,000 threads in bounded transactions; exit 2 means more work remains. Preparation reads/decrypts affected sources but does not change their business state. Re-run bounded batches until pending=0; inspect code/config generation and key availability first.
5. Compare all views/counts/search and a representative selection against the reference, including pilot/cutover, new inbound, human changes, uncertain actions, external completion, learning and observation. Enable the flag only under a separate approved rollout. Observe read p50/p95, pending/error rates, writes/locks, connection capacity and storage growth.
6. Existing app pool/auth/infrastructure are unchanged. Local benchmarks do not include staff auth, deployment cold starts, database network latency, rendering or real providers. Qualify Node24 and the actual database region/pool before claiming a production navigation target.

## Revert / recovery

Set the flag false/unset while keeping the command-capable application/worker available. A rollback to application code predating this lot requires draining/reconciling new opening intents first or retaining the compatible worker and status endpoint. The original reference classifier resumes; leave the additive table/triggers intact during rollback. This avoids losing invalidations or requiring a destructive downgrade. Pending opening/context commands remain durable and visible; preserve/reconcile them and their leases/dispatch receipts rather than deleting or replaying them.

A corrupt or incompatible projection can be rebuilt under flag-off maintenance after verifying its generation/source coverage. Never delete original encrypted sources, human versions or audit receipts to repair this cache. Any later removal of the cache schema/indexes is a separate reviewed migration. Do not remove shared audit history as part of rollback.

## Local recipes

`prepare-sav-dashboard.ts` defaults to status only. `benchmark-sav-dashboard.ts` is destructive and refuses any target except a dedicated localhost native test database/token with `SAV_DASHBOARD_BENCHMARK=synthetic-only`; it never falls back to `DATABASE_URL`. Its reference budget is ten seconds; a canceled baseline has no p95. PostgreSQL concurrency tests also require the dedicated native test URL/token. The native test pool allows four connections; the application pool remains unchanged.

`playwright.sav73.config.ts` requires a checkout without environment files and an `env -i` invocation. It creates local synthetic PGlite data, disables real writes/AI, clears external credentials and blocks browser requests outside localhost. Tests cover client search/pagination/history, pending opening, delayed confirmation, loading, validation/refusal and viewport restoration. No synthetic recipe may be pointed at operational credentials or a production database.
