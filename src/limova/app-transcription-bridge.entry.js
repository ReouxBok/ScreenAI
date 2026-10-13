import { io } from 'socket.io-client';
import { LIMOVA_APP_URL } from './environment.js';
import { attachTranscriptionBridge } from './transcription-bridge.js';

if (location.origin === LIMOVA_APP_URL && !globalThis.__limovaTranscriptionBridgeV1) {
  globalThis.__limovaTranscriptionBridgeV1 = true;
  attachTranscriptionBridge(chrome.runtime, io);
}
