# Limova extension client — S2 in progress

The privileged service worker now has an explicit `LIMOVA_*` message interface
for the existing Limova account, workspaces and Deep Agent conversation routes.
Only extension pages pass the existing sender check; content scripts cannot use
this interface as an authenticated API proxy.

`src/limova/client.js` uses credentials-included requests to
`https://api.new.limova.ai`. It never reads cookies or stores access/refresh
tokens. A 401 triggers at most one shared refresh and one retry; a network
failure never automatically replays a mutation. An absent backend rollout
decision disables the workspace. Each conversation operation rechecks the
account and workspace, and agent resolution uses the existing `charly` slug. Workspace-scoped reads and mutations recheck identity after a refresh before retrying; cancellation still works with the rollout disabled when the account and workspace remain authorized. Unused error/refresh bodies are cancelled.

`src/limova/background.js` retains only user/workspace/conversation IDs under
`limova_deep_agent_context_v1`. Context changes are serialized. Account changes
or loss of workspace access clear that selection. Training/evaluation mode
cannot invoke the personal Deep Agent message path. Stream events carry a
turn ID so an interface can ignore stale events.

Commands: `LIMOVA_GET_STATE`, `LIMOVA_SELECT_WORKSPACE`,
`LIMOVA_LIST_CONVERSATIONS`, `LIMOVA_CREATE_CONVERSATION`,
`LIMOVA_OPEN_CONVERSATION`, `LIMOVA_SEND_MESSAGE`, `LIMOVA_CANCEL`,
`LIMOVA_GET_MESSAGES`, `LIMOVA_OPEN_APP`, `LIMOVA_LOGOUT`.

Events: `LIMOVA_TURN_STARTED`, `LIMOVA_STREAM_EVENT`, `LIMOVA_TURN_ENDED`,
`LIMOVA_SESSION_CHANGED`. The SSE parser preserves native values/custom/update
events and rejects incomplete frames instead of inventing a complete answer.

Depends on API PR #2193 for the flag and channel contract, and #2194 for Studio
knowledge. The additional host permission is restricted to the Limova API.

The sidebar now opens the Limova app for login, refreshes the session, selects
an enabled workspace and creates/resumes Charly conversations. Text sends use
the native path, with cancellation and a turn-scoped stream projection. Root
user/assistant text and HTTPS generated-file links are rendered; tool results,
reasoning and subgraph events are not rendered as assistant replies. The old
OTP form is no longer used by the panel. Its existing training/evaluation
bootstrap skips the legacy auth/copilot network requests for this surface.

The current API Deep Agent history returns the complete root thread with
`pagination.hasMore: false`; the ordinary history endpoint uses `before` cursors.

Still required: conversation-list pagination, full artifact parity and
localization, real-account cookie handoff, and full browser/voice/training parity. Legacy voice, page analysis and privacy controls
still need migration; this is not a release-ready package. Browser UI tests use
a simulated Limova session, not a real-account cookie handoff. No production
activation or real-account session-sharing proof is claimed.

## App-session transport

`session-fetch.js` and the isolated `app-session-bridge.js` use the first-party app context for every authenticated request. They reuse an app tab or open one inactive when none exists. The app context also handles refresh and logout. This keeps the same identity even if a valid unpartitioned cookie belongs to an older, different account: a Chromium regression reproduced the wrong identity when a direct-request fallback was allowed after the app tab closed. There is therefore no automatic switch to the direct worker session. It never reads/copies cookies and needs no `cookies` permission, new backend route or app deployment.

The bridge is injected into the exact top-level Chrome document of `https://new.limova.ai` in the extension's isolated world. An extension-only port carries an allowlisted set of routes/methods/headers to `https://api.new.limova.ai`. Page scripts have no window-message proxy. Credentials remain browser-managed; response headers are limited to status/content type, and refresh/error bodies are discarded without parsing or forwarding tokens. JSON and bounded screenshot multipart uploads are supported. SSE bytes cross the port in acknowledged 16 KiB chunks, preserving incremental decoding and backpressure.

This path requires a Limova tab while requests run; closing/navigation/disconnection aborts the fetch. An interrupted mutation is not replayed. A later explicit request can prepare another app tab, while browser-action recovery still uses its durable receipt. Abort also stops the caller while a new app document is loading. The document binding and port are transient, not credentials stored in extension storage. Shared refresh is coalesced within the extension client; cross-client app/extension rotation still relies on the existing backend grace handling and requires real-account validation.

The Chromium suite uses a real local HTTPS server with native `Set-Cookie` responses, pinned DNS mapping for the fixture hosts and no external host resolution. It verifies actual partition metadata and shows a first-party partition cookie succeeds in the app but not in a direct worker fetch. Routed Playwright responses cannot prove this: `route.fulfill` did not preserve the Partitioned attribute in the initial experiment. The suite covers authenticated worker bootstrap, concurrent refresh, no token forwarding, ordinary cookies through the same app transport, reopening a closed app tab, incremental Unicode SSE, multipart upload, account switch, logout, disconnect/abort, allowlist rejection and conflicting ordinary/app identities with both open and closed app tabs. These are synthetic sessions, not proof of a production/staging account or deployed feature flag.

Reference: [Chrome extension storage and cookie behavior](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).

## Browser transport foundation

The client accepts an optional privileged browser binding on `sendMessage`:
`{ sessionId, page: { tabId, origin, contextVersion } }`. It sends the session UUID
only in `x-extension-session` on the relevant message request; it is not a login
token and is not included in model input. Page origins must be canonical HTTPS
origins, and tab/version values must be nonnegative safe integers.

`getBrowserTurn` reads the originating session's turn on the existing conversation
GET route. `sendBrowserResult` and `resumeBrowserTurn` use the existing message
POST route with `browser_tool_result` or `browser_resume`. They omit human text,
attachments and timezone, preserve the native SSE stream, and recheck the current
Limova account/workspace before submitting observations. A network failure does
not automatically replay a result. Explicit retries must use the same durable
receipt; a reconnection can inspect the turn before resuming.

This foundation depends on the API browser HTTP branch. The service-worker browser session lifecycle and receipt persistence are now
implemented; the executor and result/resume dispatch are not connected to these
transport methods yet. Existing panel calls remain text-only. The generated ZIP
is still an intermediate development artifact, not the final migration release.

## Durable browser receipts

`browser-journal.js` uses the extension origin's IndexedDB with strict-durability
write transactions. The key includes account, workspace, conversation, privileged
session, turn and action. A canonical action digest rejects changed arguments.
An atomic claim is committed before invoking the executor; independent database
connections cannot execute the same action twice. Completed receipts return the
original result, including after expiration. A fresh expired action is refused.

If execution throws, or a result cannot be persisted after an action, the stored
claim stays unresolved. Retrying returns `uncertain` and does not execute again.
The worker/UI must inspect the page and request user intervention as appropriate;
uncertainty must not be silently converted into success or an automatic retry.
Storage failure before a claim prevents execution altogether.

`clearScope` and `clearAccount` erase the corresponding receipts and invalidate
in-flight result writes. The caller must also revoke/rotate the browser session
on logout/account change before accepting more actions. The lifecycle hooks now run on workspace changes, account invalidation and
logout; the real page executor is not wired yet. Authorization, current tab/origin,
page version, permissions and cancellation must be checked immediately before
the executor acts; journal validation does not grant browser permission.

Nine Chromium tests exercise real IndexedDB transactions, reopening, concurrent
connections, ambiguous interruption, storage failures and account cleanup.
Nineteen boundary tests reject malformed operations and raw SDK interrupts.
These tests use fixture executors, not real clicks on user sites or live Limova
authentication. Action execution remains inactive until the executor and stream dispatch are integrated.


## Private browser session lifecycle

The journal atomically creates one persistent session UUID per account/workspace.
Both execution claims and result commits check that UUID in the same IndexedDB
transaction. Revoking the workspace session or clearing an account invalidates
old requests; reconnecting creates a new UUID. The nonce is never included in
panel state or Chrome local-storage context records.

The worker initializes this session after an enabled workspace is selected or
restored. Workspace switches revoke the prior binding; account changes, loss of
access and logout erase the prior account's receipts and sessions. Local cleanup
also runs if remote cancellation fails during logout. An account change aborts
the old local stream without issuing cancellation as the newly signed-in user.
The existing cancel command now reaches the backend even when the local stream
has finished, so paused browser turns can be cancelled.

The live action dispatcher, page executor, permission checks and uncertainty UI
remain outstanding. Session creation alone does not activate browser tools.

## Browser continuation runner

`browser-turn.js` coordinates the existing client transport and durable journal.
It consumes a whole SSE response before executing any advertised action or
posting a result, so it does not overlap the backend's conversation writer lease.
Only `custom` / `extension.action_requested` frames followed by a durable waiting
state can execute. Raw SDK interrupts, conflicting turn IDs, error events and
missing final browser states cannot produce a successful completion.

Each action rechecks the Limova conversation and an injected browser-authority
check before entering the journal. A completed receipt is submitted on the same
turn; an uncertain receipt stops for inspection. The next response determines
which actions remain pending. Reconnect uses the existing recovery GET and
`browser_resume`, never a second human message. A lost result response does not
trigger an automatic retry. The action budget bounds a malformed repeating
response; it does not mark the backend turn completed.

Ten unit tests and a Chromium test joining the runner with real IndexedDB cover
these decisions, including lost-response recovery with exactly one local effect.
The API and executor in this browser test are fixtures. The runner is not yet
invoked by the worker: the actual authorized page driver, immediate target checks,
uncertainty UI and end-to-end backend/browser validation remain required.

## Browser driver

`browser-document.js` runs through `chrome.scripting` in the ISOLATED world. Its document token, version and element map stay in a private closure; DOM `data-lid` attributes do not select targets. The binding layer also retains Chrome's distinct document ID and targets subsequent injections with `documentIds`. A missing document is not retried against its replacement. IndexedDB allocates monotonic versions within the private account/workspace session, including across worker restarts.

The driver pins the active tab, checks consent and origin permission, and supports bounded page reads, click, type, scroll, highlight, HTTPS navigation and masked screenshots. Target fingerprints, visibility, overlays and versions are checked before DOM effects. Navigation dispatches from the bound document, requires destination permission, and subsequent page reads wait for Chrome loading/pending navigation to finish. Dispatch and load completion do not prove business success. DOM observations exclude input values and marked private regions; arbitrary page text is not guaranteed to be free of sensitive data. DOM interaction inside frames/shadow roots remains incomplete.

The panel's browser opt-in resets after each send or context change. The worker excludes training/evaluation and rechecks AI processing consent. Unchecking during a turn requests cancellation. Explicit resume requires fresh opt-in and reuses the durable session/turn without a new human message. An uncertain action is not automatically repeated. Live API recovery after a real service-worker crash remains unverified.

Optional HTTPS host access is requested for one normalized origin from the user's click; no wildcard access is granted at installation. Site permission and per-message browser consent are separate. New-host permission acceptance still needs end-to-end validation. [Chrome permissions documentation](https://developer.chrome.com/docs/extensions/reference/api/permissions).

## Masked screenshots

Chrome captures the active tab of a window rather than an exact document ID. `browser-screenshot.js` monitors tab activation, updates, removal, movement, zoom and window focus while checking the authorized document before and after capture. The isolated document supplies only masking geometry, a revision counter and viewport dimensions. DOM changes, scrolling, input or viewport changes invalidate that geometry. Animated pages, excessive geometry and split views are rejected. These checks do not make Chrome's capture API an atomic document-bound operation.

Mask geometry covers form/editable fields, marked private regions (including their content bounds), frames, embedded objects, canvas and video. Open and closed shadow roots are inspected through Chrome's DOM API and observed for mutations; fields overflowing a shadow host are masked by their own bounds. This masks identified regions, not all potentially sensitive free text or arbitrary CSS rendering effects.

The raw PNG stays in memory. OffscreenCanvas paints every mask, checks viewport scaling, and emits a masked PNG limited to 5 MiB. Missing/invalid geometry or rendering failures never fall back to an unmasked image. Only that blob reaches the upload callback. The worker binds uploads to its account/workspace/conversation; after a 401 refresh the client rechecks the account and shared flag before resending the upload.

Uploads use the existing multipart `POST /files?isTemporary=true&useAsDefaultContext=false`. The browser result includes only the returned UUID as `imageFileId`. IndexedDB preserves it across receipt replay so capture/upload is not repeated. A network failure after upload begins remains uncertain; orphan-upload cleanup is still outstanding. The backend validates ownership/workspace and resolves the image for the original Deep Agent tool call.

`captureVisibleTab` requires `activeTab` or `<all_urls>`; this extension uses its existing `activeTab` permission and does not add `<all_urls>`. The user must invoke the extension on the selected tab. A host permission alone does not satisfy capture authorization. [Chrome capture API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab), [closed shadow root API](https://developer.chrome.com/docs/extensions/reference/api/dom).

Chromium tests invoke the real extension action, capture a routed HTTPS fixture with native viewport dimensions, and inspect output pixels: public content stays visible while input/private/closed-shadow fields are masked. Other tests cover stale documents, geometry changes, more than 120 masks, invalid scale, cancellation and tab/window changes. Uploads in the capture test use a fixture callback; real Limova cookie handoff, end-to-end provider delivery and long-pause signed-URL renewal remain unverified. No rollout flag is activated by these tests.
