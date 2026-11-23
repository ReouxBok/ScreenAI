import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTeamController } from '../../../src/team/team-controller.js';
import { createPaymentVerifier } from '../../../src/team/payment-token.js';
import { TEAM_PRODUCT } from './helpers.js';

// Fixed vectors, computed with Python's hashlib/hmac (see payment-token.test.js).
const NOW = 1_795_680_000_000;
const DEVICE = '22222222-2222-2222-2222-222222222222';
const CLICK_TOKEN = {
  v: 1, id: '11111111-1111-1111-1111-111111111111', device_id: DEVICE,
  fp: '9474f5f427304641b28347f9a2011ddeebb45a9343fc157b76865353079aed7c', exp_ms: 1_795_680_120_000,
  sig: '13b30f939f201faa2856f798fb3ac31b56df8a36a8a92dff035eb71bbb5265f5'
};
const BATCH_TOKEN = {
  v: 1, id: '33333333-3333-3333-3333-333333333333', device_id: DEVICE,
  fp: '7e80561e4f6ec6ebbdf05d6cb4e681620ebe7aa6ce5cd1308e49133439f1ce90', exp_ms: 1_795_680_120_000,
  sig: '439447dedad1b8fa41d7ce9d8043a6aa4e6df367086b89cdd376a8755fb1fcdd'
};

function setup({ autonomy = 'approve_for_me', paused = false } = {}) {
  const browser = {
    runRead: vi.fn(async () => ({ ok: true, data: { tab: { domain: 'example.com' } } })),
    prepareAction: vi.fn(async (tool, args) => ({
      plan: { tool, args, element: { name: args.target, role: 'button', page: { path: '/' } }, domain: 'example.com', tab: { id: 1 } }
    })),
    executeAction: vi.fn(async () => ({ ok: true, data: { done: true, tab: { domain: 'example.com' } } })),
    adoptActiveTab: vi.fn(async () => ({ ok: true, data: { tab: { tab_id: 3, domain: 'example.org' } } })),
    setGroupTitle: vi.fn(async () => {})
  };
  const payments = createPaymentVerifier({ deviceId: () => DEVICE, deviceToken: () => 'lmd_test', now: () => NOW });
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
    payments,
    onActivity: entry => activity.push(entry),
    onBusyChange: info => busy.push(info)
  });
  controller.attachSocket(socket);
  return { controller, browser, payments, store, socket, activity, busy, order };
}

const call = (tool, args = {}, extra = {}) => ({ call_id: `c-${Math.random()}`, tool, args, deadline_ms: Date.now() + 60_000, ...extra });
const pay = (token, extra = {}) => call('browser.click', {
  tab_id: 812, snapshot_id: 's17', element_id: 'e3', target: 'Payer 49 €', risk: 'risky', risk_reason: 'pay',
  ...(token ? { payment_token: token } : {}), ...extra
});
const click = (target = 'Envoyer', risk = 'write', reason = null) => call('browser.click', {
  tab_id: 1, snapshot_id: 's1', element_id: 'e1', target, risk, risk_reason: reason
});

describe('team controller: no prompt of its own, payments by token (browser.v3)', () => {
  it('runs reads at every level, without asking', async () => {
    const { controller, activity } = setup({ autonomy: 'ask_every_time' });
    const result = await controller.handleCall(call('browser.read_page', { tab_id: 1 }));
    expect(result.ok).toBe(true);
    expect(activity[0]).toEqual(expect.objectContaining({ domain: 'example.com', label: 'Lecture de la page' }));
  });

  it('never asks before routine or risky actions, at any autonomy level: the chat decides', async () => {
    for (const autonomy of ['ask_every_time', 'approve_for_me', 'full_access']) {
      const { controller, browser } = setup({ autonomy });
      const progress = vi.fn();
      expect((await controller.handleCall(click('Tarifs'), { progress })).ok).toBe(true);
      expect((await controller.handleCall(click('Envoyer', 'risky', 'send'), { progress })).ok).toBe(true);
      expect((await controller.handleCall(click('Supprimer le compte', 'risky', 'account'), { progress })).ok).toBe(true);
      expect(progress).not.toHaveBeenCalled();
      expect(browser.executeAction).toHaveBeenCalledTimes(3);
    }
  });

  it('refuses a payment without a valid token: payment_confirmation_required, nothing done', async () => {
    for (const autonomy of ['ask_every_time', 'approve_for_me', 'full_access']) {
      const { controller, browser } = setup({ autonomy });
      const progress = vi.fn();
      const result = await controller.handleCall(pay(null), { progress });
      expect(result.error.code).toBe('payment_confirmation_required');
      expect(progress).not.toHaveBeenCalled();
      expect(browser.executeAction).not.toHaveBeenCalled();
    }
    // The server said « write », but the live button reads « Payer »: still a payment.
    const fromLocal = setup({ autonomy: 'full_access' });
    expect((await fromLocal.controller.handleCall(call('browser.click', { tab_id: 1, snapshot_id: 's1', element_id: 'e1', target: 'Payer 49 €', risk: 'write', risk_reason: null }))).error.code)
      .toBe('payment_confirmation_required');
    expect(fromLocal.browser.executeAction).not.toHaveBeenCalled();
  });

  it('pays once with the token the server minted after the owner’s click in the chat', async () => {
    const { controller, browser } = setup();
    expect((await controller.handleCall(pay(CLICK_TOKEN))).ok).toBe(true);
    expect(browser.executeAction).toHaveBeenCalledOnce();
    // Single use.
    expect((await controller.handleCall(pay(CLICK_TOKEN))).error.code).toBe('payment_confirmation_required');
    // Another element, tab or snapshot: the fingerprint no longer matches.
    const other = setup();
    expect((await other.controller.handleCall(pay(CLICK_TOKEN, { element_id: 'e4' }))).error.code).toBe('payment_confirmation_required');
    expect((await other.controller.handleCall(pay(CLICK_TOKEN, { tab_id: 813 }))).error.code).toBe('payment_confirmation_required');
    expect(other.browser.executeAction).not.toHaveBeenCalled();
  });

  it('pays a batch whose strictest step pays, with a token bound to its steps', async () => {
    const { controller, browser } = setup();
    const plan = {
      kind: 'batch',
      local: { risk: 'risky', reason: 'pay' },
      element: { name: 'Payer', role: 'button' },
      steps: [{ action: 'fill', element: { name: 'E-mail' } }, { action: 'click', element: { name: 'Payer' } }],
      domain: 'shop.example',
      tab: { id: 812 }
    };
    browser.prepareAction.mockResolvedValue({ plan });
    const steps = [{ action: 'fill', element_id: 'e1', target: 'E-mail', value: 'a@b.c' }, { action: 'click', element_id: 'fr2.e3', target: 'Payer' }];
    const args = { tab_id: 812, snapshot_id: 's17', steps, risk: 'write', risk_reason: null };
    expect((await controller.handleCall(call('browser.batch', args))).error.code).toBe('payment_confirmation_required');
    expect((await controller.handleCall(call('browser.batch', { ...args, payment_token: BATCH_TOKEN }))).ok).toBe(true);
    expect(browser.executeAction).toHaveBeenCalledOnce();
  });

  it('returns the engine error without asking (sensitive field, stale snapshot…)', async () => {
    const { controller, browser } = setup({ autonomy: 'ask_every_time' });
    browser.prepareAction.mockResolvedValueOnce({ error: { ok: false, error: { code: 'sensitive_field', message: 'x' } } });
    expect((await controller.handleCall(call('browser.fill', { value: 'x' }))).error.code).toBe('sensitive_field');
    expect(browser.executeAction).not.toHaveBeenCalled();
  });

  it('refuses everything while paused and unknown tools', async () => {
    const { controller } = setup({ paused: true });
    expect((await controller.handleCall(call('browser.list_tabs'))).error.code).toBe('paused');
    const fresh = setup();
    expect((await fresh.controller.handleCall(call('files.list'))).error.code).toBe('unsupported');
  });

  it('takes the person’s current tab for request_tab, without a picker', async () => {
    const { controller, browser } = setup({ autonomy: 'full_access' });
    const progress = vi.fn();
    const result = await controller.handleCall(call('browser.request_tab', { reason: 'Pour lire ta facture' }), { progress });
    expect(browser.adoptActiveTab).toHaveBeenCalledWith(true);
    expect(progress).not.toHaveBeenCalled();
    expect(result.data.tab.tab_id).toBe(3);
    expect((await controller.handleCall(call('browser.request_tab', { reason: 'x'.repeat(201) }))).error.code).toBe('invalid_args');
  });
});

describe('team controller: set_autonomy', () => {
  it('applies any level at once, without a window, then sends state before answering', async () => {
    for (const [from, to] of [['full_access', 'ask_every_time'], ['ask_every_time', 'full_access'], ['approve_for_me', 'full_access']]) {
      const { controller, store, socket } = setup({ autonomy: from });
      const answer = await controller.handleSetAutonomy({ autonomy: to });
      expect(answer).toEqual({ status: 'applied' });
      expect(store.update).toHaveBeenCalledWith('limova_team', { autonomy: to });
      expect(socket.sendState).toHaveBeenCalledOnce();
      expect(controller.getState().autonomy).toBe(to);
    }
  });

  it('sends each change its own state when two arrive together', async () => {
    const { controller, socket } = setup({ autonomy: 'full_access' });
    const levels = [];
    socket.sendState.mockImplementation(() => levels.push(controller.getState().autonomy));
    await Promise.all([
      controller.handleSetAutonomy({ autonomy: 'ask_every_time' }),
      controller.handleSetAutonomy({ autonomy: 'approve_for_me' })
    ]);
    expect(levels).toEqual(['ask_every_time', 'approve_for_me']);
  });

  it('starts at « Accès complet » when nothing is stored', () => {
    const controller = createTeamController({ product: TEAM_PRODUCT, browser: {} });
    expect(controller.getState().autonomy).toBe('full_access');
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

  it('« Tout arrêter » cancels running and held calls, pauses and sends state', async () => {
    let finishRead;
    const { controller, browser, store, socket } = setup();
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
