// team-service.js — Wires product connections into the service worker (TEAM-724).
//
// background.js creates one service and forwards every `TEAM_*` runtime message to it.
// For each stored connection (connections.js) the service runs:
//   DeviceSocket (device-socket.js) -> TeamController (team-controller.js)
//     -> product scope of the shared BrowserEngine (browser-engine.js)
// and keeps, in memory only, what the side panel shows: status, owner e-mail, a short
// activity list (domain + label). It also owns the global action badge (« IA » while a
// call runs, « ⏸ » while the person took over) and a chrome.alarms alarm that
// reconnects every minute after Chrome restarts the service worker.
//
// TEAM-726: user builds connect to production only. The environment is the build's
// (build-config.js); the choice is only offered, and only accepted, when the developer
// toggle is on.

import { DeviceSocket } from './device-socket.js';
import { createConnectionStore, fetchDeviceOwner, revokeConnection } from './connections.js';
import { createPairing } from './pairing.js';
import { createBrowserEngine } from './browser-engine.js';
import { createApprovalManager } from './approvals.js';
import { createTeamController } from './team-controller.js';
import { getEnvironment, getProduct, listProducts } from './products.js';
import { DEVELOPER_TOGGLE_KEY, TEAM_BUILD } from './build-config.js';

export const RECONNECT_ALARM = 'limova-team-reconnect';
export const HOLDS_SESSION_KEY = 'limova_socket_holds_v1';
const ACTIVITY_LIMIT = 20;

export const TEAM_MESSAGE_TYPES = Object.freeze([
  'TEAM_GET_STATE', 'TEAM_CONNECT', 'TEAM_DISCONNECT', 'TEAM_PAIR_CALLBACK', 'TEAM_SET_AUTONOMY',
  'TEAM_PAUSE', 'TEAM_RESUME', 'TEAM_STOP_ALL', 'TEAM_TAKE_OVER', 'TEAM_HAND_BACK', 'TEAM_RECONNECT',
  'TEAM_APPROVAL_GET', 'TEAM_APPROVAL_DECIDE'
]);

export function isTeamMessage(type) {
  return TEAM_MESSAGE_TYPES.includes(type);
}

const PAIRING_ERRORS = {
  invalid_callback: 'Le lien de connexion est incomplet. Relance la connexion depuis le panneau Charly.',
  no_pending_pairing: 'Aucune connexion n’est en cours dans ce navigateur, ou elle a expiré. Relance-la depuis le panneau Charly.',
  state_mismatch: 'Ce lien de connexion ne correspond pas à la demande de ce navigateur. Relance la connexion depuis le panneau Charly.',
  network: 'Impossible de joindre Limova Team. Vérifie ta connexion puis réessaie.',
  disabled: 'La connexion de Chrome n’est pas encore ouverte pour ton espace Limova Team.',
  rejected: 'Limova Team a refusé ce code : il a peut-être expiré. Relance la connexion depuis le panneau Charly.',
  invalid_response: 'Réponse inattendue de Limova Team. Réessaie dans un instant.'
};

export function createTeamService({
  chromeApi = globalThis.chrome,
  fetchImpl = (...args) => globalThis.fetch(...args),
  WebSocketImpl = globalThis.WebSocket,
  renderCapture,
  timers = globalThis,
  now = () => Date.now(),
  build = TEAM_BUILD
} = {}) {
  const store = createConnectionStore({ storage: chromeApi.storage.local });
  const pairing = createPairing({
    session: chromeApi.storage.session, tabs: chromeApi.tabs, runtime: chromeApi.runtime, store, fetchImpl
  });
  const engine = createBrowserEngine({ chromeApi, renderCapture });
  const approvals = createApprovalManager({
    windowsApi: chromeApi.windows,
    getUrl: path => chromeApi.runtime.getURL(path),
    timers
  });
  const links = new Map();
  const activity = [];
  let holds = null;
  let broadcastTimer = null;
  let initialized = null;

  function extensionPage(path) {
    return chromeApi.runtime.getURL(path);
  }

  async function loadHolds() {
    if (holds) return holds;
    const data = await Promise.resolve(chromeApi.storage.session?.get(HOLDS_SESSION_KEY)).catch(() => ({}));
    holds = data?.[HOLDS_SESSION_KEY] && typeof data[HOLDS_SESSION_KEY] === 'object' ? { ...data[HOLDS_SESSION_KEY] } : {};
    return holds;
  }

  function persistHold(productId, hold) {
    holds = holds || {};
    if (hold) holds[productId] = hold;
    else delete holds[productId];
    Promise.resolve(chromeApi.storage.session?.set({ [HOLDS_SESSION_KEY]: holds })).catch(() => {});
  }

  function pushActivity(entry) {
    // Domain and label only: never page text, URLs, values or screenshots.
    activity.push({
      product: entry.product,
      at: entry.at,
      domain: typeof entry.domain === 'string' ? entry.domain.slice(0, 120) : null,
      label: String(entry.label || '').slice(0, 120),
      outcome: entry.outcome
    });
    while (activity.length > ACTIVITY_LIMIT) activity.shift();
    scheduleBroadcast();
  }

  let developerMode = false;

  async function loadDeveloperMode() {
    const data = await Promise.resolve(chromeApi.storage.local.get(DEVELOPER_TOGGLE_KEY)).catch(() => ({}));
    developerMode = data?.[DEVELOPER_TOGGLE_KEY] === true;
    return developerMode;
  }

  function buildEnvironment(product) {
    return getEnvironment(product.id, build.defaultEnvironment) ? build.defaultEnvironment : product.defaultEnvironment;
  }

  function panelState() {
    return {
      environmentChoice: developerMode,
      products: listProducts().map(product => {
        const link = links.get(product.id);
        const state = link?.controller.getState();
        const counts = link?.controller.counts();
        return {
          id: product.id,
          label: product.label,
          color: product.color,
          defaultEnvironment: buildEnvironment(product),
          environments: developerMode
            ? Object.values(product.environments).map(env => ({ id: env.id, label: env.label }))
            : [{ id: buildEnvironment(product), label: getEnvironment(product.id, buildEnvironment(product)).label }],
          connection: link ? {
            environment: link.connection.environment,
            environment_label: getEnvironment(product.id, link.connection.environment)?.label || '',
            device_name: link.connection.device_name,
            status: link.status,
            email: link.email,
            autonomy: state.autonomy,
            paused: state.paused,
            control: state.control,
            running: counts.running,
            held: counts.held
          } : null
        };
      }),
      activity: [...activity].reverse()
    };
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = timers.setTimeout(() => {
      broadcastTimer = null;
      Promise.resolve(chromeApi.runtime.sendMessage?.({ type: 'TEAM_STATE', state: panelState() })).catch(() => {});
    }, 50);
  }

  function refreshIndicator() {
    let owner = null;
    let busy = null;
    for (const link of links.values()) {
      if (link.controller.getState().control === 'owner') owner = owner || link.product;
      if (link.controller.counts().running > 0) busy = busy || link.product;
    }
    const text = owner ? '⏸' : busy ? 'IA' : '';
    const color = (owner || busy)?.color;
    Promise.resolve(chromeApi.action?.setBadgeText?.({ text })).catch(() => {});
    if (color) {
      Promise.resolve(chromeApi.action?.setBadgeBackgroundColor?.({ color })).catch(() => {});
      Promise.resolve(chromeApi.action?.setBadgeTextColor?.({ color: '#FFFFFF' })).catch(() => {});
    }
    scheduleBroadcast();
  }

  function teardown(productId) {
    const link = links.get(productId);
    if (!link) return;
    links.delete(productId);
    link.socket.stop();
    link.controller.dispose();
    refreshIndicator();
  }

  async function forget(productId) {
    teardown(productId);
    await store.forget(productId).catch(() => {});
    persistHold(productId, null);
    scheduleBroadcast();
  }

  async function refreshOwner(link) {
    const owner = await fetchDeviceOwner(store, link.connection, { fetchImpl });
    if (owner?.revoked) {
      await forget(link.productId);
      return;
    }
    if (owner && links.get(link.productId) === link) {
      link.email = owner.email;
      scheduleBroadcast();
    }
  }

  function createLink(connection) {
    const product = getProduct(connection.product);
    const env = getEnvironment(connection.product, connection.environment);
    if (!product || !env) return null;
    const link = { productId: product.id, product, connection, status: 'connecting', email: null, ownerFetched: false };
    const controller = createTeamController({
      product,
      initial: connection,
      store,
      browser: engine.forProduct(product),
      approvals,
      timers,
      now,
      onStateChange: scheduleBroadcast,
      onBusyChange: refreshIndicator,
      onActivity: pushActivity
    });
    const socket = new DeviceSocket({
      url: `${env.api.replace(/^https:/, 'wss:')}/api/v1/devices/me/socket`,
      getToken: () => link.connection.device_token,
      getState: controller.getState,
      appVersion: chromeApi.runtime.getManifest?.().version || '0.0.0',
      handlers: {
        onCall: controller.handleCall,
        onSetAutonomy: controller.handleSetAutonomy,
        onBrowserControl: controller.handleBrowserControl
      },
      onStatus: status => {
        link.status = status;
        if (status === 'online' && !link.ownerFetched) {
          link.ownerFetched = true;
          refreshOwner(link);
        }
        scheduleBroadcast();
      },
      onRevoked: () => { forget(product.id); },
      onHold: hold => persistHold(product.id, hold),
      WebSocketImpl,
      timers,
      now,
      hold: holds?.[product.id] || null
    });
    link.controller = controller;
    link.socket = socket;
    controller.attachSocket(socket);
    links.set(product.id, link);
    socket.start();
    if (socket.status === 'idle') link.status = socket.isHeld() ? (socket.hold?.reason === 'replaced' ? 'replaced' : 'disabled') : 'offline';
    return link;
  }

  // Start a socket for every stored connection; drop links whose connection is gone.
  async function ensureAll() {
    await loadHolds();
    const connections = await store.list().catch(() => []);
    const wanted = new Set(connections.map(connection => connection.product));
    for (const productId of [...links.keys()]) {
      if (!wanted.has(productId)) teardown(productId);
    }
    for (const connection of connections) {
      const link = links.get(connection.product);
      if (!link) createLink(connection);
      else link.socket.start();
    }
    scheduleBroadcast();
  }

  function init() {
    if (initialized) return initialized;
    chromeApi.windows?.onRemoved?.addListener?.(windowId => approvals.windowClosed(windowId));
    chromeApi.alarms?.onAlarm?.addListener?.(alarm => {
      if (alarm?.name === RECONNECT_ALARM) ensureAll().catch(() => {});
    });
    Promise.resolve(chromeApi.alarms?.create?.(RECONNECT_ALARM, { periodInMinutes: 1 })).catch(() => {});
    chromeApi.storage.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && DEVELOPER_TOGGLE_KEY in changes) loadDeveloperMode().then(scheduleBroadcast);
    });
    initialized = Promise.all([loadDeveloperMode(), ensureAll()]).catch(() => {});
    return initialized;
  }

  function controllerFor(productId) {
    return links.get(productId)?.controller || null;
  }

  async function handleMessage(request, sender = {}) {
    await (initialized || init());
    const productId = typeof request.productId === 'string' ? request.productId : 'limova_team';
    switch (request.type) {
      case 'TEAM_GET_STATE':
        return { ok: true, state: panelState() };

      case 'TEAM_CONNECT': {
        const product = getProduct(productId);
        if (!product) return { ok: false, error: 'invalid_environment' };
        // Without the developer toggle, only the build's environment is accepted.
        const environment = request.environment === undefined ? buildEnvironment(product) : request.environment;
        if (!getEnvironment(productId, environment)) return { ok: false, error: 'invalid_environment' };
        if (!developerMode && environment !== buildEnvironment(product)) return { ok: false, error: 'invalid_environment' };
        const started = await pairing.start({ productId, environment });
        return { ok: true, tabId: started.tabId };
      }

      case 'TEAM_PAIR_CALLBACK': {
        // Only our own callback page may finish a pairing.
        if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionPage('src/team/pair-callback.html'))) {
          return { ok: false, error: 'invalid_callback', message: PAIRING_ERRORS.invalid_callback };
        }
        try {
          const connection = await pairing.complete({ code: request.code, state: request.state });
          teardown(connection.product);
          persistHold(connection.product, null);
          createLink(connection);
          return { ok: true, product: getProduct(connection.product)?.label || '' };
        } catch (error) {
          const code = PAIRING_ERRORS[error?.code] ? error.code : 'invalid_response';
          return { ok: false, error: code, message: PAIRING_ERRORS[code] };
        }
      }

      case 'TEAM_DISCONNECT': {
        teardown(productId);
        persistHold(productId, null);
        const outcome = await revokeConnection(store, productId, { fetchImpl });
        scheduleBroadcast();
        return { ok: true, ...outcome };
      }

      case 'TEAM_SET_AUTONOMY': {
        const controller = controllerFor(productId);
        if (!controller) return { ok: false, error: 'not_connected' };
        return { ok: await controller.setAutonomyFromPanel(request.autonomy) };
      }

      case 'TEAM_PAUSE': {
        const controller = controllerFor(productId);
        if (!controller) return { ok: false, error: 'not_connected' };
        controller.stopAll();
        return { ok: true };
      }

      case 'TEAM_RESUME': {
        const controller = controllerFor(productId);
        if (!controller) return { ok: false, error: 'not_connected' };
        controller.resume();
        return { ok: true };
      }

      case 'TEAM_STOP_ALL':
        for (const link of links.values()) link.controller.stopAll();
        return { ok: true };

      case 'TEAM_TAKE_OVER': {
        const controller = controllerFor(productId);
        if (!controller) return { ok: false, error: 'not_connected' };
        controller.takeOver();
        return { ok: true };
      }

      case 'TEAM_HAND_BACK': {
        const controller = controllerFor(productId);
        if (!controller) return { ok: false, error: 'not_connected' };
        controller.handBack();
        return { ok: true };
      }

      case 'TEAM_RECONNECT': {
        const link = links.get(productId);
        if (!link) return { ok: false, error: 'not_connected' };
        persistHold(productId, null);
        link.socket.start({ force: true });
        return { ok: true };
      }

      case 'TEAM_APPROVAL_GET': {
        if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionPage('src/team/approval.html'))) return { ok: false };
        const details = approvals.get(String(request.id || ''));
        return details ? { ok: true, details } : { ok: false };
      }

      case 'TEAM_APPROVAL_DECIDE': {
        if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionPage('src/team/approval.html'))) return { ok: false };
        const decided = approvals.decide(String(request.id || ''), request.decision, { tabId: request.tabId });
        return { ok: decided };
      }

      default:
        return { ok: false, error: 'unknown_message' };
    }
  }

  return { init, ensureAll, handleMessage, panelState, links, approvals, store };
}
