import { afterEach, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';
afterEach(()=>{uninstallFullChromeMock();delete globalThis.fetch;vi.restoreAllMocks();});
it('a voice transcript awaiting consent must not cross reset', async()=>{
 const chrome=installFullChromeMock();
 await chrome.storage.local.set({limova_ai_processing_consent_v1:true,limova_session:{remoteSessionId:null,conversationHistory:[]},charly_auth_session_v1:{token:'test-token',expiresAt:Date.now()+60000}});
 globalThis.fetch=vi.fn(async url=>({ok:true,status:200,json:async()=>String(url).endsWith('/sessions')?{sessionId:'550e8400-e29b-41d4-a716-446655440001'}:{}}));
 vi.resetModules();const bg=await import('../../../src/background.js');await new Promise(r=>setTimeout(r,0));
 const original=chrome.storage.local.get.getMockImplementation();let release;
 chrome.storage.local.get.mockImplementation(key=>key==='limova_ai_processing_consent_v1'&&!release?new Promise(r=>{release=r}):original(key));
 const sender={id:chrome.runtime.id,url:chrome.runtime.getURL('src/sidebar/sidebar.html')};
 const pending=bg.handleMessage({type:'VOICE_TRANSCRIPT',role:'user',text:'OLD VOICE SUBJECT'},sender);
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 await bg.handleResetSession();release({limova_ai_processing_consent_v1:true});await pending;
 const state=await bg.handleMessage({type:'GET_STATE'},sender);
 console.log('LATE_VOICE_HISTORY',JSON.stringify(state.conversationHistory));
 expect(state.conversationHistory).toEqual([]);
});
