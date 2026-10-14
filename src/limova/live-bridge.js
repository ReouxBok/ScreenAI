import { evaluationGrant } from './evaluation-grant.js';
import { liveBrowserBinding, liveBrowserContinuation, liveBrowserContextReply, liveUuid } from './live-browser-contract.js';
import { LIMOVA_API_URL } from './environment.js';

export const LIVE_PORT = 'limova-app-live-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const events = [
  'turn.browser_context_requested', 'session.ready', 'input.transcript.delta', 'input.transcript.final',
  'assistant.transcript.delta', 'assistant.transcript.final', 'assistant.audio.delta',
  'assistant.status', 'turn.interrupted', 'turn.deep_agent_stream.started',
  'turn.deep_agent_stream.delta', 'turn.deep_agent_stream.completed',
  'turn.deep_agent_stream.interrupted', 'turn.deep_agent_stream.failed',
  'turn.generated_files', 'usage.updated', 'error', 'session.ended',
];
const binaryFields = { 'assistant.audio.delta': 'audio', 'turn.deep_agent_stream.delta': 'chunk' };

export function attachLimovaLiveBridge(runtime, io) {
  runtime.onConnect.addListener(port => {
    if (port.name !== LIVE_PORT || port.sender?.id !== runtime.id) return;
    let socket, request, ready, timer, ackTimer, browserBinding, voiceTurnId, contextRequest;
    let browserCommands = 0;
    let closed = false;
    let started = false;
    let connectedOnce = false;
    let sequence = 0;
    let audioSequence = 0;
    let pendingAck = null;
    let terminalAck = false;
    let queuedBytes = 0;
    let windowStart = Date.now();
    let windowBytes = 0;
    const queue = [];
    const close = (failed = false) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer); clearTimeout(ackTimer);
      queue.length = 0; queuedBytes = 0;
      if (socket?.connected) socket.emit('session.stop');
      socket?.removeAllListeners(); socket?.disconnect();
      if (failed) { try { port.postMessage({ kind: 'error', code: 'LIMOVA_LIVE_TRANSPORT_CLOSED' }); } catch { /* Port already closed. */ } }
      port.disconnect();
    };
    const flush = () => {
      if (closed || pendingAck || !queue.length) return;
      const frame = queue.shift();
      queuedBytes -= frame.size;
      pendingAck = ++sequence;
      terminalAck = ['error', 'session.ended'].includes(frame.event);
      try { port.postMessage({ kind: 'event', sequence, event: frame.event, payload: frame.payload }); }
      catch { close(true); return; }
      ackTimer = setTimeout(() => close(true), 5_000);
    };
    const forward = (event, value) => {
      if (closed) return;
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        if (event === 'session.ready') {
          if (ready || value.clientSurface !== 'chrome_extension'
            || value.userId !== request.userId || value.workspaceId !== request.workspaceId
            || value.conversationId !== request.conversationId || !uuid.test(value.sessionId)
            || ![16_000, 24_000, 48_000].includes(value.inputSampleRate)
            || ![16_000, 24_000, 48_000].includes(value.outputSampleRate)
            || !Number.isInteger(value.maxAudioFrameBytes) || value.maxAudioFrameBytes < 2
            || value.maxAudioFrameBytes > 8_192 || value.maxAudioFrameBytes % 2) throw new Error();
          ready = value;
          clearTimeout(timer);
        } else if (event !== 'error' && (!ready || value.sessionId !== ready.sessionId)) throw new Error();
        if (event === 'turn.browser_context_requested') {
          if (!browserBinding.browserSession || voiceTurnId || contextRequest
            || !liveUuid(value.turnId) || !liveUuid(value.requestId)) throw new Error();
          contextRequest = { turnId: value.turnId, requestId: value.requestId };
        }
        if (event === 'turn.deep_agent_stream.started') {
          if (!liveUuid(value.turnId) || voiceTurnId) throw new Error();
          voiceTurnId = value.turnId; browserCommands = 0;
        }
        if (['turn.deep_agent_stream.completed', 'turn.deep_agent_stream.interrupted', 'turn.deep_agent_stream.failed', 'turn.interrupted'].includes(event)) {
          if (value.turnId === voiceTurnId) voiceTurnId = undefined;
          if (value.turnId === contextRequest?.turnId) contextRequest = undefined;
        }
        const payload = { ...value };
        const binary = binaryFields[event];
        if (binary) {
          const bytes = value[binary] instanceof ArrayBuffer ? new Uint8Array(value[binary]) : value[binary];
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65_536) throw new Error();
          payload[binary] = Array.from(bytes);
        }
        const size = JSON.stringify(payload).length;
        if (size > 400_000 || queuedBytes + size > 800_000 || queue.length >= 32) throw new Error();
        queue.push({ event, payload, size }); queuedBytes += size;
        flush();
      } catch { close(true); }
    };
    port.onDisconnect.addListener(() => close());
    port.onMessage.addListener(message => {
      if (closed) return;
      try {
        if (message?.kind === 'stop') { close(); return; }
        if (message?.kind === 'ack') {
          if (!pendingAck || message.sequence !== pendingAck) throw new Error();
          clearTimeout(ackTimer); pendingAck = null;
          if (terminalAck) close(); else flush();
          return;
        }
        if (message?.kind === 'start' && !started) {
          started = true;
          request = message;
          if (![request.userId, request.workspaceId, request.conversationId].every(value => typeof value === 'string' && uuid.test(value))
            || typeof request.languageCode !== 'string' || request.languageCode.length > 32
            || typeof request.userTimezone !== 'string' || request.userTimezone.length > 100) throw new Error();
          evaluationGrant(request.evaluationCode);
          browserBinding = liveBrowserBinding(request.browserSession, request.browserContext);
          socket = io(`${LIMOVA_API_URL}/conversation/live`, {
            withCredentials: true, transports: ['websocket'], auth: { workspaceId: request.workspaceId },
            reconnection: false, forceNew: true, autoConnect: false, timeout: 10_000,
          });
          socket.on('connect', () => {
            if (closed) return;
            if (connectedOnce) { close(true); return; }
            connectedOnce = true;
            socket.emit('session.start', {
              conversationId: request.conversationId, languageCode: request.languageCode,
              userTimezone: request.userTimezone, clientSurface: 'chrome_extension', expectedUserId: request.userId,
              ...browserBinding,
              ...(request.evaluationCode !== undefined ? { evaluationCode: request.evaluationCode } : {}),
            });
          });
          socket.on('disconnect', () => close(true));
          socket.on('connect_error', () => close(true));
          events.forEach(event => socket.on(event, payload => forward(event, payload)));
          timer = setTimeout(() => close(true), 15_000);
          socket.connect(); return;
        }
        if (!ready || !socket?.connected) throw new Error();
        if (message?.kind === 'audio') {
          const bytes = message.bytes;
          if (message.sequence !== audioSequence || !Array.isArray(bytes) || !bytes.length || bytes.length % 2
            || bytes.length > ready.maxAudioFrameBytes || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
          if (Date.now() - windowStart >= 1_000) { windowStart = Date.now(); windowBytes = 0; }
          windowBytes += bytes.length;
          if (windowBytes > 64_000) throw new Error();
          if (socket.sendBuffer.length || socket.io.engine.writeBuffer.length > 8) throw new Error();
          socket.emit('audio.append', { audio: Uint8Array.from(bytes), sequence: audioSequence++ });
        } else if (message?.kind === 'browser_context') {
          const reply = liveBrowserContextReply(message.payload);
          if (!browserBinding.browserSession || !contextRequest || reply.turnId !== contextRequest.turnId
            || reply.requestId !== contextRequest.requestId || socket.sendBuffer.length
            || socket.io.engine.writeBuffer.length > 8) throw new Error();
          contextRequest = undefined;
          socket.emit('turn.browser_context', { sessionId: ready.sessionId, ...reply });
        } else if (message?.kind === 'browser_continue') {
          const continuation = liveBrowserContinuation(message.payload);
          if (!browserBinding.browserSession || continuation.turnId !== voiceTurnId || ++browserCommands > 100
            || socket.sendBuffer.length || socket.io.engine.writeBuffer.length > 8) throw new Error();
          socket.emit('turn.browser_continue', { sessionId: ready.sessionId, ...continuation });
        } else if (message?.kind === 'cancel' && Number.isFinite(message.playedAudioMs)
          && message.playedAudioMs >= 0 && message.playedAudioMs <= 30 * 60 * 1_000) {
          voiceTurnId = undefined; contextRequest = undefined;
          socket.emit('response.cancel', { playedAudioMs: message.playedAudioMs });
        } else throw new Error();
      } catch { close(true); }
    });
  });
}
