import { test, expect } from './fixtures.js';

async function setup(context,id,{deferMicrophone=false}={}) {
  await context.route(/^https?:/, route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({available:true,enabled:true,recentMessages:[],goals:[],memories:[],greeting:null})}));
  let [sw]=context.serviceWorkers();
  if(!sw) sw=await context.waitForEvent('serviceworker');
  await sw.evaluate(async()=>chrome.storage.local.set({charly_auth_session_v1:{token:'e2e-'+ 'x'.repeat(48),expiresAt:Date.now()+3600000},sidebarLang:'fr'}));
  const page=await context.newPage();
  await page.goto(`chrome-extension://${id}/src/sidebar/sidebar.html`);
  await page.waitForFunction(()=>document.documentElement.dataset.sidebarReady==='true');
  await page.evaluate(async(deferMicrophone)=>{
    await setLang('fr');
    window.__sent=[];
    if(deferMicrophone){
      const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async args=>{
        const stream=await original(args);
        window.__lateMicrophone = stream;
        return new Promise(resolve=>{window.__releaseMicrophone=()=>resolve(stream);});
      };
    }
    class Socket extends EventTarget {
      static OPEN=1;
      constructor(){super();this.readyState=1;setTimeout(()=>this.dispatchEvent(new Event('open')),0);}
      send(raw){const data=JSON.parse(raw);window.__sent.push(data);if(data.setup)setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({setupComplete:{}})})),0);}
      close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
    }
    window.WebSocket=Socket;
    const realSendMessage=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=async msg=>{
      if(msg.type==='GET_PRIVACY_STATE')return {aiProcessing:true};
      if(msg.type==='GET_LIVE_TOKEN')return {ok:true,token:'synthetic-only',model:'test-model'};
      return realSendMessage(msg);
    };
    const RealVoice=window.LimovaVoiceSession;
    window.LimovaVoiceSession=class extends RealVoice {constructor(...args){super(...args);window.__voice=this;}};
  },deferMicrophone);
  await page.locator('#voiceBtn').click();
  if(deferMicrophone) await page.waitForFunction(()=>typeof window.__releaseMicrophone==='function');
  else await page.waitForFunction(()=>window.__voice?.captureNode && !window.__voice.starting);
  return page;
}

test('voice mute: real AudioWorklet stops outbound audio; playback graph remains live',async({mediaContext,mediaExtensionId})=>{
  const page=await setup(mediaContext,mediaExtensionId);
  await page.waitForFunction(()=>window.__sent.filter(x=>x.realtimeInput?.audio).length>=3);
  await page.locator('#voiceMuteBtn').click();
  const state=await page.evaluate(async()=>{
    const v=window.__voice;
    const before=window.__sent.filter(x=>x.realtimeInput?.audio).length;
    const samples=Int16Array.from({length:48000},(_,i)=>Math.round(8000*Math.sin(2*Math.PI*440*i/24000)));
    await v.playPcm(v.pcmToBase64(samples),24000);
    const source=[...v.playingSources][0];
    const analyser=v.outputContext.createAnalyser();source.connect(analyser);
    await new Promise(r=>setTimeout(r,500));
    const floats=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(floats);
    return {before,after:window.__sent.filter(x=>x.realtimeInput?.audio).length,trackEnabled:v.stream.getAudioTracks()[0].enabled,output:v.outputContext.state,rms:Math.sqrt(floats.reduce((n,x)=>n+x*x,0)/floats.length),muted:v.microphoneMuted,sourceCount:v.playingSources.size};
  });
  console.log('AUDIO_EVIDENCE',JSON.stringify(state));
  expect(state.after).toBe(state.before);expect(state.trackEnabled).toBe(false);expect(state.rms).toBeGreaterThan(.01);expect(state.output).toBe('running');
  await page.locator('#voiceMuteBtn').click();
  await page.waitForFunction(n=>window.__sent.filter(x=>x.realtimeInput?.audio).length>n,state.after);
  await page.locator('#voiceBtn').click();
  await expect(page.locator('#voiceMuteBtn')).toBeHidden();
});

test('voice mute: narrow input row remains contained',async({mediaContext,mediaExtensionId},testInfo)=>{
  const page=await setup(mediaContext,mediaExtensionId);
  await page.locator('#voiceMuteBtn').click();
  for (const lang of ['fr', 'en', 'es']) {
    if (!(await page.locator('#headerMenu').isVisible())) await page.locator('#menuBtn').click();
    await page.locator(`.lang-option[data-lang="${lang}"]`).click();
    for(const width of [320,360,400]){
    await page.setViewportSize({width,height:800});
    const sizes=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,row:[...document.querySelectorAll('.input-area > *, .voice-controls > *')].filter(e=>!e.hidden).map(e=>({id:e.id,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}))}));
    console.log('LAYOUT_EVIDENCE',JSON.stringify(sizes));
    await page.screenshot({path:testInfo.outputPath(`muted-${lang}-${width}.png`)});
    expect.soft(sizes.row.find(e=>e.id==='userInput').width,`input has usable width at ${width}px`).toBeGreaterThan(80);
    expect.soft(sizes.row.every(e=>e.left>=0&&e.right<=width),`visible input children fit at ${width}px`).toBe(true);
    }
  }
});

test('voice mute: reset clears muted indicator',async({mediaContext,mediaExtensionId},testInfo)=>{
  const page=await setup(mediaContext,mediaExtensionId);
  await page.locator('#voiceMuteBtn').click();
  await page.evaluate(()=>document.getElementById('headerMenu').hidden=false);
  page.on('dialog',d=>d.accept());
  await page.locator('#resetBtn').click();
  await page.waitForFunction(()=>!window.__voice.active);
  console.log('RESET_EVIDENCE',await page.evaluate(()=>({active:window.__voice.active,muted:window.__voice.microphoneMuted,buttonHidden:document.getElementById('voiceMuteBtn').hidden,statusHidden:document.getElementById('voiceMuteStatus').hidden,status:document.getElementById('voiceMuteStatus').textContent})));
  await page.screenshot({path:testInfo.outputPath('after-reset.png')});
  await expect(page.locator('#voiceMuteStatus')).toBeHidden();
  await expect(page.locator('#voiceMuteBtn')).toBeHidden();
  await page.evaluate(() => window.__voice.emit('limova-voice-status', { status: 'listening' }));
  await expect(page.locator('#voiceMuteBtn')).toBeHidden();
});


test('voice mute: reconnect preserves mute with real audio graph',async({mediaContext,mediaExtensionId})=>{
  const page=await setup(mediaContext,mediaExtensionId);
  await page.waitForFunction(()=>window.__sent.filter(x=>x.realtimeInput?.audio).length>=3);
  await page.locator('#voiceMuteBtn').click();
  const state=await page.evaluate(async()=>{
    const v=window.__voice, before=window.__sent.filter(x=>x.realtimeInput?.audio).length;
    const stream=v.stream,context=v.inputContext;
    await v.reconnect();
    await new Promise(r=>setTimeout(r,500));
    return {before,after:window.__sent.filter(x=>x.realtimeInput?.audio).length,trackEnabled:v.stream.getAudioTracks()[0].enabled,sameStream:stream===v.stream,sameContext:context===v.inputContext,muted:v.microphoneMuted};
  });
  console.log('RECONNECT_EVIDENCE',JSON.stringify(state));
  expect(state.after).toBe(state.before);expect(state.trackEnabled).toBe(false);expect(state.sameStream).toBe(true);expect(state.sameContext).toBe(true);expect(state.muted).toBe(true);
  await page.locator('#voiceMuteBtn').click();
  await page.waitForFunction(n=>window.__sent.filter(x=>x.realtimeInput?.audio).length>n,state.after);
});

test('voice mute: reset during pending microphone does not resurrect unmuted capture',async({mediaContext,mediaExtensionId})=>{
  const page=await setup(mediaContext,mediaExtensionId,{deferMicrophone:true});
  await page.locator('#voiceMuteBtn').click();
  expect(await page.evaluate(()=>window.__voice.microphoneMuted)).toBe(true);
  await page.evaluate(()=>document.getElementById('headerMenu').hidden=false);
  page.on('dialog',d=>d.accept());
  await page.locator('#resetBtn').click();
  await page.evaluate(()=>window.__releaseMicrophone());
  await page.waitForFunction(()=>!window.__voice.starting);
  await page.waitForTimeout(500);
  const state=await page.evaluate(()=>({active:window.__voice.active,muted:window.__voice.microphoneMuted,frames:window.__sent.filter(x=>x.realtimeInput?.audio).length,trackEnabled:window.__voice.stream?.getAudioTracks()[0]?.enabled}));
  console.log('STARTUP_RESET_EVIDENCE',JSON.stringify(state));
  expect(state.frames).toBe(0);expect(state.active).toBe(false);
  expect(await page.evaluate(() => window.__lateMicrophone.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#voiceControls')).toBeHidden();
});


test('voice mute: switching to text closes the muted session and clears controls', async ({mediaContext,mediaExtensionId}) => {
  const page = await setup(mediaContext, mediaExtensionId);
  await page.locator('#voiceMuteBtn').click();
  await page.locator('#userInput').fill('Bonjour Charly');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => !window.__voice.active);
  await expect(page.locator('#voiceMuteBtn')).toBeHidden();
  await expect(page.locator('#voiceMuteStatus')).toBeHidden();
  await expect(page.locator('#voiceMuteBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('voice mute: a second voice click cancels pending capture', async ({mediaContext,mediaExtensionId}) => {
  const page = await setup(mediaContext, mediaExtensionId, {deferMicrophone: true});
  await page.locator('#voiceBtn').click();
  await page.evaluate(() => window.__releaseMicrophone());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__sent.filter(x => x.realtimeInput?.audio).length)).toBe(0);
  expect(await page.evaluate(() => window.__voice.active)).toBe(false);
  await expect(page.locator('#voiceControls')).toBeHidden();
});
