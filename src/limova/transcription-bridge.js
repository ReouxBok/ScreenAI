import { LIMOVA_API_URL } from './environment.js';
import { liveUuid } from './live-browser-contract.js';

export const TRANSCRIPTION_PORT = 'limova-app-transcription-v1';

export function attachTranscriptionBridge(runtime, io) {
  runtime.onConnect.addListener(port => {
    if (port.name !== TRANSCRIPTION_PORT || port.sender?.id !== runtime.id) return;
    let socket, request, ready, timeout, ackTimeout, pendingAck, sequence = 0, audioSequence = 0;
    let closed = false, connectedOnce = false, bytes = 0, windowStart = Date.now();
    const queue = [];
    const close = (failed = false) => {
      if (closed) return;
      closed = true; clearTimeout(timeout); clearTimeout(ackTimeout); queue.length = 0;
      if (socket?.connected) socket.emit('stop_session');
      socket?.removeAllListeners(); socket?.disconnect();
      if (failed) { try { port.postMessage({ kind: 'error', code: 'TRANSCRIPTION_CLOSED' }); } catch {} }
      port.disconnect();
    };
    const flush = () => {
      if (closed || pendingAck || !queue.length) return;
      const frame = queue.shift(); pendingAck = { sequence: ++sequence, terminal: frame.event === 'session_ended' };
      try { port.postMessage({ kind: 'event', sequence, ...frame }); } catch { close(true); return; }
      ackTimeout = setTimeout(() => close(true), 5000);
    };
    const forward = (event, payload) => {
      if (closed) return;
      try {
        if (event === 'session_started') {
          if (ready || !payload || payload.clientSurface !== 'chrome_extension'
            || payload.userId !== request.userId || payload.workspaceId !== request.workspaceId
            || !liveUuid(payload.sessionId) || payload.inputSampleRate !== 16000
            || !Number.isInteger(payload.maxAudioFrameBytes) || payload.maxAudioFrameBytes < 2
            || payload.maxAudioFrameBytes > 2560 || payload.maxAudioFrameBytes % 2) throw new Error();
          ready = payload; clearTimeout(timeout);
        } else if (!ready) throw new Error();
        if (event === 'partial_transcript' || event === 'final_transcript') {
          if (typeof payload?.text !== 'string' || !payload.text.length || payload.text.length > 32000) throw new Error();
          payload = { text: payload.text, sessionId: ready.sessionId };
        }
        if (queue.length >= 8) throw new Error();
        queue.push({ event, payload: payload ?? { sessionId: ready.sessionId } }); flush();
      } catch { close(true); }
    };
    port.onDisconnect.addListener(() => close());
    port.onMessage.addListener(message => {
      if (closed) return;
      try {
        if (message?.kind === 'ack') {
          if (!pendingAck || message.sequence !== pendingAck.sequence) throw new Error();
          const terminal = pendingAck.terminal; pendingAck = null; clearTimeout(ackTimeout);
          if (terminal) close(); else flush();
          return;
        }
        if (message?.kind === 'start') {
          if (socket || !liveUuid(message.userId) || !liveUuid(message.workspaceId)
            || typeof message.languageCode !== 'string' || message.languageCode.length < 2 || message.languageCode.length > 16) throw new Error();
          request = { ...message };
          socket = io(`${LIMOVA_API_URL}/voice/transcribe`, { withCredentials: true, auth: { workspaceId: message.workspaceId },
            transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false });
          socket.on('connect', () => {
            if (connectedOnce) { close(true); return; }
            connectedOnce = true;
            socket.emit('start_session', { language: request.languageCode, clientSurface: 'chrome_extension', expectedUserId: request.userId });
          });
          ['session_started', 'partial_transcript', 'final_transcript', 'session_ended'].forEach(event => socket.on(event, payload => forward(event, payload)));
          ['error', 'connect_error', 'disconnect'].forEach(event => socket.on(event, () => close(true)));
          timeout = setTimeout(() => close(true), 20000); socket.connect(); return;
        }
        if (message?.kind !== 'audio' || !ready || !socket?.connected || message.sequence !== audioSequence
          || !Array.isArray(message.bytes) || !message.bytes.length || message.bytes.length % 2
          || message.bytes.length > ready.maxAudioFrameBytes
          || !message.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
        if (Date.now() - windowStart >= 1000) { bytes = 0; windowStart = Date.now(); }
        bytes += message.bytes.length;
        if (bytes > 64000 || socket.sendBuffer.length || socket.io.engine.writeBuffer.length > 8) throw new Error();
        socket.emit('audio_chunk', { sessionId: ready.sessionId, sequence: audioSequence++, audio: btoa(String.fromCharCode(...message.bytes)) });
      } catch { close(true); }
    });
  });
}
