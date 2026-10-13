import { io } from 'socket.io-client';
import { LIMOVA_APP_URL } from './environment.js';
import { attachLimovaLiveBridge } from './live-bridge.js';

if (location.origin === LIMOVA_APP_URL && !globalThis.__limovaLiveBridgeV1) {
  globalThis.__limovaLiveBridgeV1 = true;
  attachLimovaLiveBridge(chrome.runtime, io);
}
