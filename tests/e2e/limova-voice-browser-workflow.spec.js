import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { test, expect, APP, USER, WORKSPACE, CONVERSATION } from './native-chat-fixture.js';

test.use({ nativeViewport: true, nativeMicrophone: true });
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('native voice captures masked pixels, scrolls, fills, rejects a missing target and navigates in one conversation', async ({ nativeChat }) => {
  const { app, panel, context, worker, server, history, state, calls, legacy, errors } = nativeChat;
  const sessionId = randomUUID(), voiceTurn = randomUUID(), browserTurn = randomUUID();
  const seen = { starts: [], results: [], pcm: 0, disconnected: 0 };
  let page, index = 0, initiated = false, lastRead;
  const steps = [
    { operation: 'read_page' }, { operation: 'screenshot' }, { operation: 'scroll', direction: 'down' },
    { operation: 'read_page' },
    () => ({ operation: 'type_text', elementId: lastRead.elements.find(item => item.label === 'Brief')?.elementId, text: 'Brief préparé vocalement' }),
    { operation: 'read_page' }, { operation: 'click', elementId: 999999 }, { operation: 'read_page' },
    () => ({ operation: 'click', elementId: lastRead.elements.find(item => item.label === 'Ouvrir mon profil')?.elementId }),
    { operation: 'read_page' },
  ];
  const io = new Server(server, { cors: { origin: APP, credentials: true }, transports: ['websocket'] });
  io.of('/conversation/live').on('connection', socket => {
    const next = () => {
      if (index === steps.length) {
        history.push({ id: USER, role: 'user', content: 'Prépare le brief et ouvre mon profil.' },
          { id: WORKSPACE, role: 'assistant', content: 'Le brief est préparé et le profil est ouvert.' });
        socket.emit('turn.deep_agent_stream.delta', { sessionId, turnId: voiceTurn,
          chunk: Buffer.from(frame('values', { messages: history }) + frame('custom', { type: 'extension.turn_state', turnId: browserTurn, state: 'completed' })) });
        socket.emit('turn.deep_agent_stream.completed', { sessionId, turnId: voiceTurn });
        socket.emit('assistant.transcript.final', { sessionId, turnId: voiceTurn, text: history.at(-1).content });
        return;
      }
      const step = steps[index++];
      const input = typeof step === 'function' ? step() : step;
      socket.emit('turn.deep_agent_stream.delta', { sessionId, turnId: voiceTurn,
        chunk: Buffer.from(frame('custom', { type: 'extension.action_requested', protocolVersion: 1, turnId: browserTurn,
          actionId: `${browserTurn}:${index}`, toolCallId: `voice-tool-${index}`, target: page, input,
          expiresAt: new Date(Date.now() + 60000).toISOString() })
          + frame('custom', { type: 'extension.turn_state', turnId: browserTurn, state: 'waiting' })) });
    };
    socket.on('session.start', payload => {
      seen.starts.push({ payload, cookie: socket.handshake.headers.cookie?.includes('native_chat=authenticated'),
        origin: socket.handshake.headers.origin, workspaceId: socket.handshake.auth.workspaceId });
      page = payload.browserContext;
      socket.emit('session.ready', { sessionId, conversationId: CONVERSATION, userId: USER, workspaceId: WORKSPACE,
        clientSurface: 'chrome_extension', inputSampleRate: 16000, outputSampleRate: 24000, maxAudioFrameBytes: 2560 });
    });
    socket.on('audio.append', () => {
      seen.pcm++;
      if (initiated) return; initiated = true;
      socket.emit('input.transcript.final', { sessionId, turnId: voiceTurn, text: 'Prépare le brief et ouvre mon profil.' });
      socket.emit('turn.deep_agent_stream.started', { sessionId, turnId: voiceTurn }); next();
    });
    socket.on('turn.browser_continue', payload => {
      seen.results.push(payload); page = payload.browserContext;
      try {
        const observation = JSON.parse(payload.browserResult.observation);
        if (observation.elements) lastRead = observation;
      } catch {}
      next();
    });
    socket.on('disconnect', () => { seen.disconnected++; });
  });
  try {
    await app.evaluate(() => {
      document.body.style.cssText = 'margin:0;background:white';
      document.querySelector('main').style.height = '2000px';
      const marker = document.createElement('div'); marker.style.cssText = 'position:fixed;left:20px;top:20px;width:30px;height:30px;background:blue';
      document.body.append(marker);
      document.querySelector('input').style.cssText = 'position:fixed;left:80px;top:20px;width:80px;height:30px;background:red';
      document.querySelector('textarea').style.cssText = 'position:fixed;left:80px;top:80px;width:160px;height:40px;background:red';
      const link = document.createElement('a'); link.href = '/profil'; link.textContent = 'Ouvrir mon profil';
      link.style.cssText = 'position:fixed;left:80px;top:160px;width:180px;height:30px';
      link.onclick = () => sessionStorage.setItem('voiceNavigation', JSON.stringify({
        value: document.querySelector('textarea').value, inputs: window.inputEvents, unrelatedClicks: window.clicks,
        pointer: Boolean(document.querySelector('[data-limova-native-pointer]')), scrollY,
      }));
      document.querySelector('main').append(link);
    });
    await panel.evaluate(() => document.getElementById('limovaNew').click());
    await expect(panel.locator('#limovaConversation')).toHaveValue(CONVERSATION);
    await app.bringToFront();
    const cdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    await cdp.send('Extensions.triggerAction', { id: new URL(worker.url()).host, targetId: targetInfos.find(target => target.url === app.url()).targetId });
    let size, changedAt = Date.now();
    await expect.poll(async () => {
      const nextSize = await app.evaluate(() => `${innerWidth}x${innerHeight}`);
      if (nextSize !== size) { size = nextSize; changedAt = Date.now(); }
      return Date.now() - changedAt;
    }).toBeGreaterThan(300);
    const viewport = await app.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await panel.evaluate(() => { document.getElementById('limovaBrowser').checked = true; document.getElementById('voiceBtn').click(); });
    await expect(panel.locator('.message.assistant .message-content')).toHaveText('Le brief est préparé et le profil est ouvert.', { timeout: 15000 }).catch(error => {
      throw new Error(`${error.message}\nVoice state: ${JSON.stringify({ starts: seen.starts.length, pcm: seen.pcm, disconnected: seen.disconnected, results: seen.results.map(item => item.browserResult.status), actions: index, errors })}`);
    });
    await expect(app).toHaveURL(`${APP}/profil`);
    expect((await worker.evaluate(async origin => chrome.tabs.query({ url: `${origin}/*` }), APP))).toHaveLength(2);
    expect(seen.starts).toHaveLength(1);
    expect(seen.starts[0]).toMatchObject({ cookie: true, origin: APP, workspaceId: WORKSPACE,
      payload: { conversationId: CONVERSATION, expectedUserId: USER, clientSurface: 'chrome_extension' } });
    expect(seen.pcm).toBeGreaterThan(0);
    expect(seen.results.map(item => item.browserResult.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'rejected', 'completed', 'completed', 'completed']);
    expect(new Set(seen.results.map(item => item.browserResult.turnId)).size).toBe(1);
    expect(new Set(seen.results.map(item => item.browserResult.actionId)).size).toBe(10);
    expect(JSON.parse(seen.results.at(-1).browserResult.observation).url).toBe(`${APP}/profil`);
    const navigation = await app.evaluate(() => JSON.parse(sessionStorage.getItem('voiceNavigation')));
    expect(navigation).toMatchObject({ value: 'Brief préparé vocalement', inputs: 1, unrelatedClicks: 0, pointer: true });
    expect(navigation.scrollY).toBeGreaterThan(0);
    expect(state.uploads).toHaveLength(1);
    expect(seen.results[1].browserResult.imageFileId).toBe('77777777-7777-4777-8777-777777777777');
    const pixels = await panel.evaluate(async ({ data, viewport }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0);
      const pixel = (x, y) => [...drawing.getImageData(Math.floor(x * bitmap.width / viewport.width), Math.floor(y * bitmap.height / viewport.height), 1, 1).data];
      const result = { public: pixel(30, 30), password: pixel(100, 30), field: pixel(100, 100) }; bitmap.close(); return result;
    }, { data: state.uploads[0].data, viewport });
    expect(pixels).toEqual({ public: [0, 0, 255, 255], password: [229, 231, 235, 255], field: [229, 231, 235, 255] });
    expect(JSON.stringify(seen.results)).not.toMatch(/PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET|must-not-leak|Brief préparé vocalement/);
    expect(calls.filter(call => call.path.startsWith('/message/'))).toEqual([]);
    await expect(panel.locator('.action-card, .screenshot-bubble, .message.error')).toHaveCount(0);
    await panel.evaluate(() => document.getElementById('voiceBtn').click());
    await expect.poll(() => seen.disconnected).toBe(1);
    await expect.poll(() => worker.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/*` })).length, APP)).toBe(1);
    await panel.reload();
    await expect(panel.locator('.message.assistant .message-content')).toHaveText('Le brief est préparé et le profil est ouvert.');
    expect(seen.starts).toHaveLength(1); expect(legacy).toEqual([]); expect(errors).toEqual([]);
    await cdp.detach();
  } finally { io.disconnectSockets(true); server.closeAllConnections(); await new Promise(resolve => io.close(resolve)); }
});
