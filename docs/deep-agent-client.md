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
account and workspace, and agent resolution uses the existing `charly` slug.

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
localization, validate actual Chrome cookie partition behavior, and implement
browser/voice/training parity. Legacy voice, page analysis and privacy controls
still need migration; this is not a release-ready package. Browser UI tests use
a simulated Limova session, not a real-account cookie handoff. No production
activation or real-account session-sharing proof is claimed.

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

## Isolated document driver foundation

`browser-document.js` is a self-contained function for `chrome.scripting` in the
ISOLATED world. Its document token, context version and element map stay in a
private closure. DOM `data-lid` attributes do not select targets. Detached nodes,
changed target fingerprints, stale versions, covered targets and sensitive text
fields are rejected. A successful document operation advances the context
version; the driver must allocate versions and bind the Chrome document identity.

It supports bounded visible-page observations, click, text input, scroll and
highlight. Observations omit input values and explicitly private/sensitive DOM
regions, and remain valid JSON within 32,000 characters. This is not a guarantee
that arbitrary page text contains no sensitive data. Reading is viewport-bound
and limited; frames/shadow roots and richer page extraction remain to validate.
Clicks report dispatch, not business success, and scroll reports actual movement.

Ten Chromium tests inject the actual function into a routed HTTPS fixture page
and exercise real DOM effects and isolation. They do not exercise the final worker
or a live Limova model. Navigation, redacted screenshots, the privileged Chrome
driver, monotonic versions across navigation/restart and uncertainty handling
remain to connect before enabling browser actions.

The local Chrome binding transport keeps Chrome's `documentId` separate from the isolated registry token. Subsequent commands target `documentIds` explicitly; a missing document is never retried against the tab's replacement document. Context versions are allocated in strict IndexedDB transactions on the current private session record, shared across connections and retained after reopening storage. Revoked sessions cannot allocate versions. Session rotation starts a new counter namespace; backend session validation remains required. This transport is not yet connected to the worker's action dispatch or permission lifecycle.

`browser-driver.js` assembles the authority checks, journal version allocator and document transport for a captured account/workspace/session. It pins the first active tab, requires consent and Chrome origin permission, and exposes only the public page tuple. Authority is checked again after allocating the next version and before dispatch. Navigation and screenshots are not implemented in this driver yet and return an explicit rejection; activeTab-only grants and the permission-request UI remain to be integrated before multi-site rollout. The worker does not activate this driver yet.

The worker now constructs the browser runner for messages explicitly opted in through the panel checkbox. The opt-in resets after each send and account/conversation reset; unchecking during a turn requests cancellation. The outer worker checks AI processing consent and excludes staff training/evaluation, while the driver rechecks those conditions through its consent callback. Ordinary messages stay text-only. The panel surfaces uncertain results without replaying them. This is a local integration: backend HTTP publication, reconnect/resume UI, navigation/screenshots, multi-site permission requests and end-to-end live API validation remain outstanding.

The panel now offers an explicit browser-turn resume button. It requires a fresh browser opt-in and invokes `LIMOVA_RESUME_BROWSER`; the worker uses the runner's existing-session recovery (`getBrowserTurn` then `resumeBrowserTurn`) without sending another human message. AI consent and staff-mode exclusion apply to resume as well as send. Absent/cancelled/uncertain states are displayed. Actual worker-restart recovery against the deployed API is still unverified.

Navigation now dispatches `location.assign` inside the exact bound isolated document after destination HTTPS/credential validation and Chrome origin permission checks. Destination permission is checked again immediately before source authority validation and dispatch. The observation confirms dispatch only, never successful loading. A lost document response remains uncertain through the journal; it is not retried automatically. Waiting for destination readiness before submitting the receipt remains to be integrated; if the immediate page read encounters navigation in progress, explicit resume can recover the stored receipt. Screenshot transport remains unimplemented.

`readPage` now waits up to 15 seconds while Chrome reports a loading or pending navigation, using tab update/removal events. Abort, closed/discarded tabs and timeout stop the wait and remove listeners; no action is retried. Site permission and authority are checked after readiness. This confirms Chrome's load status, not application hydration or business success; subsequent DOM reads still determine available targets.
