// build-config.js — Which Limova Team environment this build talks to (TEAM-726).
//
// User builds talk to production only: the person picks « Limova Team », clicks
// « Se connecter », and never sees an environment choice. A test build for staging is
// made with `LIMOVA_TEAM_ENV=staging npm run build`, which rewrites this file in
// build/ only (scripts/build-extension.sh); the source stays on production.
//
// Developer toggle: on any build, running
//   chrome.storage.local.set({ limova_team_developer_v1: true })
// in the extension's service-worker console shows the environment choice in the side
// panel. Pages cannot set it: content scripts never write chrome.storage here.
export const TEAM_BUILD = Object.freeze({
  defaultEnvironment: 'production'
});

export const DEVELOPER_TOGGLE_KEY = 'limova_team_developer_v1';
