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
`LIMOVA_OPEN_APP`, `LIMOVA_LOGOUT`.

Events: `LIMOVA_TURN_STARTED`, `LIMOVA_STREAM_EVENT`, `LIMOVA_TURN_ENDED`,
`LIMOVA_SESSION_CHANGED`. The SSE parser preserves native values/custom/update
events and rejects incomplete frames instead of inventing a complete answer.

Depends on API PR #2193 for the flag and channel contract, and #2194 for Studio
knowledge. The additional host permission is restricted to the Limova API.

Still required: connect the sidebar interface to these commands, complete
history/artifact rendering, validate actual Chrome cookie partition behavior,
and then implement browser/voice/training parity. The current packaged sidebar
still uses the legacy workflow: this is not a release-ready migration. No
production activation or real-account session-sharing proof is claimed.
