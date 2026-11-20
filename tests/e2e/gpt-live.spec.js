import { test, expect } from './fixtures.js';

async function setup(context, extensionId, { deferMicrophone = false } = {}) {
  await context.route(/^https?:/, route => {
    if (route.request().url() === 'http://localhost:45678/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<main><h1>Agenda démo</h1><label for="agenda">Agenda Anthony</label><input id="agenda" type="checkbox"></main>' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: false, enabled: false, recentMessages: [] }) });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ limova_ai_processing_consent_v1: true, charly_usage_analytics_v1: false, charly_auth_session_v1: { token: 'e2e-' + 'x'.repeat(48), expiresAt: Date.now() + 3600000 }, limova_lang: 'fr' }));
  const web = await context.newPage(); await web.goto('http://localhost:45678/');
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
  await panel.locator('#userInput').click();
  await panel.evaluate(defer => {
    window.__sent = [];
    if (defer) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints); window.__lateMicrophone = stream;
        return new Promise(resolve => { window.__releaseMicrophone = () => resolve(stream); });
      };
    }
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async request => {
      if (request.type !== 'GET_LIVE_SESSION') return send(request);
      const remote = window.__remote = new RTCPeerConnection();
      remote.addEventListener('datachannel', ({ channel }) => {
        window.__remoteChannel = channel;
        channel.addEventListener('open', () => channel.send(JSON.stringify({ type: 'session.started' })));
        channel.addEventListener('message', ({ data }) => {
          const event = JSON.parse(data); window.__sent.push(event);
          if (event.type === 'session.close') channel.send(JSON.stringify({ type: 'session.closed' }));
        });
      });
      await remote.setRemoteDescription({ type: 'offer', sdp: request.sdp });
      await remote.setLocalDescription(await remote.createAnswer());
      await new Promise(resolve => {
        if (remote.iceGatheringState === 'complete') return resolve();
        remote.addEventListener('icegatheringstatechange', () => { if (remote.iceGatheringState === 'complete') resolve(); });
      });
      return { ok: true, sdp: remote.localDescription.sdp, model: 'gpt-live-1', contextVersion: 1 };
    };
  }, deferMicrophone);
  await web.bringToFront();
  await panel.evaluate(() => { void toggleVoice(); });
  if (deferMicrophone) await panel.waitForFunction(() => typeof window.__releaseMicrophone === 'function');
  else await panel.waitForFunction(() => voiceSession?.ready && !voiceSession.starting);
  return { panel, web };
}

test('release defaults to GPT Live; mute disables the real WebRTC microphone and stop releases it', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId);
  expect(await panel.evaluate(() => voiceSession.constructor.name)).toBe('LimovaOpenAiVoiceSession');
  const before = await panel.evaluate(() => ({ connected: voiceSession.peer.connectionState, enabled: voiceSession.stream.getAudioTracks()[0].enabled }));
  expect(before.connected).toBe('connected'); expect(before.enabled).toBe(true);
  await expect(panel.locator('audio')).toBeHidden();
  await panel.evaluate(() => toggleVoiceMute());
  expect(await panel.evaluate(() => voiceSession.stream.getAudioTracks()[0].enabled)).toBe(false);
  await panel.evaluate(() => toggleVoiceMute());
  expect(await panel.evaluate(() => voiceSession.stream.getAudioTracks()[0].enabled)).toBe(true);
  const stopped = await panel.evaluate(() => { const stream = voiceSession.stream; stopVoiceSession(); return stream.getTracks().every(track => track.readyState === 'ended'); });
  expect(stopped).toBe(true);
  await expect(panel.locator('#voiceControls')).toBeHidden();
  await panel.evaluate(() => window.__remote.close());
});

test('GPT overlapping transcripts produce one bubble per utterance', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId);
  await panel.evaluate(() => {
    const send = (type, delta, start_ms) => window.__remoteChannel.send(JSON.stringify({ type, delta, start_ms, end_ms: start_ms + 100 }));
    send('session.output_transcript.delta', '\uFFFD\uFFFD', 0);
    send('session.input_transcript.delta', 'Ouvre ', 0);
    send('session.output_transcript.delta', 'Je ', 0);
    send('session.input_transcript.delta', 'mon agenda.', 100);
    send('session.output_transcript.delta', 'regarde.', 100);
  });
  await expect(panel.locator('[data-voice-utterance-id]')).toHaveCount(2);
  await expect(panel.locator('[data-voice-utterance-id]').first()).toContainText('Ouvre mon agenda.');
  await expect(panel.locator('[data-voice-utterance-id]').last()).toContainText('Je regarde.');
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

test('a sentence resumed after a long pause still selects and verifies the requested calendar', async ({ mediaContext, mediaExtensionId }) => {
  const { panel, web } = await setup(mediaContext, mediaExtensionId);
  await web.evaluate(() => { window.changes = 0; document.querySelector('#agenda').addEventListener('change', () => window.changes++); });
  await panel.evaluate(() => {
    window.__remoteChannel.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Affiche mon agenda', start_ms: 0, end_ms: 100 }));
    window.__remoteChannel.send(JSON.stringify({ type: 'session.delegation.created', offset_ms: 100, delegation: { id: 'calendar-task' } }));
    window.__remoteChannel.send(JSON.stringify({ type: 'response.event', delegation_id: 'calendar-task', event: {
      type: 'response.output_item.done', item: { type: 'function_call', call_id: 'read-calendar', name: 'inspect_current_page', arguments: '{}' }
    } }));
  });
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'read-calendar'))).toBe(true);
  const revision = await panel.evaluate(() => voiceSession.taskRevision);
  await panel.evaluate(() => {
    // Session timestamps reproduce the speech pause without sleeping in the test.
    window.__remoteChannel.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: ' puis affiche celui d’Anthony', start_ms: 15000, end_ms: 15200 }));
    window.__remoteChannel.send(JSON.stringify({ type: 'response.event', delegation_id: 'calendar-task', event: {
      type: 'response.output_item.done', item: { type: 'function_call', call_id: 'show-calendar', name: 'select_control', arguments: JSON.stringify({ targetLabel: 'Agenda Anthony', checked: true }) }
    } }));
  });
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'show-calendar'))).toBe(true);
  expect(await panel.evaluate(() => JSON.parse(window.__sent.find(event => event.item?.call_id === 'show-calendar').item.output))).toMatchObject({ status: 'ok' });
  await expect(web.locator('#agenda')).toBeChecked();
  expect(await web.evaluate(() => window.changes)).toBe(1);
  expect(await panel.evaluate(() => voiceSession.taskRevision)).toBe(revision);
  await panel.evaluate(() => window.__remoteChannel.send(JSON.stringify({ type: 'response.event', delegation_id: 'calendar-task', event: {
    type: 'response.output_item.done', item: { type: 'function_call', call_id: 'verify-calendar', name: 'verify_expected_result', arguments: JSON.stringify({ conditions: [{ kind: 'control_checked', targetLabel: 'Agenda Anthony', checked: true }] }) }
  } })));
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'verify-calendar' && JSON.parse(event.item.output).verification?.status === 'confirmed'))).toBe(true);
  expect(await panel.evaluate(() => ({ ready: voiceSession.ready, steps: voiceSession.task.steps.length }))).toEqual({ ready: true, steps: 3 });
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

test('a correction during result delivery never duplicates a tool output or closes the voice connection', async ({ mediaContext, mediaExtensionId }) => {
  const { panel, web } = await setup(mediaContext, mediaExtensionId);
  await web.evaluate(() => { window.changes = 0; document.querySelector('#agenda').addEventListener('change', () => window.changes++); });
  await panel.evaluate(() => {
    voiceSession.sendVisualContext = () => new Promise(resolve => { window.__releaseImage = resolve; });
    window.__remoteChannel.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Affiche l’agenda d’Anthony', start_ms: 0, end_ms: 100 }));
    window.__remoteChannel.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'calendar-task' } }));
    window.__remoteChannel.send(JSON.stringify({ type: 'response.event', delegation_id: 'calendar-task', event: {
      type: 'response.output_item.done', item: { type: 'function_call', call_id: 'select-once', name: 'select_control', arguments: JSON.stringify({ targetLabel: 'Agenda Anthony', checked: true }) }
    } }));
  });
  await expect(web.locator('#agenda')).toBeChecked();
  await expect.poll(() => panel.evaluate(() => typeof window.__releaseImage === 'function' && window.__sent.some(event => event.item?.call_id === 'select-once'))).toBe(true);
  await panel.evaluate(async () => {
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Non, arrête', start_ms: 5000, end_ms: 5200 });
    window.__releaseImage(false);
    await voiceSession.toolQueue;
    window.__remoteChannel.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_command', message: 'Synthetic rejected command' } }));
  });
  await expect.poll(() => panel.evaluate(() => window.__sent.filter(event => event.type === 'response.create').length)).toBe(1);
  expect(await panel.evaluate(() => window.__sent.filter(event => event.item?.call_id === 'select-once').length)).toBe(1);
  await expect(panel.locator('.message.error')).toContainText('La conversation vocale reste active');
  await expect(panel.locator('#voiceControls')).toBeVisible();
  expect(await panel.evaluate(() => voiceSession.ready && !voiceSession.failed)).toBe(true);
  expect(await web.evaluate(() => window.changes)).toBe(1);
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

test('stopping GPT during microphone acquisition never revives its connection', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId, { deferMicrophone: true });
  await panel.evaluate(() => { stopVoiceSession(); window.__releaseMicrophone(); });
  await panel.waitForFunction(() => window.__lateMicrophone.getTracks().every(track => track.readyState === 'ended'));
  expect(await panel.evaluate(() => Boolean(voiceSession?.active))).toBe(false);
  expect(await panel.evaluate(() => window.__remote)).toBeUndefined();
});


test('autonomy labels match the requested wording and the level survives reopening', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId);
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.locator('#autonomyBtn').click();
  await expect(panel.locator('.autonomy-picker')).toContainText('Demander une approbation');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande avant modifications et commandes');
  await expect(panel.locator('.autonomy-picker')).toContainText('Approuver pour moi');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande seulement si c’est risqué');
  await expect(panel.locator('.autonomy-picker')).toContainText('Accès complet');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande rarement avant d’agir');
  await expect(panel.locator('input[name="autonomyMode"][value="balanced"]')).toBeChecked();
  const revision = await panel.evaluate(() => voiceSession.taskRevision);
  await panel.locator('input[name="autonomyMode"][value="ask"]').check();
  await expect(panel.locator('#autonomyStatus')).toContainText('mémorisé');
  await expect(panel.locator('#autonomyBtn')).toHaveAccessibleName('Autonomie Demander une approbation');
  expect(await panel.evaluate(revision => voiceSession.ready && voiceSession.taskRevision === revision, revision)).toBe(true);
  await panel.evaluate(() => stopVoiceSession());
  await panel.reload();
  await panel.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
  await expect(panel.locator('input[name="autonomyMode"][value="ask"]')).toBeChecked();
  await panel.locator('#autonomyBtn').click();
  await expect(panel.locator('#autonomyMenu')).toBeVisible();
  expect(await panel.locator('#autonomyMenu').evaluate(menu => menu.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
  await panel.keyboard.press('ArrowDown');
  await expect(panel.locator('input[name="autonomyMode"][value="balanced"]')).toBeChecked();
  await expect(panel.locator('#autonomyMenu')).toBeVisible();
  await panel.keyboard.press('Escape');
  await expect(panel.locator('#autonomyMenu')).toBeHidden();
  await expect(panel.locator('#autonomyBtn')).toBeFocused();
  await panel.locator('#autonomyBtn').click();
  await expect(panel.locator('#autonomyMenu')).toBeVisible();
  await panel.screenshot({ path: 'build/autonomy-menu-fr.png', animations: 'disabled' });
});

test('a spoken yes approves a pending Save once and the voice task continues to verification', async ({ mediaContext, mediaExtensionId }) => {
  const { panel, web } = await setup(mediaContext, mediaExtensionId);
  await web.evaluate(() => {
    window.saves = 0;
    document.body.innerHTML = '<main><h1>Calendrier</h1><div role="dialog"><h2>Nouvel événement</h2><input aria-label="Titre" value="Démo"><div role="button" tabindex="0" id="saveEvent">Enregistrer</div></div><p id="saved"></p></main>';
    document.getElementById('saveEvent').onclick = () => { window.saves += 1; document.querySelector('[role="dialog"]').remove(); document.getElementById('saved').textContent = 'Rendez-vous enregistré'; };
  });
  await web.bringToFront();
  await panel.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SET_AUTONOMY_MODE', mode: 'ask' });
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Crée un rendez-vous demain à 15h', start_ms: 0, end_ms: 100 });
    await voiceSession.taskUpdate;
    const user = voiceSession.transcripts.user;
    await chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', role: 'user', text: user.text, utteranceId: user.id, final: false });
  });
  const context = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' }));
  const elementId = Number(await web.locator('#saveEvent').getAttribute('data-lid'));
  const pending = panel.evaluate(async ({ elementId, contextVersion }) => {
    await voiceSession.handleToolCalls([{ id: 'save-demo', name: 'click_element', args: { elementId, contextVersion, targetLabel: 'Enregistrer', explicitRequest: true } }], { taskRevision: voiceSession.taskRevision });
  }, { elementId, contextVersion: context.contextVersion });
  await expect(panel.locator('.action-card')).toContainText('Enregistrer');
  expect(await web.evaluate(() => window.saves)).toBe(0);
  const revision = await panel.evaluate(() => voiceSession.taskRevision);
  await panel.evaluate(() => {
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Pourquoi tu me demandes de cliquer ?', start_ms: 500, end_ms: 600 });
    voiceSession.flushTranscript('user', false);
    voiceSession.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'approval-clarification' } });
  });
  await expect(panel.locator('.action-card')).toContainText('Enregistrer');
  expect(await panel.evaluate(() => voiceSession.taskRevision)).toBe(revision);
  expect(await web.evaluate(() => window.saves)).toBe(0);
  await panel.evaluate(() => {
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Oui, tu peux l’enregistrer', start_ms: 5000, end_ms: 5200 });
    voiceSession.flushTranscript('user', false);
  });
  await pending;
  await expect(panel.locator('.action-card')).toHaveCount(0);
  expect(await web.evaluate(() => window.saves)).toBe(1);
  await expect(web.locator('#saved')).toHaveText('Rendez-vous enregistré');
  await panel.evaluate(async () => {
    await voiceSession.handleToolCalls([{ id: 'verify-demo', name: 'verify_expected_result', args: { conditions: [{ kind: 'text_present', text: 'Rendez-vous enregistré' }] } }]);
  });
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'verify-demo' && JSON.parse(event.item.output).verification?.status === 'confirmed'))).toBe(true);
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

test('full access fills the form in one batch and validates it without a confirmation card', async ({ mediaContext, mediaExtensionId }) => {
  const { panel, web } = await setup(mediaContext, mediaExtensionId);
  await web.evaluate(() => {
    window.saves = 0;
    document.body.innerHTML = '<main><h1>Calendrier</h1><div role="dialog"><h2>Nouvel événement</h2><label for="title">Titre</label><input id="title"><label for="start">Début</label><input id="start" type="time"><label for="end">Fin</label><input id="end" type="time"><button id="save" type="button">Valider</button></div><p id="saved"></p></main>';
    document.querySelector('#save').onclick = () => {
      if (document.querySelector('#title').value !== 'Sport' || document.querySelector('#start').value !== '15:00' || document.querySelector('#end').value !== '16:00') return;
      window.saves++; document.querySelector('[role="dialog"]').remove(); document.querySelector('#saved').textContent = 'Rendez-vous enregistré';
    };
  });
  await web.bringToFront();
  await panel.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SET_AUTONOMY_MODE', mode: 'full' });
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Tu peux me créer un événement sport demain de quinze à seize heures', start_ms: 0, end_ms: 100 });
    voiceSession.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'form-task' } });
    await voiceSession.taskUpdate;
  });
  const context = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' }));
  const fields = [];
  for (const [id, targetLabel, text] of [['title', 'Titre', 'Sport'], ['start', 'Début', '15:00'], ['end', 'Fin', '16:00']]) {
    fields.push({ elementId: Number(await web.locator('#' + id).getAttribute('data-lid')), targetLabel, text });
  }
  const startedAt = Date.now();
  await panel.evaluate(({ fields, contextVersion }) => voiceSession.handleLiveEvent({ type: 'response.event', delegation_id: 'form-task', event: {
    type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fill-form', name: 'fill_fields', arguments: JSON.stringify({ fields, contextVersion }) }
  } }), { fields, contextVersion: context.contextVersion });
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'fill-form'))).toBe(true);
  const filled = await panel.evaluate(() => JSON.parse(window.__sent.find(event => event.item?.call_id === 'fill-form').item.output));
  expect(filled).toMatchObject({ status: 'ok', completedFields: 3 });
  const saveId = Number(await web.locator('#save').getAttribute('data-lid'));
  await panel.evaluate(({ elementId, contextVersion }) => voiceSession.handleLiveEvent({ type: 'response.event', delegation_id: 'form-task', event: {
    type: 'response.output_item.done', item: { type: 'function_call', call_id: 'save-form', name: 'click_element', arguments: JSON.stringify({ elementId, contextVersion, targetLabel: 'Valider', explicitRequest: true }) }
  } }), { elementId: saveId, contextVersion: filled.contextVersion });
  await expect(web.locator('#saved')).toHaveText('Rendez-vous enregistré');
  await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'save-form'))).toBe(true);
  await expect(panel.locator('.action-card')).toHaveCount(0);
  expect(await web.evaluate(() => window.saves)).toBe(1);
  console.log('FULL_ACCESS_FORM_EVIDENCE', JSON.stringify({ elapsedMs: Date.now() - startedAt, fields: 3, saves: 1 }));
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

test('voice clicks native time editors and visible popup controls without false blocking', async ({ mediaContext, mediaExtensionId }) => {
  const { panel, web } = await setup(mediaContext, mediaExtensionId);
  await web.evaluate(() => {
    document.body.innerHTML = '<aside class="popup-help" style="width:200px;height:160px"><button>Aide</button></aside><main><label for="start">Heure de début</label><input id="start"><button id="choose">Choisir un horaire</button><section role="dialog" id="picker" hidden><button id="slot">15:00</button></section></main>';
    document.querySelector('#choose').onclick = () => { document.querySelector('#picker').hidden = false; };
    document.querySelector('#slot').onclick = () => {
      document.querySelector('#start').value = '15:00'; document.querySelector('#picker').hidden = true;
    };
  });
  await web.bringToFront();
  await panel.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SET_AUTONOMY_MODE', mode: 'full' });
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Clique sur Heure de début puis choisis quinze heures', start_ms: 0, end_ms: 100 });
    voiceSession.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'time-task' } });
    await voiceSession.taskUpdate;
  });
  let result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' }));
  for (const [id, targetLabel] of [['start', 'Heure de début'], ['choose', 'Choisir un horaire'], ['slot', '15:00']]) {
    const elementId = Number(await web.locator('#' + id).getAttribute('data-lid'));
    await panel.evaluate(({ elementId, contextVersion, targetLabel, id }) => voiceSession.handleLiveEvent({
      type: 'response.event', delegation_id: 'time-task', event: {
        type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name: 'click_element',
          arguments: JSON.stringify({ elementId, contextVersion, targetLabel, explicitRequest: true }) }
      }
    }), { elementId, contextVersion: result.contextVersion, targetLabel, id });
    await expect.poll(() => panel.evaluate(id => window.__sent.some(event => event.item?.call_id === id), id)).toBe(true);
    result = await panel.evaluate(id => JSON.parse(window.__sent.find(event => event.item?.call_id === id).item.output), id);
    expect(result.status).toBe('ok');
    if (id === 'start') expect(await web.locator('#start').evaluate(field => document.activeElement === field)).toBe(true);
  }
  await expect(web.locator('#start')).toHaveValue('15:00');
  await expect(panel.locator('.action-card')).toHaveCount(0);
  await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
});

for (const method of ['escape', 'outside_pointer']) {
  test(`voice closes a blocking date picker with ${method} then resumes Save without user assistance`, async ({ mediaContext, mediaExtensionId }) => {
    const { panel, web } = await setup(mediaContext, mediaExtensionId);
    await web.evaluate(method => {
      document.body.innerHTML = '<section role="dialog" id="editor" style="position:relative;width:600px;height:500px"><h2>Nouvel événement</h2><input aria-label="Titre" value="Sport"><button id="save">Enregistrer</button><div role="dialog" id="picker" style="position:absolute;left:150px;top:100px;width:250px;height:200px;z-index:30;background:white"><div role="grid"><button>21</button></div></div><p id="saved"></p></section>';
      const popup = document.querySelector('#picker');
      if (method === 'escape') popup.addEventListener('keydown', event => { if (event.key === 'Escape') popup.remove(); });
      else document.querySelector('#editor').addEventListener('mousedown', event => { if (!popup.contains(event.target)) popup.remove(); });
      document.querySelector('#save').onclick = () => { document.querySelector('#saved').textContent = 'Événement enregistré'; };
    }, method);
    await web.bringToFront();
    await panel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'SET_AUTONOMY_MODE', mode: 'full' });
      voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Crée mon rendez-vous Sport et enregistre-le', start_ms: 0, end_ms: 100 });
      voiceSession.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'picker-task' } });
      await voiceSession.taskUpdate;
    });
    const before = await panel.evaluate(() => chrome.runtime.sendMessage({ type:'VOICE_CONTEXT_REQUEST' }));
    expect(before.pageContext).not.toContain('Enregistrer');
    await panel.evaluate(contextVersion => voiceSession.handleLiveEvent({ type:'response.event', delegation_id:'picker-task', event: {
      type:'response.output_item.done', item: { type:'function_call', call_id:'dismiss-date', name:'dismiss_popup', arguments:JSON.stringify({contextVersion}) }
    }}), before.contextVersion);
    await expect.poll(() => panel.evaluate(() => window.__sent.some(event => event.item?.call_id === 'dismiss-date'))).toBe(true);
    const result = await panel.evaluate(() => JSON.parse(window.__sent.find(event => event.item?.call_id === 'dismiss-date').item.output));
    expect(result).toMatchObject({ status:'ok', dismissed:true });
    expect(result.pageContext).toContain('Enregistrer');
    await expect(web.locator('input')).toHaveValue('Sport');
    await expect(web.locator('#saved')).toBeEmpty();
    const elementId = Number(await web.locator('#save').getAttribute('data-lid'));
    await panel.evaluate(({elementId,contextVersion}) => voiceSession.handleLiveEvent({type:'response.event',delegation_id:'picker-task',event:{
      type:'response.output_item.done',item:{type:'function_call',call_id:'save-after-picker',name:'click_element',arguments:JSON.stringify({elementId,contextVersion,targetLabel:'Enregistrer',explicitRequest:true})}
    }}), {elementId,contextVersion:result.contextVersion});
    await expect(web.locator('#saved')).toHaveText('Événement enregistré');
    await expect(panel.locator('.action-card')).toHaveCount(0);
    await panel.evaluate(() => { stopVoiceSession(); window.__remote.close(); });
  });
}
