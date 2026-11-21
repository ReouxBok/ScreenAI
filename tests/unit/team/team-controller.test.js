import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTeamController } from '../../../src/team/team-controller.js';
import { TEAM_PRODUCT } from './helpers.js';

function setup({ autonomy = 'approve_for_me', paused = false, decide = async () => ({ decision: 'approve' }) } = {}) {
  const browser = {
    runRead: vi.fn(async () => ({ ok: true, data: { tab: { domain: 'example.com' } } })),
    prepareAction: vi.fn(async (tool, args) => ({
      plan: { tool, args, element: { name: args.target, role: 'button', page: { path: '/' } }, domain: 'example.com', tab: { id: 1 } }
    })),
    executeAction: vi.fn(async () => ({ ok: true, data: { done: true, tab: { domain: 'example.com' } } })),
    shareableTabs: vi.fn(async () => [{ tab_id: 3, domain: 'example.org' }]),
    adoptTab: vi.fn(async tabId => ({ ok: true, data: { tab: { tab_id: tabId } } })),
    setGroupTitle: vi.fn(async () => {})
  };
  const approvals = { request: vi.fn(decide), denyAll: vi.fn() };
  const store = { update: vi.fn(async () => ({})) };
  const socket = { sendState: vi.fn() };
  const order = [];
  socket.sendState.mockImplementation(() => order.push('state'));
  const activity = [];
  const busy = [];
  const controller = createTeamController({
    product: TEAM_PRODUCT,
    initial: { autonomy, paused },
    store,
    browser,
    approvals,
    onActivity: entry => activity.push(entry),
    onBusyChange: info => busy.push(info)
  });
  controller.attachSocket(socket);
  return { controller, browser, approvals, store, socket, activity, busy, order };
}

const call = (tool, args = {}, extra = {}) => ({ call_id: `c-${Math.random()}`, tool, args, deadline_ms: Date.now() + 60_000, ...extra });
const click = (target = 'Envoyer', risk = 'write', reason = null) => call('browser.click', {
  tab_id: 1, snapshot_id: 's1', element_id: 'e1', target, risk, risk_reason: reason
});

describe('team controller: autonomy and approvals', () => {
  it('runs reads at every level, without asking', async () => {
    const { controller, approvals, activity } = setup({ autonomy: 'ask_every_time' });
    const result = await controller.handleCall(call('browser.read_page', { tab_id: 1 }));
    expect(result.ok).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(activity[0]).toEqual(expect.objectContaining({ domain: 'example.com', label: 'Lecture de la page' }));
  });

  it('asks for a write under « Demander une approbation » and sends waiting_approval', async () => {
    const { controller, approvals, browser } = setup({ autonomy: 'ask_every_time' });
    const progress = vi.fn();
    const result = await controller.handleCall(click('Tarifs'), { progress });
    expect(progress).toHaveBeenCalledWith('waiting_approval');
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'action', title: 'Limova Team veut cliquer sur « Tarifs » sur example.com', productId: 'limova_team' }),
      expect.objectContaining({ deadlineMs: expect.any(Number) })
    );
    expect(browser.executeAction).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('keeps the stricter reading: a server « write » on « Envoyer » still asks under « Approuver pour moi »', async () => {
    const { controller, approvals } = setup({ autonomy: 'approve_for_me' });
    await controller.handleCall(click('Envoyer', 'write', null));
    expect(approvals.request).toHaveBeenCalledOnce();
    expect(approvals.request.mock.calls[0][0].reason).toBe('Cette action envoie un message ou des données.');
  });

  it('runs a plain write under « Approuver pour moi » and a risky one under « Accès complet »', async () => {
    const balanced = setup({ autonomy: 'approve_for_me' });
    await balanced.controller.handleCall(click('Tarifs'));
    expect(balanced.approvals.request).not.toHaveBeenCalled();
    const full = setup({ autonomy: 'full_access' });
    await full.controller.handleCall(click('Envoyer', 'risky', 'send'));
    expect(full.approvals.request).not.toHaveBeenCalled();
  });

  it('always asks to pay or change the account, even under « Accès complet »', async () => {
    const { controller, approvals } = setup({ autonomy: 'full_access' });
    await controller.handleCall(click('Payer', 'risky', 'pay'));
    await controller.handleCall(click('Continuer', 'write', 'account'));
    expect(approvals.request).toHaveBeenCalledTimes(2);
  });

  it('answers denied_by_owner on refuse and approval_timeout at the deadline', async () => {
    const denied = setup({ autonomy: 'ask_every_time', decide: async () => ({ decision: 'deny' }) });
    expect((await denied.controller.handleCall(click())).error.code).toBe('denied_by_owner');
    expect(denied.browser.executeAction).not.toHaveBeenCalled();
    const late = setup({ autonomy: 'ask_every_time', decide: async () => ({ decision: 'timeout' }) });
    expect((await late.controller.handleCall(click())).error.code).toBe('approval_timeout');
  });

  it('returns the engine error without asking (sensitive field, stale snapshot…)', async () => {
    const { controller, browser, approvals } = setup({ autonomy: 'ask_every_time' });
    browser.prepareAction.mockResolvedValueOnce({ error: { ok: false, error: { code: 'sensitive_field', message: 'x' } } });
    expect((await controller.handleCall(call('browser.fill', { value: 'x' }))).error.code).toBe('sensitive_field');
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('refuses everything while paused and unknown tools', async () => {
    const { controller } = setup({ paused: true });
    expect((await controller.handleCall(call('browser.list_tabs'))).error.code).toBe('paused');
    const fresh = setup();
    expect((await fresh.controller.handleCall(call('files.list'))).error.code).toBe('unsupported');
  });

  it('asks the person to pick a tab for request_tab', async () => {
    const { controller, approvals, browser } = setup({ autonomy: 'full_access', decide: async () => ({ decision: 'approve', tabId: 3 }) });
    const result = await controller.handleCall(call('browser.request_tab', { reason: 'Pour lire ta facture' }));
    expect(approvals.request.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: 'request_tab', reason: 'Pour lire ta facture', tabs: [{ tab_id: 3, domain: 'example.org' }] }));
    expect(browser.adoptTab).toHaveBeenCalledWith(3, true);
    expect(result.data.tab.tab_id).toBe(3);
    expect((await controller.handleCall(call('browser.request_tab', { reason: 'x'.repeat(201) }))).error.code).toBe('invalid_args');
  });
});

describe('team controller: set_autonomy', () => {
  it('lowers at once, then sends state before answering', async () => {
    const { controller, store, socket, approvals } = setup({ autonomy: 'full_access' });
    const answer = await controller.handleSetAutonomy({ autonomy: 'ask_every_time' });
    expect(answer).toEqual({ status: 'applied' });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('limova_team', { autonomy: 'ask_every_time' });
    expect(socket.sendState).toHaveBeenCalled();
    expect(controller.getState().autonomy).toBe('ask_every_time');
  });

  it('asks before raising, within 50 s', async () => {
    const approve = setup({ autonomy: 'ask_every_time' });
    const before = Date.now();
    expect(await approve.controller.handleSetAutonomy({ autonomy: 'full_access' })).toEqual({ status: 'applied' });
    const [details, options] = approve.approvals.request.mock.calls[0];
    expect(details.kind).toBe('autonomy');
    expect(options.deadlineMs - before).toBeLessThanOrEqual(50_100);
    const refuse = setup({ autonomy: 'ask_every_time', decide: async () => ({ decision: 'deny' }) });
    expect(await refuse.controller.handleSetAutonomy({ autonomy: 'full_access' })).toEqual({ status: 'rejected' });
    expect(refuse.controller.getState().autonomy).toBe('ask_every_time');
    const late = setup({ autonomy: 'ask_every_time', decide: async () => ({ decision: 'timeout' }) });
    expect(await late.controller.handleSetAutonomy({ autonomy: 'approve_for_me' })).toEqual({ status: 'timeout' });
  });

  it('answers applied for the same level, rejected for an unknown one, and never resumes', async () => {
    const { controller, socket } = setup({ autonomy: 'approve_for_me', paused: true });
    expect(await controller.handleSetAutonomy({ autonomy: 'approve_for_me' })).toEqual({ status: 'applied' });
    expect(socket.sendState).not.toHaveBeenCalled();
    expect(await controller.handleSetAutonomy({ autonomy: 'yolo' })).toEqual({ status: 'rejected' });
    await controller.handleSetAutonomy({ autonomy: 'ask_every_time' });
    expect(controller.getState().paused).toBe(true);
  });
});

describe('team controller: take-over, hand-back and « Tout arrêter »', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('holds calls while the person drives, then runs them in order on hand-back', async () => {
    const { controller, browser, socket } = setup();
    expect(controller.handleBrowserControl({ action: 'take_over' })).toEqual({ status: 'applied', control: 'owner', paused: false });
    expect(socket.sendState).toHaveBeenCalledTimes(1);
    const progress = vi.fn();
    const first = controller.handleCall(call('browser.read_page', { tab_id: 1 }), { progress });
    const second = controller.handleCall(call('browser.list_tabs'), { progress });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledWith('taken_over');
    expect(browser.runRead).not.toHaveBeenCalled();
    expect(controller.counts().held).toBe(2);
    expect(controller.handleBrowserControl({ action: 'hand_back' })).toEqual({ status: 'applied', control: 'agent', paused: false });
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(browser.runRead.mock.calls.map(([tool]) => tool)).toEqual(['browser.read_page', 'browser.list_tabs']);
  });

  it('answers taken_over when a held call reaches its deadline', async () => {
    const { controller } = setup();
    controller.takeOver();
    const held = controller.handleCall(call('browser.read_page', { tab_id: 1 }, { deadline_ms: Date.now() + 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await held).error.code).toBe('taken_over');
    expect(controller.counts().held).toBe(0);
  });

  it('« Tout arrêter » cancels running and held calls, refuses approvals, pauses and sends state', async () => {
    let finishRead;
    const { controller, browser, approvals, store, socket } = setup();
    browser.runRead.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const runningCall = controller.handleCall(call('browser.read_page', { tab_id: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    controller.takeOver();
    const heldCall = controller.handleCall(call('browser.list_tabs'));
    await vi.advanceTimersByTimeAsync(0);
    const answer = controller.handleBrowserControl({ action: 'stop_all' });
    expect(answer).toEqual({ status: 'applied', control: 'owner', paused: true });
    expect((await runningCall).error.code).toBe('paused');
    expect((await heldCall).error.code).toBe('paused');
    expect(approvals.denyAll).toHaveBeenCalledWith('limova_team');
    expect(store.update).toHaveBeenCalledWith('limova_team', { paused: true });
    expect(socket.sendState).toHaveBeenCalled();
    expect((await controller.handleCall(call('browser.list_tabs'))).error.code).toBe('paused');
    finishRead({ ok: true, data: {} });
    controller.resume();
    expect(controller.getState().paused).toBe(false);
  });

  it('rejects an unknown browser_control action', () => {
    const { controller } = setup();
    expect(controller.handleBrowserControl({ action: 'explode' })).toEqual({ status: 'rejected', control: 'agent', paused: false });
  });

  it('reports busy state for the « IA » badge and the group title', async () => {
    let finish;
    const { controller, browser, busy } = setup();
    browser.runRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = controller.handleCall(call('browser.read_page', { tab_id: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(busy.at(-1)).toEqual(expect.objectContaining({ running: 1 }));
    expect(browser.setGroupTitle).toHaveBeenLastCalledWith(true);
    finish({ ok: true, data: {} });
    await pending;
    expect(busy.at(-1)).toEqual(expect.objectContaining({ running: 0 }));
    expect(browser.setGroupTitle).toHaveBeenLastCalledWith(false);
  });
});
