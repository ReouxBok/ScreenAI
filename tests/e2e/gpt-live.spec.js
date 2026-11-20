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

test('stopping GPT during microphone acquisition never revives its connection', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId, { deferMicrophone: true });
  await panel.evaluate(() => { stopVoiceSession(); window.__releaseMicrophone(); });
  await panel.waitForFunction(() => window.__lateMicrophone.getTracks().every(track => track.readyState === 'ended'));
  expect(await panel.evaluate(() => Boolean(voiceSession?.active))).toBe(false);
  expect(await panel.evaluate(() => window.__remote)).toBeUndefined();
});


test('autonomy labels match the requested wording and the level survives reopening', async ({ mediaContext, mediaExtensionId }) => {
  const { panel } = await setup(mediaContext, mediaExtensionId);
  await panel.evaluate(() => stopVoiceSession());
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.locator('#menuBtn').click();
  await expect(panel.locator('.autonomy-picker')).toContainText('Demander une approbation');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande avant modifications et commandes');
  await expect(panel.locator('.autonomy-picker')).toContainText('Approuver pour moi');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande seulement si c’est risqué');
  await expect(panel.locator('.autonomy-picker')).toContainText('Accès complet');
  await expect(panel.locator('.autonomy-picker')).toContainText('Demande rarement avant d’agir');
  await expect(panel.locator('input[name="autonomyMode"][value="balanced"]')).toBeChecked();
  await panel.locator('input[name="autonomyMode"][value="ask"]').check();
  await expect(panel.locator('#autonomyStatus')).toContainText('mémorisé');
  await panel.reload();
  await panel.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
  await expect(panel.locator('input[name="autonomyMode"][value="ask"]')).toBeChecked();
  await panel.locator('#menuBtn').click();
  await expect(panel.locator('#headerMenu')).toBeVisible();
  expect(await panel.locator('#headerMenu').evaluate(menu => menu.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
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
  await panel.evaluate(() => {
    voiceSession.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Oui, enregistre', start_ms: 5000, end_ms: 5200 });
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
