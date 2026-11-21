// team-controller.js — One product connection's rules: autonomy, approvals, pause,
// take-over and « Tout arrêter » (TEAM-724).
//
// The socket (device-socket.js) hands every `call`, `set_autonomy` and
// `browser_control` to this controller. The controller decides, the engine
// (browser-engine.js) acts:
//
// - paused: every call answers `paused`; only the person resumes, from the side panel;
// - taken over (« Prendre la main »): new calls are held (`progress` `taken_over`) and
//   run in order on « Rendre la main »; a call still held at its deadline answers
//   `taken_over`;
// - otherwise reads and actions run at once (`browser.v2`, TEAM-726): the engine checks
//   every action (sensitive fields, blocked sites, stale ids) and the only approval
//   window left is for paying, judged with the stricter of the server's and the
//   extension's reading (`progress` `waiting_approval`, `approval_timeout` at the
//   deadline, `denied_by_owner` on « Refuser »). Other confirmations happen in the
//   chat, decided by the server from the autonomy level;
// - « Tout arrêter » cancels running and held calls (`paused`), closes open approval
//   windows as refused, sets paused and sends `state`.
//
// `set_autonomy` applies at once, in both directions, without a window (TEAM-726: only
// the signed-in owner can send it, and the level now only drives the chat's
// confirmations). It sends `state` before answering and never resumes a paused app.

import { DEFAULT_AUTONOMY, isAutonomyLevel } from './products.js';
import {
  activityLabel, approvalTitle, classifyAction, needsOwnerApproval, PAY_REASON_TEXT, stricterRisk, toolKind
} from './risk.js';
import { toolError } from './browser-engine.js';

const DEFAULT_READ_DEADLINE_MS = 40_000;
const DEFAULT_ACTION_DEADLINE_MS = 115_000;

export const AUTONOMY_LABELS = Object.freeze({
  ask_every_time: 'Demander une approbation',
  approve_for_me: 'Approuver pour moi',
  full_access: 'Accès complet'
});

function previewValue(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export function createTeamController({
  product,
  initial = {},
  store,
  browser,
  approvals,
  timers = globalThis,
  now = () => Date.now(),
  onStateChange = () => {},
  onBusyChange = () => {},
  onActivity = () => {}
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

  async function ask(details, call, ctx, signal) {
    ctx.progress?.('waiting_approval');
    return approvals.request({
      productId: product.id,
      productLabel: product.label,
      productColor: product.color,
      ...details
    }, { deadlineMs: deadlineOf(call, 'action'), signal });
  }

  function outcomeError(decision) {
    if (decision === 'deny') return toolError('denied_by_owner', 'The person refused.');
    if (decision === 'timeout') return toolError('approval_timeout', 'The person did not answer in time.');
    return toolError('paused', 'Stopped by the person.');
  }

  async function execute(call, ctx, signal) {
    const kind = toolKind(call.tool);
    const args = call.args || {};
    if (kind === 'read') {
      const result = await browser.runRead(call.tool, args, { signal, busy: true });
      record(call, result);
      return result;
    }

    if (kind === 'access') {
      if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 200) {
        return toolError('invalid_args', 'reason must be 1 to 200 characters');
      }
      const tabs = await browser.shareableTabs();
      const outcome = await ask({
        kind: 'request_tab',
        title: `${product.label} demande l’accès à l’un de vos onglets`,
        reason: args.reason.trim(),
        tabs
      }, call, ctx, signal);
      if (outcome.decision !== 'approve') return outcomeError(outcome.decision);
      if (state.paused) return toolError('paused', 'Paused by the person.');
      const result = await browser.adoptTab(outcome.tabId, true);
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
    // A batch carries the strictest reading of its steps; a single action is read here.
    const local = plan.local || classifyAction(call.tool, plan.element);
    const risk = stricterRisk({ risk: args.risk, reason: args.risk_reason }, local);
    if (needsOwnerApproval(risk)) {
      const lines = [];
      if (call.tool === 'browser.fill') lines.push({ label: 'Texte', text: previewValue(args.value) });
      if (call.tool === 'browser.select') lines.push({ label: 'Choix', text: previewValue(args.option) });
      if (plan.kind === 'batch') {
        lines.push({
          label: 'Étapes',
          text: plan.steps.map((step, index) => `${index + 1}. ${activityLabel(`browser.${step.action === 'check' ? 'click' : step.action}`, {}, step.element.name)}`).join('\n')
        });
      }
      const outcome = await ask({
        kind: 'action',
        title: approvalTitle(product.label, call.tool, plan.element.name, plan.domain),
        domain: plan.domain,
        target: plan.element.name,
        reason: PAY_REASON_TEXT,
        lines
      }, call, ctx, signal);
      if (outcome.decision !== 'approve') {
        const error = outcomeError(outcome.decision);
        record(call, error, plan.element.name);
        return error;
      }
      if (state.paused || signal.aborted) return toolError('paused', 'Paused by the person.');
    }
    const result = await browser.executeAction(plan, { signal, busy: true });
    record(call, result, plan.element.name);
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
    approvals.denyAll(product.id);
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
    approvals.denyAll(product.id);
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
