// UI integration test: Tauri/recognition events are mocked; audio comes from the real local VOICEVOX engine.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const engine = 'http://127.0.0.1:50021';
const speakersResponse = await fetch(`${engine}/speakers`);
assert.ok(speakersResponse.ok, 'Start VOICEVOX before running this test');
const speakers = await speakersResponse.json();
const style = speakers[0].styles.find(s => !s.type || ['talk','streaming_talk'].includes(s.type)).id;
const queryResponse = await fetch(`${engine}/audio_query?text=${encodeURIComponent('こんにちは。')}&speaker=${style}`, { method:'POST' });
assert.ok(queryResponse.ok);
const audioResponse = await fetch(`${engine}/synthesis?speaker=${style}`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(await queryResponse.json())});
assert.ok(audioResponse.ok);
const audio = Array.from(new Uint8Array(await audioResponse.arrayBuffer()));
const temporary = await mkdtemp(join(tmpdir(),'vtuber-conversation-'));
const port = 1432;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port)], {stdio:'pipe'});
let browser;
try {
  let ready = false;
  for (let i=0; i<60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready, 'Vite did not start');
  browser = await chromium.launch({headless:true, executablePath: process.env.CHROME_BIN || (process.platform==='darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args:['--autoplay-policy=no-user-gesture-required']});
  const page = await browser.newPage({viewport:{width:720,height:600}});
  const errors=[];
  page.on('pageerror', e=>errors.push(String(e)));
  await page.route('**/src/main.tsx*', async route=>{
    const response = await route.fetch();
    await route.fulfill({response,body:`
import {mockIPC} from '/node_modules/@tauri-apps/api/mocks.js';
import {emit} from '/node_modules/@tauri-apps/api/event.js';
window.__test = {sent:[],synthesized:[],mode:'normal',session:null,stops:0};
window.__emitTest = emit;
mockIPC(async (cmd,args) => {
 const test=window.__test;
 if(cmd==='cmd_get_settings') return {avatar_kind:'live2d',live2d_model_url:'models/Vivian/Vivian.model3.json',avatar_scale:1,speech_provider:'voicevox',voicevox_style_id:null};
 if(cmd==='cmd_has_api_key') return false;
 if(cmd==='cmd_synthesize_speech') {test.synthesized.push(args.text);return ${JSON.stringify(audio)};}
 if(cmd==='cmd_start_listening') {
   test.session=args.id;
   if(test.mode==='denied') { await emit('speech://event',{id:args.id,kind:'error',text:'Izin mikrofon ditolak'});return; }
   await emit('speech://event',{id:args.id,kind:'listening',text:''});
   return;
 }
 if(cmd==='cmd_stop_listening') {test.stops++;return;}
 if(cmd==='cmd_chat') {
   test.sent.push(args.message);
   setTimeout(()=>emit('nim://chunk',{id:args.id,text:'Ini jawaban suara.',delta:'Ini jawaban suara.'}),100);
   setTimeout(()=>emit('nim://done',{id:args.id,text:'Ini jawaban suara.',speech_text:'これは音声の返事です。',emo:'{"primary":"shy","intensity":0.8,"gesture":"nod"}'}),200);
 }
}, {shouldMockEvents:true});
${await response.text()}`});
  });
  let failModel = true;
  await page.route('**/models/Vivian/Vivian.model3.json', route => {
    if (failModel) return route.fulfill({status:503,body:'temporary loading failure'});
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/?mode=companion`);
  await page.getByRole('button',{name:'Muat ulang avatar',exact:true}).waitFor();
  failModel = false;
  await page.getByRole('button',{name:'Muat ulang avatar',exact:true}).click();
  await page.waitForFunction(()=>window.__stage?.model);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('button:visible').count(),0);
  if (process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT + ".initial.png",omitBackground:true});
  const rendered = await page.evaluate(()=>{
    const stage=window.__stage;
    const pixels=stage.app.renderer.extract.pixels(stage.app.stage);
    let visible=0;
    for(let i=3;i<pixels.length;i+=4) if(pixels[i]>0) visible++;
    return {visible, textures:stage.model.textures.map(t=>[t.width,t.height])};
  });
  assert.ok(rendered.visible > 1000, 'The loaded avatar must actually render visible pixels');
  assert.ok(rendered.textures.every(([w,h])=>w<=2048 && h<=2048),'Atlas dimensions must be bounded');
  assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.evaluate(()=>{
    window.__observed={mouth:0,max:0,shy:0};
    window.__stage.model.internalModel.on('beforeModelUpdate',()=>{
      const core=window.__stage.model.internalModel.coreModel;
      window.__observed.mouth=core.getParameterValueById('ParamMouthOpenY');
      window.__observed.max=Math.max(window.__observed.max,window.__observed.mouth);
      window.__observed.shy=core.getParameterValueById('Param149');
    });
  });
  await page.locator('.drag-region').click({button:'right'});
  assert.equal(await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).textContent(), '');
  // Regression: blocked output playback must not block native microphone startup.
  await page.evaluate(()=>{
    window.__originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function() { return new Promise(()=>{}); };
  });
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.waitForFunction(()=>window.__test.session !== null, undefined, {timeout:1500});
  await page.evaluate(()=>{AudioContext.prototype.resume=window.__originalResume});
  await page.locator('.microphone-status').waitFor();
  await page.evaluate(async()=>{
    await window.__emitTest('speech://event',{id:window.__test.session,kind:'authorizing',text:'Menghubungkan ulang pengenal ucapan…'});
  });
  await page.waitForFunction(()=>document.querySelector('.microphone-status').textContent.includes('Menghubungkan ulang'));
  await page.evaluate(async()=>{
    await window.__emitTest('speech://event',{id:window.__test.session,kind:'listening',text:''});
    await window.__emitTest('speech://event',{id:window.__test.session,kind:'partial',text:'Halo Vivian'});
  });
  assert.ok((await page.locator('.microphone-status').textContent()).includes('Halo Vivian'));
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await page.evaluate(async()=>{
    const event={id:window.__test.session,kind:'final',text:'Halo Vivian'};
    await window.__emitTest('speech://event',event);
    await window.__emitTest('speech://event',event); // A duplicate final must not send a second turn.
  });
  await page.waitForFunction(()=>window.__test.sent.length===1);
  await page.waitForFunction(()=>window.__test.synthesized.length===1);
  assert.equal(await page.evaluate(()=>window.__test.synthesized[0]),'これは音声の返事です。');
  await page.locator('.reply-bubble').waitFor();
  assert.equal(await page.locator('.microphone-status').count(),0);
  assert.equal(await page.locator('.companion-menu').count(),0);
  assert.ok(!(await page.locator('.reply-text').textContent()).includes('これは'));
  assert.ok((await page.locator('.reply-text').textContent()).includes('Ini jawaban suara.'));
  const bubble=await page.locator('.reply-bubble').boundingBox();
  const avatar=await page.locator('.avatar-surface').boundingBox();
  assert.ok(bubble.x+bubble.width <= avatar.x,'Bubble must sit beside the avatar');
  await page.waitForFunction(()=>window.__observed.max > .05);
  await page.waitForFunction(()=>window.__observed.shy > .5);
  await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT || join(temporary,'reply.png'),omitBackground:true});
  await page.waitForFunction(()=>!document.querySelector('.reply-label')?.textContent.includes('Sedang berbicara'));
  await page.waitForTimeout(150);
  assert.ok((await page.evaluate(()=>window.__observed.mouth))<.01);
  await page.getByRole('button',{name:'Tutup jawaban',exact:true}).click();
  await page.locator('.drag-region').click({button:'right'});
  await page.evaluate(()=>{window.__test.mode='denied'});
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.companion-menu').textContent.includes('Izin mikrofon ditolak'));
  assert.equal(await page.locator('.microphone-status').count(),0);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),1);
  await page.evaluate(()=>{window.__test.mode='normal'});
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.locator('.microphone-status').waitFor();
  const old=await page.evaluate(()=>window.__test.session);
  await page.locator('.microphone-status').getByRole('button',{name:'Batalkan mikrofon',exact:true}).click();
  await page.evaluate(async id=>window.__emitTest('speech://event',{id,kind:'final',text:'stale'}),old);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),1);
  assert.deepEqual(errors,[]);
  const dashboard = await browser.newPage();
  let modelRequests = 0;
  dashboard.on('request', request=>{if(request.url().includes('/models/')) modelRequests++;});
  await dashboard.goto(`http://127.0.0.1:${port}/`);
  await dashboard.getByRole('button',{name:'Tampilkan avatar',exact:true}).waitFor();
  assert.equal(await dashboard.locator('canvas').count(),0);
  assert.equal(modelRequests,0,'The control panel must not load a second avatar');
  await dashboard.close();
  console.log('PASS: renderer retry and visible avatar pixels, 2048px atlases, no second model in controls, Indonesian text/Japanese speech, microphone icon, blocked playback does not block recording, reconnect status, local VOICEVOX WAV, explicit recording, interim transcript, one final → one reply, side bubble with hidden controls, emotion, lip sync, denial and cancellation.');
} finally {
  await browser?.close();
  server.kill();
  await rm(temporary,{recursive:true,force:true});
}
