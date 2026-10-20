// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installChromeMock,uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';
afterEach(()=>{uninstallChromeMock();vi.restoreAllMocks();});
it('stop/reset cancels remaining tools in an in-flight Live batch',async()=>{
 const chrome=installChromeMock();let release;const sent=[];
 chrome.runtime.sendMessage.mockImplementation(msg=>{sent.push(msg);if(msg.type==='VOICE_KB_SEARCH')return new Promise(r=>{release=r});return Promise.resolve({ok:false});});
 loadSidebarScript('src/sidebar/voice.js');const voice=new window.LimovaVoiceSession();
 globalThis.WebSocket={OPEN:1};voice.ready=true;
 const pending=voice.handleToolCalls([{id:'1',name:'search_knowledge_base',args:{query:'OLD'}},{id:'2',name:'scroll_page',args:{direction:'down'}}]);
 expect(release).toBeTypeOf('function');voice.stop(false);release({ok:true,knowledge:'OLD'});await pending;
 console.log('POST_STOP_TOOLS',JSON.stringify(sent.filter(x=>x.type==='VOICE_SCROLL_REQUEST')));
 expect(sent.some(x=>x.type==='VOICE_SCROLL_REQUEST')).toBe(false);
});
