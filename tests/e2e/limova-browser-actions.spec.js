import { test, expect, CONVERSATION, APP } from './native-chat-fixture.js';

const read = { operation: 'read_page' };
const reference = (body, label) => JSON.parse(body.browserResult.observation).elements.find(item => item.label === label)?.elementId ?? 999999;
const messageCalls = calls => calls.filter(call => call.path === `/message/${CONVERSATION}`);
async function send(panel, text = 'Remplis le champ Brief', observe = false) {
  await panel.evaluate(({ text, observe }) => {
    if (observe) document.getElementById('screenshotBtn').click();
    else {
      document.getElementById('limovaBrowser').checked = true;
      document.getElementById('userInput').value = text;
      document.getElementById('sendBtn').click();
    }
  }, { text, observe });
  await expect(panel.locator('.message.assistant .message-content')).toHaveText('Action traitée.');
  await expect(panel.locator('#sendBtn')).toBeEnabled();
}

for (const recover of [false, true]) test(`native text fills the exact field${recover ? ' after rejecting a wrong target and rereading the page' : ''}`, async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  state.browserActions = [read,
    ...(recover ? [body => ({ operation: 'type_text', elementId: reference(body, 'Continuer'), text: 'Must not enter this value' }), read] : []),
    body => ({ operation: 'type_text', elementId: reference(body, 'Brief'), text: 'Brief produit préparé par Charly' }),
  ];
  await send(panel);
  await expect(app.locator('textarea')).toHaveValue('Brief produit préparé par Charly');
  expect(await app.evaluate(() => window.inputEvents)).toBe(1);
  expect(await app.evaluate(() => window.clicks)).toBe(0);
  const requests = messageCalls(calls);
  expect(requests.filter(call => !call.body.kind)).toHaveLength(1);
  const receipts = requests.slice(1).map(call => call.body.browserResult);
  expect(receipts.map(receipt => receipt.status)).toEqual(recover ? ['completed', 'rejected', 'completed', 'completed'] : ['completed', 'completed']);
  expect(new Set(receipts.map(receipt => receipt.turnId)).size).toBe(1);
  expect(new Set(receipts.map(receipt => receipt.actionId)).size).toBe(receipts.length);
  for (const call of requests) {
    expect(call.body).not.toHaveProperty('systemInstruction');
    expect(call.body).not.toHaveProperty('model');
  }
  expect(JSON.stringify(receipts)).not.toMatch(/PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET/);
  await expect(panel.locator('.screenshot-bubble')).toHaveCount(0);
  await expect(app.locator('#limova-visual-capture-overlays')).toHaveCount(0);
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

for (const observe of [false, true]) test(`native ${observe ? 'page analysis refuses' : 'authorized text executes'} a browser click`, async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  if (observe) await app.locator('#action').evaluate(button => { button.textContent = 'Supprimer le brouillon'; });
  state.browserActions = [read, body => ({ operation: 'click', elementId: reference(body, observe ? 'Supprimer le brouillon' : 'Continuer') })];
  await send(panel, 'Accompagne-moi sur cette page', observe);
  expect(await app.evaluate(() => window.clicks)).toBe(observe ? 0 : 1);
  const receipt = messageCalls(calls).at(-1).body.browserResult;
  expect(receipt.status).toBe(observe ? 'rejected' : 'completed');
  await expect(panel.locator('.action-card')).toHaveCount(0);
  await expect(panel.locator('#limovaBrowser')).not.toBeChecked();
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});


test('native navigation continues the same conversation after the destination document is ready', async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  state.browserActions = [{ operation: 'navigate', url: `${APP}/profil` }, read];
  await send(panel, 'Ouvre mon profil pour continuer');
  await expect(app).toHaveURL(`${APP}/profil`);
  const requests = messageCalls(calls);
  expect(requests).toHaveLength(3);
  expect(requests.slice(1).map(call => call.body.browserResult.status)).toEqual(['completed', 'completed']);
  expect(new Set(requests.slice(1).map(call => call.body.browserResult.turnId)).size).toBe(1);
  expect(requests[1].body.browserContext.contextVersion).toBeGreaterThan(requests[0].body.browserContext.contextVersion);
  expect(requests[2].body.browserResult.observation).toContain('Tableau de bord');
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

test('page analysis highlights the exact field and refuses invented references without acting', async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  await app.evaluate(() => {
    const field = document.querySelector('textarea');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;width:900px;padding:10px';
    field.before(row); row.append(field);
    field.style.cssText = 'width:360px;height:42px';
    // Observe real animations without replacing Element.animate or the driver.
    window.guidanceTargets = [];
    window.guidanceObserver = setInterval(() => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect?.target;
        if (target && !window.guidanceTargets.includes(target)) window.guidanceTargets.push(target);
      }
    }, 10);
  });
  state.browserActions = [read,
    body => ({ operation: 'highlight', elementId: reference(body, 'Brief') }),
    { operation: 'highlight', elementId: 999999 },
  ];
  await send(panel, '', true);
  await expect.poll(() => app.evaluate(() => window.guidanceTargets.length)).toBe(1);
  expect(await app.evaluate(() => {
    clearInterval(window.guidanceObserver);
    return window.guidanceTargets[0] === document.querySelector('textarea');
  })).toBe(true);
  expect(messageCalls(calls).slice(1).map(call => call.body.browserResult.status)).toEqual(['completed', 'completed', 'rejected']);
  await expect(app.locator('textarea')).toHaveValue('PRIVATE_FIELD_VALUE');
  expect(await app.evaluate(() => ({ clicks: window.clicks, inputs: window.inputEvents }))).toEqual({ clicks: 0, inputs: 0 });
  await expect(panel.locator('#limovaBrowser')).not.toBeChecked();
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

for (const operation of ['click', 'type_text']) test(`native ${operation} shows its target without changing the page layout or intercepting input`, async ({ nativeChat }) => {
  const { panel, app, state, calls } = nativeChat;
  state.reply = 'Action traitée.';
  await app.evaluate(operation => {
    const target = document.querySelector(operation === 'click' ? '#action' : 'textarea');
    window.beforeActionBox = target.getBoundingClientRect().toJSON();
    target.addEventListener(operation === 'click' ? 'click' : 'input', () => {
      const pointer = document.querySelector('[data-limova-native-pointer]');
      const box = pointer?.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      window.pointerAtAction = {
        present: Boolean(pointer), hidden: pointer?.getAttribute('aria-hidden'),
        x: box?.left, y: box?.top, expectedX: targetBox.left + targetBox.width / 2,
        expectedY: targetBox.top + targetBox.height / 2,
        intercepts: document.elementFromPoint(targetBox.left + targetBox.width / 2, targetBox.top + targetBox.height / 2) !== target,
        layoutUnchanged: JSON.stringify(targetBox.toJSON()) === JSON.stringify(window.beforeActionBox),
      };
    });
  }, operation);
  state.browserActions = [read, body => ({ operation, elementId: reference(body, operation === 'click' ? 'Continuer' : 'Brief'),
    ...(operation === 'type_text' ? { text: 'Texte natif' } : {}) }), read];
  await send(panel);
  const pointer = await app.evaluate(() => window.pointerAtAction);
  expect(pointer).toMatchObject({ present: true, hidden: 'true', intercepts: false, layoutUnchanged: true });
  expect(Math.abs(pointer.x - pointer.expectedX)).toBeLessThan(1);
  expect(Math.abs(pointer.y - pointer.expectedY)).toBeLessThan(1);
  await expect(app.locator('[data-limova-native-pointer]')).toHaveCount(0);
  const observed = messageCalls(calls).at(-1).body.browserResult.observation;
  expect(observed).not.toContain('limova-native-pointer');
  expect(await app.evaluate(() => ({ clicks: window.clicks, inputs: window.inputEvents })))
    .toEqual(operation === 'click' ? { clicks: 1, inputs: 0 } : { clicks: 0, inputs: 1 });
});

for (const observe of [false, true]) test(`native ${observe ? 'analysis refuses' : 'consented action activates'} a custom integration control`, async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  await app.evaluate(() => {
    const main = document.querySelector('main');
    main.replaceChildren();
    const heading = document.createElement('h1'); heading.textContent = 'Intégrations';
    const description = document.createElement('p'); description.textContent = 'Connectez votre compte Gmail';
    const control = document.createElement('div'); control.className = 'cursor-pointer'; control.id = 'gmail-control';
    control.style.cssText = 'width:180px;padding:16px';
    control.textContent = 'Gmail';
    const secret = document.createElement('span'); secret.dataset.limovaPrivate = ''; secret.textContent = 'PRIVATE_CONTROL_VALUE';
    control.append(secret);
    const hidden = document.createElement('span'); hidden.hidden = true; hidden.textContent = 'PRIVATE_HIDDEN_LABEL'; control.append(hidden);
    const draft = document.createElement('textarea'); draft.textContent = 'PRIVATE_NESTED_FIELD'; control.append(draft);
    window.controlEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) control.addEventListener(type, event => {
      window.controlEvents.push({ type, buttons: event.buttons, pointer: Boolean(document.querySelector('[data-limova-native-pointer]')) });
      if (type === 'pointerdown') control.dataset.activated = 'true';
    });
    main.append(heading, description, control);
  });
  state.browserActions = [read, body => ({ operation: 'click', elementId: reference(body, 'Gmail') }), read];
  await send(panel, 'Ouvre la connexion Gmail', observe);
  expect(await app.locator('#gmail-control').getAttribute('data-activated')).toBe(observe ? null : 'true');
  const events = await app.evaluate(() => window.controlEvents);
  expect(events.map(event => event.type)).toEqual(observe ? [] : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  if (!observe) {
    expect(events.every(event => event.pointer)).toBe(true);
    expect(events.find(event => event.type === 'pointerup').buttons).toBe(0);
  }
  const receipts = messageCalls(calls).slice(1).map(call => call.body.browserResult);
  expect(receipts.map(receipt => receipt.status)).toEqual(['completed', observe ? 'rejected' : 'completed', 'completed']);
  expect(receipts[0].observation).toContain('Connectez votre compte Gmail');
  expect(JSON.stringify(receipts)).not.toMatch(/PRIVATE_CONTROL_VALUE|PRIVATE_NESTED_FIELD|PRIVATE_HIDDEN_LABEL/);
  await expect(panel.locator('.action-card')).toHaveCount(0);
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

for (const change of ['detach', 'private', 'covered', 'navigate']) test(`native click stops its remaining events when pointerdown makes the target ${change}`, async ({ nativeChat }) => {
  const { panel, app, calls, state } = nativeChat;
  state.reply = 'Action traitée.';
  await app.evaluate(change => {
    const target = document.querySelector('#action');
    window.pointerDowns = 0;
    target.addEventListener('pointerdown', () => {
      window.pointerDowns++;
      if (change === 'detach') {
        const replacement = target.cloneNode(true);
        replacement.onclick = () => window.clicks++;
        target.replaceWith(replacement);
      } else if (change === 'private') target.dataset.limovaPrivate = '';
      else if (change === 'navigate') history.pushState({}, '', '/autre-contexte');
      else {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;inset:0;z-index:100000;background:white';
        document.body.append(cover);
      }
    });
  }, change);
  state.browserActions = [read, body => ({ operation: 'click', elementId: reference(body, 'Continuer') })];
  await send(panel, 'Clique sur Continuer');
  expect(await app.evaluate(() => ({ clicks: window.clicks, down: window.pointerDowns }))).toEqual({ clicks: 0, down: 1 });
  expect(messageCalls(calls).at(-1).body.browserResult.status).toBe('completed');
  expect(messageCalls(calls).at(-1).body.browserResult.observation).toContain('target changed before click');
  expect(messageCalls(calls)).toHaveLength(3);
});

for (const destination of [
  { path: '/profil', label: 'Ouvrir mon profil', request: 'Ouvre mon profil' },
  { path: '/integrations/catalog', label: 'Intégrations', request: 'Je veux connecter Gmail, emmène-moi là où je peux le faire.' },
]) test(`native named navigation reaches ${destination.path} as an authorized step in the same turn`, async ({ nativeChat }) => {
  const { app, panel, state, calls, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  await app.evaluate(({ path, label }) => {
    const link = document.createElement('a');
    link.href = path; link.textContent = label;
    link.addEventListener('click', () => {
      sessionStorage.setItem('nativeNavigation', JSON.stringify({
        clicks: Number(sessionStorage.getItem('nativeNavigationCount') ?? 0) + 1,
        pointer: Boolean(document.querySelector('[data-limova-native-pointer]')),
      }));
      sessionStorage.setItem('nativeNavigationCount', '1');
    });
    document.querySelector('main').prepend(link);
  }, destination);
  state.browserActions = [read, body => ({ operation: 'click', elementId: reference(body, destination.label) }), read];
  await send(panel, destination.request);
  await expect(app).toHaveURL(`${APP}${destination.path}`);
  expect(await app.evaluate(() => JSON.parse(sessionStorage.getItem('nativeNavigation')))).toEqual({ clicks: 1, pointer: true });
  const receipts = messageCalls(calls).slice(1).map(call => call.body.browserResult);
  expect(receipts.map(receipt => receipt.status)).toEqual(['completed', 'completed', 'completed']);
  expect(new Set(receipts.map(receipt => receipt.turnId)).size).toBe(1);
  expect(JSON.parse(receipts.at(-1).observation).url).toBe(`${APP}${destination.path}`);
  await expect(panel.locator('.action-card')).toHaveCount(0);
  await expect(panel.locator('.message.error')).toHaveCount(0);
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});


test('native diagnostics report repeated rejected actions without replay or private observations', async ({ nativeChat }) => {
  const { panel, app, state, calls, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  state.browserActions = [read, { operation: 'click', elementId: 999998 }, { operation: 'click', elementId: 999999 }];
  await send(panel);
  expect(await app.evaluate(() => window.clicks)).toBe(0);
  const before = messageCalls(calls).length;
  await panel.reload();
  await panel.locator('#menuBtn').click();
  await panel.locator('#diagnoseBtn').click();
  await expect(panel.locator('#diagnosticResult')).toHaveAttribute('data-status', 'degraded');
  await expect(panel.locator('#diagnosticText')).toContainText('2 actions bloquées');
  const downloadPromise = panel.waitForEvent('download');
  await panel.locator('#downloadLogsBtn').click();
  const stream = await (await downloadPromise).createReadStream();
  let logs = '';
  for await (const chunk of stream) logs += chunk.toString();
  expect(logs).toContain('DIAGNOSTIC_BROWSER_ACTIONS_DEGRADED');
  expect(logs).not.toMatch(/PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET/);
  expect(messageCalls(calls)).toHaveLength(before);
  await panel.locator('#limovaNew').click();
  await expect(panel.locator('.message.user')).toHaveCount(0);
  await panel.locator('#diagnoseBtn').click();
  await expect(panel.locator('#diagnosticResult')).toHaveAttribute('data-status', 'healthy');
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});


test('native turn rejects a pre-navigation reference and continues only after reading the new SPA page', async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.reply = 'Action traitée.';
  state.browserActions = [read,
    async body => {
      const elementId = reference(body, 'Continuer');
      await app.evaluate(() => history.pushState({}, '', '/nouvelle-page?private_token=PRIVATE_ROUTE'));
      return { operation: 'click', elementId };
    },
    read,
    body => ({ operation: 'click', elementId: reference(body, 'Continuer') }),
  ];
  await send(panel, 'Continue le parcours');
  const receipts = messageCalls(calls).slice(1).map(call => call.body.browserResult);
  expect(receipts.map(receipt => receipt.status)).toEqual(['completed', 'rejected', 'completed', 'completed']);
  expect(JSON.parse(receipts[2].observation).url).toBe(`${APP}/nouvelle-page`);
  expect(receipts[2].contextVersion).toBeGreaterThan(receipts[1].contextVersion);
  expect(await app.evaluate(() => window.clicks)).toBe(1);
  expect(new Set(receipts.map(receipt => receipt.turnId)).size).toBe(1);
  expect(JSON.stringify(messageCalls(calls))).not.toContain('PRIVATE_ROUTE');
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});
