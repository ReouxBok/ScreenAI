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

This foundation depends on the API browser HTTP branch. The service-worker
session lifecycle, local action receipts and browser executor are not connected
to these methods yet. Existing panel calls remain text-only. The generated ZIP
is still an intermediate development artifact, not the final migration release.
