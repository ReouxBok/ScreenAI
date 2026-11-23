// team-controller.js — One product connection's rules: autonomy, payments, pause,
// take-over and « Tout arrêter » (TEAM-724, TEAM-757).
//
// The socket (device-socket.js) hands every `call`, `set_autonomy` and
// `browser_control` to this controller. The controller decides, the engine
// (browser-engine.js) acts:
//
// - paused: every call answers `paused`; only the person resumes, from the side panel;
// - taken over (« Prendre la main »): new calls are held (`progress` `taken_over`) and
//   run in order on « Rendre la main »; a call still held at its deadline answers
//   `taken_over`;
// - otherwise reads and actions run at once. `browser.v3` (TEAM-757): the extension
//   shows NO prompt of its own. The chat's single level is the only permission, and the
//   server asks in the chat when it wants a yes. The engine still checks every action
//   (sensitive fields, blocked sites, stale ids). A payment-class action (the stricter
//   of the server's and the extension's reading says `pay`) runs only with a valid,
//   single-use `payment_token` the server mints after the owner's click on the chat's
//   payment card (payment-token.js); otherwise it answers
//   `payment_confirmation_required` and does nothing;
// - `browser.request_tab` takes the person's current tab (the active tab of the last
//   focused window) into the group, without a picker;
// - « Tout arrêter » cancels running and held calls (`paused`), sets paused and sends
//   `state`.
//
// `browser.fill_secret` (TEAM-729) follows the same pause and take-over rules, never
// opens a window (the person chose to save that login for Limova), and runs only on a
// socket that advertised `browser.v1+vault`: `ctx.vault()` hands the engine that
// socket's in-memory key, or null once the socket closed (`secret_unreadable`).
// A successful fill is reported with `onVaultFill`, so the offer to save (login-offers.js)
// does not ask to save the login Limova just typed.
//
// `browser.press_key` and `browser.upload` (TEAM-751) are actions like the others: the
// engine reads them (Enter on « Payer » is `pay`, so it needs a payment token). A key
// pressed on the focused element names no element (`plan.element` null).
//
// `set_autonomy` applies at once, in both directions, without a window (TEAM-726: only
// the signed-in owner can send it, and the level now only drives the chat's
// confirmations). It sends `state` before answering and never resumes a paused app.

import { DEFAULT_AUTONOMY, isAutonomyLevel } from './products.js';
import {
  activityLabel, classifyAction, isPaymentClass, stricterRisk, toolKind
} from './risk.js';
import { toolError } from './browser-engine.js';

const DEFAULT_READ_DEADLINE_MS = 40_000;
const DEFAULT_ACTION_DEADLINE_MS = 115_000;

export const AUTONOMY_LABELS = Object.freeze({
  ask_every_time: 'Demander une approbation',
  approve_for_me: 'Approuver pour moi',
  full_access: 'Accès complet'
});

export function createTeamController({
  product,
  initial = {},
  store,
  browser,
  // payment-token.js verifier for this connection (TEAM-757).
  payments = null,
  timers = globalThis,
  now = () => Date.now(),
  onStateChange = () => {},
  onBusyChange = () => {},
  onActivity = () => {},
  onVaultFill = () => {}
}) {
  const state = {
    autonomy: isAutonomyLevel(initial.autonomy) ? initial.autonomy : DEFAULT_AUTONOMY,
    paused: initial.paused === true,
    control: 'agent'
  };
  const running = new Map();
  const held = [];
  let socket = null;

  function getState() {
    return { ...state };
  }

  function sendState() {
    socket?.sendState?.();
    onStateChange(getState());
  }

  function busyChanged() {
    onBusyChange({ running: running.size, held: held.length, control: state.control });
    Promise.resolve(browser?.setGroupTitle?.(running.size > 0)).catch(() => {});
  }

  function deadlineOf(call, kind) {
    const deadline = Number(call.deadline_ms);
    if (Number.isFinite(deadline) && deadline > now()) return deadline;
    return now() + (kind === 'read' ? DEFAULT_READ_DEADLINE_MS : DEFAULT_ACTION_DEADLINE_MS);
  }

  function record(call, result, targetName) {
    const domain = result?.data?.tab?.domain || null;
    onActivity({
      product: product.id,
      at: now(),
      domain,
      label: activityLabel(call.tool, call.args, targetName),
      outcome: result?.ok ? 'done' : (result?.error?.code || 'internal')
    });
  }

  async function execute(call, ctx, signal) {
    const kind = toolKind(call.tool);
    const args = call.args || {};
    if (kind === 'read') {
      const result = await browser.runRead(call.tool, args, { signal, busy: true });
      record(call, result);
      return result;
    }

    if (kind === 'vault') {
      if (typeof ctx.vault !== 'function') return toolError('unsupported', 'This browser does not fill saved logins.');
      const result = await browser.fillSecret(args, { callId: call.call_id, vault: ctx.vault(), signal, busy: true });
      record(call, result);
      if (result?.ok) onVaultFill({ tabId: args.tab_id, origin: args.origin });
      return result;
    }

    if (kind === 'access') {
      if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 200) {
        return toolError('invalid_args', 'reason must be 1 to 200 characters');
      }
      // No picker (TEAM-757): the chat level already decided; the person's current tab
      // joins the group. `reason` is kept for the activity list.
      if (state.paused || signal.aborted) return toolError('paused', 'Paused by the person.');
      const result = await browser.adoptActiveTab(true);
      record(call, result);
      return result;
    }

    // Actions: check, judge, ask only before paying, then act.
    const prepared = await browser.prepareAction(call.tool, args);
    if (prepared.error) {
      record(call, prepared.error);
      return prepared.error;
    }
    const { plan } = prepared;
    // The engine reads each action (a batch: the strictest of its steps).
    const local = plan.local || classifyAction(call.tool, plan.element || {});
    const targetName = plan.element?.name || '';
    const risk = stricterRisk({ risk: args.risk, reason: args.risk_reason }, local);
    if (isPaymentClass(risk)) {
      // Only the owner's click in the chat pays: a valid, unused token for this exact call.
      const verdict = payments ? await payments.verify(call.tool, args) : { ok: false, reason: 'missing' };
      if (!verdict.ok) {
        const error = toolError('payment_confirmation_required',
          `A payment needs the owner's confirmation in the Limova chat (${verdict.reason}).`);
        record(call, error, targetName);
        return error;
      }
      if (state.paused || signal.aborted) return toolError('paused', 'Paused by the person.');
    }
    const result = await browser.executeAction(plan, { signal, busy: true });
    record(call, result, targetName);
    return result;
  }

  async function run(call, ctx) {
    const abort = new AbortController();
    let cancel;
    const cancelled = new Promise(resolve => {
      cancel = () => {
        abort.abort();
        resolve(toolError('paused', 'Stopped by the person.'));
      };
    });
    running.set(call.call_id, { cancel });
    busyChanged();
    try {
      return await Promise.race([
        execute(call, ctx, abort.signal).catch(error => toolError('internal', String(error?.message || 'internal').slice(0, 200))),
        cancelled
      ]);
    } finally {
      running.delete(call.call_id);
      busyChanged();
    }
  }

  function hold(call, ctx) {
    return new Promise(resolve => {
      const item = { call, ctx, resolve, timer: null };
      const kind = toolKind(call.tool);
      item.timer = timers.setTimeout(() => {
        const index = held.indexOf(item);
        if (index >= 0) held.splice(index, 1);
        busyChanged();
        resolve(toolError('taken_over', 'The person is driving the browser. Ask them to hand back with « Rendre la main ».'));
      }, Math.max(0, deadlineOf(call, kind) - now()));
      held.push(item);
      ctx.progress?.('taken_over');
      busyChanged();
    });
  }

  async function drainHeld() {
    while (held.length) {
      if (state.control === 'owner') return;
      if (state.paused) {
        for (const item of held.splice(0)) {
          timers.clearTimeout(item.timer);
          item.resolve(toolError('paused', 'Limova is paused in this browser.'));
        }
        busyChanged();
        return;
      }
      const item = held.shift();
      timers.clearTimeout(item.timer);
      busyChanged();
      item.resolve(await run(item.call, item.ctx));
    }
  }

  async function handleCall(call, ctx = {}) {
    if (!toolKind(call.tool)) return toolError('unsupported', `This version does not know ${String(call.tool).slice(0, 60)}.`);
    if (state.paused) return toolError('paused', 'Limova is paused in this browser.');
    if (state.control === 'owner') return hold(call, ctx);
    return run(call, ctx);
  }

  async function applyAutonomy(level) {
    // Apply and announce before persisting: two quick changes must each send their own
    // `state` before their own answer, never the other one's level.
    state.autonomy = level;
    sendState();
    await store?.update(product.id, { autonomy: level }).catch(() => null);
    onActivity({ product: product.id, at: now(), domain: null, label: `Autonomie : ${AUTONOMY_LABELS[level]}`, outcome: 'done' });
  }

  // From the dashboard chat (TEAM-726): applied at once, either way, without a window.
  async function handleSetAutonomy(message) {
    const level = message?.autonomy;
    if (!isAutonomyLevel(level)) return { status: 'rejected' };
    if (level !== state.autonomy) await applyAutonomy(level);
    return { status: 'applied' };
  }

  function takeOver() {
    if (state.control !== 'owner') {
      state.control = 'owner';
      sendState();
      busyChanged();
    }
    return { status: 'applied', control: state.control, paused: state.paused };
  }

  function handBack() {
    if (state.control !== 'agent') {
      state.control = 'agent';
      sendState();
      busyChanged();
      drainHeld();
    }
    return { status: 'applied', control: state.control, paused: state.paused };
  }

  function stopAll() {
    state.paused = true;
    for (const entry of [...running.values()]) entry.cancel();
    for (const item of held.splice(0)) {
      timers.clearTimeout(item.timer);
      item.resolve(toolError('paused', 'Stopped by the person.'));
    }
    store?.update(product.id, { paused: true }).catch(() => null);
    sendState();
    busyChanged();
    onActivity({ product: product.id, at: now(), domain: null, label: 'Tout arrêter', outcome: 'done' });
    return { status: 'applied', control: state.control, paused: true };
  }

  function resume() {
    if (!state.paused) return getState();
    state.paused = false;
    store?.update(product.id, { paused: false }).catch(() => null);
    sendState();
    onActivity({ product: product.id, at: now(), domain: null, label: 'Reprise', outcome: 'done' });
    drainHeld();
    return getState();
  }

  function handleBrowserControl(message) {
    switch (message?.action) {
      case 'take_over': return takeOver();
      case 'hand_back': return handBack();
      case 'stop_all': return stopAll();
      default: return { status: 'rejected', control: state.control, paused: state.paused };
    }
  }

  // The person changes the level in the side panel: they are the person, no confirmation.
  async function setAutonomyFromPanel(level) {
    if (!isAutonomyLevel(level)) return false;
    if (level !== state.autonomy) await applyAutonomy(level);
    return true;
  }

  // The connection is going away (Déconnecter, 4401): nothing may keep running.
  function dispose() {
    for (const entry of [...running.values()]) entry.cancel();
    for (const item of held.splice(0)) {
      timers.clearTimeout(item.timer);
      item.resolve(toolError('paused', 'Disconnected.'));
    }
    socket = null;
    busyChanged();
  }

  return {
    product,
    getState,
    attachSocket(next) { socket = next; },
    handleCall,
    handleSetAutonomy,
    handleBrowserControl,
    takeOver,
    handBack,
    stopAll,
    resume,
    setAutonomyFromPanel,
    dispose,
    counts: () => ({ running: running.size, held: held.length })
  };
}
