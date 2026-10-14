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
