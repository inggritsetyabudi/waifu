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
  const context = await browser.newContext({viewport:{width:720,height:600}});
  await context.addInitScript(()=>{
    if(!localStorage.getItem('honey.preferences')) localStorage.setItem('honey.preferences',JSON.stringify({aiTouchEnabled:false,idleChatter:false}));
  });
  const page = await context.newPage();
  const openExtras=async()=>{
    if(!await page.locator('.companion-menu').count()) await page.getByRole('button',{name:'Menu companion',exact:true}).click();
    await page.locator('.companion-extras').evaluate(node=>node.open=true);
  };
  const tapAt=async(nx,ny)=>{
    const point=await page.evaluate(({nx,ny})=>{
      const stage=window.__stage,model=stage.model,internal=model.internalModel;
      model.getBounds();
      const local=internal.localTransform.apply({x:nx*internal.originalWidth,y:ny*internal.originalHeight},{});
      const global=model.worldTransform.apply(local,{}),rect=stage.canvas.getBoundingClientRect();
      return {x:rect.left+global.x*rect.width/stage.app.screen.width,y:rect.top+global.y*rect.height/stage.app.screen.height};
    },{nx,ny});
    await page.mouse.click(point.x,point.y);
  };
  const errors=[];
  page.on('pageerror', e=>errors.push(String(e)));
  await page.route('**/src/main.tsx*', async route=>{
    const response = await route.fetch();
    await route.fulfill({response,body:`
import {mockIPC} from '/node_modules/@tauri-apps/api/mocks.js';
import {emit} from '/node_modules/@tauri-apps/api/event.js';
window.__test = {idleRequests:[],idleMode:'normal',listenStarts:[],touchRequests:[],touchMode:'normal',cancelled:[],sent:[],synthesized:[],mode:'normal',session:null,stops:0,captures:0,screenContexts:[],screenMode:'normal',settings:{avatar_kind:'live2d',live2d_model_url:'models/Vivian/Vivian.model3.json',avatar_scale:1,speech_provider:'voicevox',voicevox_style_id:null,affectionate_mode:false}};
window.__emitTest = emit;
mockIPC(async (cmd,args) => {
 const test=window.__test;
 if(cmd==='cmd_get_settings') return {...test.settings};
 if(cmd==='cmd_save_settings') {test.settings=args.settings; await emit('settings://changed',args.settings);return;}
 if(cmd==='cmd_has_api_key') return false;
 if(cmd==='cmd_cancel_chat') {test.cancelled.push(args.id);return;}
 if(cmd==='cmd_idle_reaction') {
   test.idleRequests.push(args);
   await new Promise(resolve=>setTimeout(resolve,test.idleMode==='late'?1400:80));
   return {text:'Aku lagi latihan pose lucu, mau lihat?',speech_text:'かわいいポーズを練習しているよ。見てみる？',emo:JSON.stringify({primary:'playful',actions:[{pose:'confident',expression:'wink',gesture:'tilt',duration_ms:800},{pose:'greeting',expression:'smile',gesture:'wave',duration_ms:800}]})};
 }
 if(cmd==='cmd_touch_reaction') {
   test.touchRequests.push({...args,affectionate:test.settings.affectionate_mode});
   const count=test.touchRequests.length, mode=test.touchMode;
   await new Promise(resolve=>setTimeout(resolve,mode==='late'?1200:80));
   if(mode==='error') throw new Error('AI sentuhan belum terhubung');
   return {text:'Teks manja dinamis '+count+'.',speech_text:'えへへ、もっとお話ししよう！',emo:'{"primary":"shy","expression":"blush","gesture":"tilt","duration_ms":500}'};
 }
 if(cmd==='cmd_synthesize_speech') {test.synthesized.push(args.text);return ${JSON.stringify(audio)};}
 if(cmd==='cmd_start_listening') {
   test.listenStarts.push(args.id);test.session=args.id;
   if(test.mode==='denied') { await emit('speech://event',{id:args.id,kind:'error',text:'Izin mikrofon ditolak'});return; }
   await emit('speech://event',{id:args.id,kind:'listening',text:''});
   return;
 }
 if(cmd==='cmd_capture_screen') {
   test.captures++;
   if(test.screenMode==='cancel') return null;
   if(test.screenMode==='denied') throw new Error('Izin Screen Recording ditolak');
   return {preview_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOZQAAAAASUVORK5CYII=',text:'Error: file not found\\nPrivate draft: remove before sending'};
 }
 if(cmd==='cmd_stop_listening') {test.stops++;return;}
 if(cmd==='cmd_chat') {
   test.sent.push(args.message);
   test.screenContexts.push(args.screenText);
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
  assert.equal(await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).count(),1);
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
  await page.evaluate(()=>{
    window.__gestureValues=[];
    window.__stage.model.internalModel.on('beforeModelUpdate',()=>window.__gestureValues.push(window.__stage.model.internalModel.coreModel.getParameterValueById('ParamAngleZ')));
    window.__stage.gesture('wave');
  });
  await page.waitForTimeout(800);
  const movement = await page.evaluate(()=>Math.max(...window.__gestureValues)-Math.min(...window.__gestureValues));
  assert.ok(movement>1,'A greeting gesture must visibly animate model parameters');
  await page.evaluate(()=>window.__stage.gesture('none'));
  const classifications = await page.evaluate(async()=>{
    const {touchZone} = await import('/src/avatar/touch.ts');
    return [touchZone(.6,.5,true),touchZone(.5,.62,true),touchZone(.5,.3,false),touchZone(.5,.62,false),touchZone(.6,.33,true),touchZone(.2,.5,false)];
  });
  assert.deepEqual(classifications,['sensitive','sensitive','sensitive','sensitive','head','hand']);
  // Real pointer clicks hit the rendered avatar, while empty space stays inert.
  const touches = [[.6,.33],[.6,.41],[.45,.5],[.6,.5],[.4,.83],[.75,.25]];
  const touched = new Set();
  for (const [x,y] of touches) {
    await tapAt(x,y);
    await page.waitForTimeout(340);
    const label = await page.locator('.touch-feedback').textContent().catch(()=>null);
    if(label) touched.add(label);
  }
  assert.ok(touched.size >= 3, `Expected different body-region reactions, got ${[...touched]}`);
  await tapAt(.60,.50);
  await page.waitForTimeout(350);
  await page.locator('.touch-feedback.is-warning').waitFor();
  assert.ok((await page.locator('.touch-feedback').textContent()).includes('Aku tidak nyaman'));
  assert.equal(await page.evaluate(()=>window.__test.sent.length),0,'Refusal is local feedback, not a new chat turn');
  await page.waitForTimeout(4100);
  const empty=await page.locator('.avatar-surface').boundingBox();
  await page.mouse.click(empty.x+2,empty.y+2);
  assert.equal(await page.locator('.touch-feedback').count(),0,'Empty canvas space must not react');
  assert.equal(await page.locator('.companion-menu').count(),0,'Clicks must not toggle controls');
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
  assert.equal(await page.getByRole('button',{name:'Batalkan mikrofon',exact:true}).count(),1);
  assert.equal(await page.locator('.companion-menu').count(),0);
  assert.ok(!(await page.locator('.reply-text').textContent()).includes('これは'));
  assert.ok((await page.locator('.reply-text').textContent()).includes('Ini jawaban suara.'));
  const bubble=await page.locator('.reply-bubble').boundingBox();
  const avatar=await page.locator('.avatar-surface').boundingBox();
  assert.ok(bubble.x+bubble.width<=avatar.x || bubble.x>=avatar.x+avatar.width,'Bubble must sit beside the avatar');
  await page.waitForFunction(()=>window.__observed.max > .05);
  await page.waitForFunction(()=>window.__observed.shy > .5);
  await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT || join(temporary,'reply.png'),omitBackground:true});
  await page.waitForFunction(()=>!document.querySelector('.reply-label')?.textContent.includes('Sedang berbicara'));
  await page.waitForTimeout(150);
  assert.ok((await page.evaluate(()=>window.__observed.mouth))<.01);
  await page.getByRole('button',{name:'Tutup jawaban',exact:true}).click();
  await page.locator('.drag-region').click({button:'right'});
  await page.waitForFunction(()=>window.__test.listenStarts.length>=2);
  const renewed=await page.evaluate(()=>window.__test.session);
  await page.evaluate(async()=>window.__emitTest('speech://event',{id:window.__test.session,kind:'stopped',text:''}));
  await page.waitForFunction(id=>window.__test.session!==id,renewed);
  await page.getByRole('button',{name:'Batalkan mikrofon',exact:true}).click();
  await page.evaluate(()=>{window.__test.mode='denied'});
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.getByText('Izin mikrofon ditolak',{exact:true}).waitFor();
  assert.equal(await page.locator('.microphone-status').count(),0);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),1);
  await page.evaluate(()=>{window.__test.mode='normal'});
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.locator('.microphone-status').waitFor();
  const old=await page.evaluate(()=>window.__test.session);
  await page.locator('.bubble-toolbar').getByRole('button',{name:'Batalkan mikrofon',exact:true}).click();
  await page.evaluate(async id=>window.__emitTest('speech://event',{id,kind:'final',text:'stale'}),old);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),1);
  // Reviewed screen context is explicit; opening a preview does not send a message.
  if(!await page.locator('.companion-menu').count()) await page.getByRole('button',{name:'Menu companion',exact:true}).click();
  await page.getByRole('button',{name:'Bantu layar Mac',exact:true}).click();
  await page.getByRole('textbox',{name:'Teks layar untuk AI',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__test.sent.length),1);
  await page.getByRole('textbox',{name:'Teks layar untuk AI',exact:true}).fill('Error: file not found');
  await page.getByRole('button',{name:'Jelaskan error ini',exact:true}).click();
  await page.setViewportSize({width:640,height:520});
  const assertBubbleLayout = async () => {
    const result = await page.evaluate(()=>{
      const avatar=document.querySelector('.avatar-surface').getBoundingClientRect();
      const clip=document.querySelector('.rail-content').getBoundingClientRect();
      const boxes=[...document.querySelectorAll('.companion-rail .bubble-panel,.reply-lane .bubble-panel')].map(node=>{
        const box=node.getBoundingClientRect();
        const boundary=node.closest('.rail-content,.reply-lane')?.getBoundingClientRect();
        const top=boundary?Math.max(box.top,boundary.top):box.top;
        const bottom=boundary?Math.min(box.bottom,boundary.bottom):box.bottom;
        return {left:box.left,right:box.right,top,bottom};
      }).filter(box=>box.bottom>box.top);
      const overlap=boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5));
      const dock=document.querySelector('.companion-dock').getBoundingClientRect();
      return {overlap,obstructs:boxes.some(box=>box.right>avatar.left+.5 && box.left<avatar.right-.5),dockBelow:dock.top>=avatar.bottom,dockCentered:Math.abs((dock.left+dock.right-avatar.left-avatar.right)/2)<1};
    });
    assert.deepEqual(result,{overlap:false,obstructs:false,dockBelow:true,dockCentered:true});
  };
  await assertBubbleLayout();
  await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT ? process.env.VTUBER_TEST_SCREENSHOT+'.panels.png' : join(temporary,'panels.png'),omitBackground:true});
  await page.getByRole('button',{name:'Kirim teks layar',exact:true}).click();
  await page.waitForFunction(()=>window.__test.sent.length===2);
  assert.equal(await page.evaluate(()=>window.__test.screenContexts[1]),'Error: file not found');
  assert.equal(await page.locator('.screen-preview').count(),0);
  await page.waitForFunction(()=>window.__test.synthesized.length===2);
  await assertBubbleLayout();
  await page.evaluate(()=>{window.__test.screenMode='cancel'});
  if(!await page.locator('.companion-menu').count()) await page.getByRole('button',{name:'Menu companion',exact:true}).click();
  await page.getByRole('button',{name:'Bantu layar Mac',exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.screen-preview').count(),0);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),2);
  await page.evaluate(()=>{window.__test.screenMode='denied'});
  if(!await page.locator('.companion-menu').count()) await page.getByRole('button',{name:'Menu companion',exact:true}).click();
  await page.getByRole('button',{name:'Bantu layar Mac',exact:true}).click();
  await page.getByText(/Izin Screen Recording ditolak/).waitFor();
  await assertBubbleLayout();
  // Model-directed actions have their own Japanese lines, run serially, and can be stopped.
  await page.setViewportSize({width:720,height:600});
  const sequenceStart = await page.evaluate(()=>window.__test.synthesized.length);
  await page.evaluate(async()=>window.__emitTest('nim://done', {
    id:'pose-sequence-test',text:'Aku akan berpose malu, lalu menyapamu.',speech_text:'全体の返事です。',
    emo:JSON.stringify({primary:'shy',actions:[
      {pose:'shy',expression:'blush',gesture:'look_away',duration_ms:500,speech_ja:'少し恥ずかしいです。'},
      {pose:'greeting',expression:'smile',gesture:'wave',duration_ms:500,speech_ja:'こんにちは！'}
    ]})
  }));
  await page.waitForFunction(start=>window.__test.synthesized.length>=start+1,sequenceStart);
  assert.equal(await page.evaluate(start=>window.__test.synthesized[start],sequenceStart),'少し恥ずかしいです。');
  await page.getByText(/Melirik · 1\/2/).waitFor();
  assert.equal(await page.evaluate(()=>window.__stage.poseName),'shy');
  assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'look_away');
  await page.waitForFunction(start=>window.__test.synthesized.length>=start+2,sequenceStart);
  assert.equal(await page.evaluate(start=>window.__test.synthesized[start+1],sequenceStart),'こんにちは！');
  assert.equal(await page.evaluate(()=>window.__stage.poseName),'greeting');
  assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'wave');
  await page.waitForFunction(()=>document.querySelector('.reply-label')?.textContent!=='Sedang berbicara');
  assert.equal(await page.evaluate(()=>window.__test.synthesized.includes('全体の返事です。')),false,'Do not read both per-action and whole-reply speech');
  const stopStart = await page.evaluate(()=>window.__test.synthesized.length);
  await page.evaluate(async()=>window.__emitTest('nim://done', {
    id:'interrupted-pose-test',text:'Aku menyapa, lalu berpikir.',speech_text:null,
    emo:JSON.stringify({actions:[{pose:'greeting',gesture:'wave',expression:'wink',duration_ms:8000,speech_ja:'やあ！'},{pose:'thinking',gesture:'think',duration_ms:500,speech_ja:'考えています。'}]})
  }));
  await page.waitForFunction(start=>window.__test.synthesized.length===start+1,stopStart);
  const menuOpen = await page.locator('.companion-menu').count();
  if(!menuOpen) await page.getByRole('button',{name:'Menu companion',exact:true}).click();
  await openExtras();
  await openExtras();
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(()=>window.__stage.poseName),'neutral');
  assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'none');
  assert.equal(await page.locator('.action-status').count(),0);
  assert.equal(await page.evaluate(()=>window.__test.synthesized.includes('考えています。')),false);
  // Preferences, utility controls and quick actions are functional, not decorative.
  await page.context().grantPermissions(['clipboard-read','clipboard-write'], {origin:`http://127.0.0.1:${port}`});
  await page.getByRole('button',{name:'Salin jawaban',exact:true}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Aku menyapa, lalu berpikir.');
  await page.getByRole('button',{name:'Sematkan jawaban',exact:true}).click();
  await page.waitForTimeout(15500);
  await page.getByRole('button',{name:'Lepas sematan jawaban',exact:true}).waitFor();
  assert.equal(await page.locator('.reply-bubble').count(),1);
  await openExtras();
  await page.getByRole('button',{name:'Tema Matcha',exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'mint');
  await openExtras();
  await page.getByLabel('Gerakan lebih lembut',{exact:true}).check();
  assert.equal(await page.evaluate(()=>window.__stage.app.ticker.maxFPS),24);
  await page.getByRole('button',{name:'Bisukan suara',exact:true}).click();
  const mutedStart=await page.evaluate(()=>window.__test.synthesized.length);
  await page.getByRole('button',{name:/High five/}).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'wave');
  assert.equal(await page.evaluate(()=>window.__test.synthesized.length),mutedStart);
  await page.getByRole('button',{name:'Aktifkan suara',exact:true}).click();
  await page.getByRole('button',{name:/High five/}).click();
  await page.waitForFunction(start=>window.__test.synthesized.length===start+1,mutedStart);
  assert.equal(await page.evaluate(start=>window.__test.synthesized[start],mutedStart),'ハイタッチ！今日もよろしくね！');
  await openExtras();
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await assertBubbleLayout();
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.playground.png',omitBackground:true});
  await page.reload();
  await page.waitForFunction(()=>window.__stage?.model);
  assert.equal(await page.locator('html').getAttribute('data-theme'),'mint');
  assert.equal(await page.evaluate(()=>window.__stage.app.ticker.maxFPS),24);
  await openExtras();
  await openExtras();
  await page.getByLabel('Mode Manja',{exact:true}).check();
  await page.waitForFunction(()=>window.__test.settings.affectionate_mode && window.__stage.affectionateMode);
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await tapAt(.60,.50);
  await page.waitForTimeout(350);
  assert.ok((await page.locator('.touch-feedback').textContent()).includes('Aku tidak nyaman'));
  assert.equal(await page.locator('.touch-feedback.is-warning').count(),1);
  assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'shake');
  assert.equal(await page.evaluate(()=>window.__test.sent.length),0);
  await page.locator('.drag-region').click({button:'right'});
  await openExtras();
  await page.getByLabel('Mode Manja',{exact:true}).uncheck();
  await page.waitForFunction(()=>!window.__stage.affectionateMode);
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await tapAt(.60,.50);
  await page.locator('.touch-feedback.is-warning').waitFor();
  await page.locator('.drag-region').click({button:'right'});
  await openExtras();
  await page.getByLabel('Suara saat disentuh',{exact:true}).check();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await page.waitForTimeout(350);
  await tapAt(.60,.33);
  await page.waitForFunction(()=>window.__test.synthesized.length===1);
  assert.ok((await page.locator('.tap-spark').count())>0);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),0,'Touch feedback stays separate from AI dialogue');
  assert.deepEqual(errors,[]);
  const dashboard = await page.context().newPage();
  let modelRequests = 0;
  dashboard.on('request', request=>{if(request.url().includes('/models/')) modelRequests++;});
  await dashboard.goto(`http://127.0.0.1:${port}/`);
  await dashboard.getByRole('button',{name:'Tampilkan avatar',exact:true}).waitFor();
  assert.equal(await dashboard.locator('canvas').count(),0);
  assert.equal(modelRequests,0,'The control panel must not load a second avatar');
  assert.equal(await dashboard.locator('html').getAttribute('data-theme'),'mint');
  await dashboard.setViewportSize({width:1240,height:780});
  if(process.env.VTUBER_TEST_SCREENSHOT) await dashboard.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.studio.png'});
  await dashboard.evaluate(()=>{
    const prefs=JSON.parse(localStorage.getItem('honey.preferences')); prefs.theme='peach';
    localStorage.setItem('honey.preferences',JSON.stringify(prefs));
  });
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='peach');
  await dashboard.close();
  // Idle behavior uses the real stage; no AI requests or surprise speech.
  const idleBaseline=await page.evaluate(()=>({sent:window.__test.sent.length,audio:window.__test.synthesized.length}));
  await page.evaluate(()=>{window.__idle.nextAt=0;});
  await page.waitForFunction(()=>window.__idle.active);
  assert.notEqual(await page.evaluate(()=>window.__stage.poseName),'neutral');
  await tapAt(.60,.33);
  assert.equal(await page.evaluate(()=>window.__idle.active),false,'Touch interrupts spontaneous behavior immediately');
  await page.locator('.drag-region').click({button:'right'});
  await openExtras();
  await page.getByLabel('Tingkah spontan',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await page.evaluate(()=>{window.__idle.nextAt=0;});
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.__idle.active),false,'Disabled idle mode stays still');
  assert.equal(await page.evaluate(()=>window.__test.sent.length),idleBaseline.sent);
  // The touch above may speak when touch audio is enabled; idle itself never speaks.
  const idleRules=await page.evaluate(async()=>{
    const {IdleCompanion}=await import('/src/avatar/idle.ts');
    const calls=[],labels=[];
    const stage={pose:(...args)=>calls.push(['pose',...args]),gesture:(...args)=>calls.push(['gesture',...args]),setSemanticExpression:(...args)=>calls.push(['expression',...args])};
    const idle=new IdleCompanion(()=>stage,label=>labels.push(label),()=>0,0);
    idle.tick(8999,false,false,false); const before=calls.length;
    idle.tick(9000,false,false,false); const first=calls.slice();
    idle.tick(11600,false,false,false); const second=calls.slice(-3);
    idle.tick(13800,false,false,false); const finished=!idle.active;
    idle.tick(22800,false,false,false); const different=labels.filter(Boolean);
    idle.interrupt(23000); const stopped=!idle.active;
    idle.tick(100000,true,false,false); const blocked=!idle.active;
    const shy=new IdleCompanion(()=>stage,()=>{},()=>0,0);
    shy.tick(9000,false,true,false); const affectionate=calls.slice(-3);
    return {before,first,second,finished,different,stopped,blocked,affectionate};
  });
  assert.equal(idleRules.before,0);
  assert.ok(idleRules.first.some(c=>c[0]==='pose' && c[1]==='shy'));
  assert.ok(idleRules.second.some(c=>c[0]==='expression' && c[1]==='wink'));
  assert.ok(idleRules.finished && idleRules.stopped && idleRules.blocked);
  assert.notEqual(idleRules.different[0],idleRules.different[1],'Consecutive routines must vary');
  assert.ok(idleRules.affectionate.some(c=>c[0]==='expression' && c[1]==='blush'));
  await page.locator('.drag-region').click({button:'right'});
  await openExtras();
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await openExtras();
  await page.getByLabel('Balasan sentuhan AI',{exact:true}).check();
  await openExtras();
  await page.getByLabel('Mode Manja',{exact:true}).check();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await tapAt(.60,.33);
  await page.waitForTimeout(350);
  await tapAt(.60,.33);
  await page.waitForFunction(()=>window.__test.touchRequests.length===1);
  await page.waitForFunction(()=>document.querySelector('.reply-bubble')?.textContent.includes('Teks manja dinamis 1.'));
  const firstTouch=await page.evaluate(()=>window.__test.touchRequests[0]);
  assert.equal(firstTouch.context.taps,2,'Click bursts must produce a single AI request');
  assert.ok(['head','accessory'].includes(firstTouch.context.region),'Send the actual rendered touch region');
  assert.equal(firstTouch.affectionate,true);
  await page.waitForFunction(()=>window.__test.synthesized.includes('えへへ、もっとお話ししよう！'));
  await page.waitForTimeout(350);
  await tapAt(.60,.50);
  await page.waitForFunction(()=>window.__test.touchRequests.length===2);
  await page.waitForFunction(()=>document.querySelector('.reply-bubble')?.textContent.includes('Teks manja dinamis 2.'));
  assert.deepEqual(await page.evaluate(()=>window.__test.touchRequests[1].context.recent_replies),['Teks manja dinamis 1.']);
  assert.equal(await page.evaluate(()=>window.__test.sent.length),idleBaseline.sent,'Touch does not add a normal conversation turn');
  // A late AI reply must never interrupt recording.
  await page.evaluate(()=>{window.__test.touchMode='late';});
  await page.waitForTimeout(350);
  await tapAt(.60,.33);
  await page.waitForFunction(()=>window.__test.touchRequests.length===3);
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.waitForFunction(()=>window.__test.cancelled.some(id=>id.startsWith('touch-')));
  await page.waitForTimeout(1400);
  assert.ok(!(await page.locator('.reply-bubble').textContent()).includes('Teks manja dinamis 3.'));
  await page.getByRole('button',{name:'Batalkan mikrofon',exact:true}).click();
  await page.evaluate(()=>{window.__test.touchMode='error';});
  await page.waitForTimeout(350);
  await tapAt(.60,.50);
  await page.locator('.voice-notice').filter({hasText:'AI sentuhan belum terhubung'}).waitFor();
  assert.ok((await page.locator('.reply-bubble').textContent()).includes('Teks manja dinamis 2.'));
  // A quiet companion initiates voiced AI dialogue with multiple actual stage actions.
  await openExtras();
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await page.getByLabel('Tingkah spontan',{exact:true}).check();
  await page.getByLabel('Mengobrol sendiri saat sepi',{exact:true}).check();
  await page.getByLabel('Balasan sentuhan AI',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  await page.getByRole('button',{name:'Mulai mikrofon',exact:true}).click();
  await page.bringToFront();
  await page.waitForFunction(()=>!document.hidden && document.querySelector('.microphone-status')?.textContent.includes('Mendengarkan'));
  await page.waitForTimeout(300);
  const beforeIdle=await page.evaluate(()=>window.__test.listenStarts.length);
  await page.evaluate(()=>{window.__proactive.nextAt=0;});
  try {await page.waitForFunction(()=>window.__test.idleRequests.length===1,{},{timeout:6000});}
  catch(error) {throw new Error('Proactive did not start: '+JSON.stringify(await page.evaluate(()=>({hidden:document.hidden,preferences:localStorage.getItem('honey.preferences'),session:window.__test.session,nextAt:window.__proactive.nextAt,body:document.body.innerText})))+String(error));}
  await page.waitForFunction(()=>document.querySelector('.reply-text')?.textContent.includes('latihan pose lucu'));
  await page.waitForFunction(()=>window.__test.synthesized.includes('かわいいポーズを練習しているよ。見てみる？'));
  assert.ok((await page.locator('.microphone-status').textContent()).includes('Menunggu'));
  assert.equal(await page.evaluate(()=>window.__test.listenStarts.length),beforeIdle,'Do not open the mic during AI playback');
  await page.waitForFunction(count=>window.__test.listenStarts.length>count,beforeIdle);
  const finalBaseline=await page.evaluate(()=>window.__test.sent.length);
  const finalSession=await page.evaluate(()=>window.__test.session);
  await page.evaluate(async()=>window.__emitTest('speech://event',{id:window.__test.session,kind:'final',text:'Aku mau ngobrol lagi'}));
  await page.waitForFunction(count=>window.__test.sent.length===count+1,finalBaseline);
  await page.waitForFunction(id=>window.__test.session!==id,finalSession);
  // No second microphone click was needed for a second utterance.
  const secondSession=await page.evaluate(()=>window.__test.session);
  await page.evaluate(async()=>window.__emitTest('speech://event',{id:window.__test.session,kind:'final',text:'Coba pose yang ceria'}));
  await page.waitForFunction(count=>window.__test.sent.length===count+2,finalBaseline);
  await page.waitForFunction(id=>window.__test.session!==id,secondSession);
  await page.getByRole('button',{name:'Batalkan mikrofon',exact:true}).click();
  const stoppedStarts=await page.evaluate(()=>window.__test.listenStarts.length);
  await page.waitForTimeout(850);
  assert.equal(await page.evaluate(()=>window.__test.listenStarts.length),stoppedStarts,'Explicit mic off prevents renewal');
  // Late proactive replies cannot override an interaction.
  await page.evaluate(()=>{window.__test.idleMode='late';window.__proactive.nextAt=0;});
  await page.waitForFunction(()=>window.__test.idleRequests.length===2);
  await page.getByRole('button',{name:'Menu companion',exact:true}).click();
  const textBeforeCancel=await page.locator('.reply-text').textContent();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.reply-text').textContent(),textBeforeCancel);
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.minimal.png',omitBackground:true});
  // Nicole's supplied hand/prop expressions are used by semantic gestures.
  await page.evaluate(async()=>{
    await window.__stage.load('models/Nicole/Nicole.model3.json',1);
    window.__nativeObserved={};
    window.__stage.model.internalModel.on('beforeModelUpdate',()=>{
      for(const id of ['Param12','Param11','Param18','Param17','Param16','Param23','Param24']) window.__nativeObserved[id]=window.__stage.model.internalModel.coreModel.getParameterValueById(id);
    });
  });
  for(const [gesture,parameter] of [['heart','Param12'],['heart','Param12'],['peace','Param11'],['sip_tea','Param18']]) {
    await page.evaluate(name=>{window.__stage.setSemanticExpression('neutral');window.__stage.gesture(name,1800);},gesture);
    await page.waitForFunction(id=>window.__nativeObserved[id]>.5,parameter);
  }
  await page.evaluate(()=>{window.__stage.gesture('none');window.__stage.setSemanticExpression('neutral');});
  await openExtras();
  await page.getByLabel('Mode Manja',{exact:true}).check();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  for(const [nx,ny] of [[.46,.29],[.46,.46],[.36,.56],[.57,.61]]) {
    await page.waitForTimeout(340);
    await tapAt(nx,ny);
    await page.locator('.touch-feedback.is-warning').waitFor();
    assert.ok((await page.locator('.touch-feedback').textContent()).includes('Aku tidak nyaman'));
    assert.equal(await page.evaluate(()=>window.__stage.activeGesture),'shake');
  }
  await assertBubbleLayout();
  await page.getByRole('button',{name:'Tutup jawaban',exact:true}).click();
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.nicole.png',omitBackground:true});
  assert.deepEqual(errors,[]);
  // Hands/props survive changes to facial emotion; both layers must be visible together.
  await page.evaluate(()=>{window.__stage.setEmotion('shy',1,6000);window.__stage.gesture('heart',6500);});
  await page.waitForFunction(()=>window.__nativeObserved.Param12>.9 && window.__nativeObserved.Param17>.5 && window.__nativeObserved.Param23>.9 && window.__nativeObserved.Param24>.9);
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.heart-action.png',omitBackground:true});
  await page.evaluate(()=>window.__stage.setEmotion('angry',1,3000));
  await page.waitForFunction(()=>window.__nativeObserved.Param12>.9 && window.__nativeObserved.Param16>.5);
  await page.evaluate(()=>{window.__stage.gesture('none');window.__stage.setSemanticExpression('neutral');});
  await page.waitForFunction(()=>window.__nativeObserved.Param12<.05);
  // Ordinary AI metadata that only names a face/head reaction must still trigger a body action.
  await page.evaluate(async()=>window.__emitTest('nim://done',{id:'body-layer-response',text:'Aku ikut menemanimu!',speech_text:'そばにいるよ！',emo:'{"primary":"shy","gesture":"tilt","expression":"blush","duration_ms":1000}'}));
  await page.waitForFunction(()=>window.__nativeObserved.Param12>.9 && window.__nativeObserved.Param17>.5 && window.__nativeObserved.Param23>.9 && window.__nativeObserved.Param24>.9);
  await openExtras();
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  const promotion=await page.evaluate(async()=>{
    const {withBodyActions,conversationActions}=await import('/src/avatar/conversation.ts');
    const emotionOnly=conversationActions(withBodyActions({primary:'happy',gesture:'nod'}));
    const angry={primary:'angry',gesture:'shake'};
    const stop={primary:'neutral',gesture:'none'};
    const explicit={actions:[{gesture:'look_down',duration_ms:1500,speech_ja:'下を見るよ。'}]};
    return {physical:emotionOnly.some(step=>['wave','heart','peace','dance','lean_right'].includes(step.gesture)),angry:withBodyActions(angry)===angry,stop:withBodyActions(stop)===stop,explicit:withBodyActions(explicit)===explicit};
  });
  assert.deepEqual(promotion,{physical:true,angry:true,stop:true,explicit:true});
  // Response side is chosen once per turn, then remains stable across chunks.
  for(const [side,random] of [['left',.1],['right',.9]]) {
    await page.evaluate(async({side,random})=>{
      window.__savedRandom=Math.random;Math.random=()=>random;
      await window.__emitTest('nim://chunk',{id:'side-'+side,text:'Bubble di '+side,delta:'Bubble'});
      Math.random=()=>1-random;
      await window.__emitTest('nim://chunk',{id:'side-'+side,text:'Bubble di '+side+' tetap stabil.',delta:'stabil.'});
      await window.__emitTest('nim://done',{id:'side-'+side,text:'Bubble di '+side+' tetap stabil.',speech_text:'ここにいるよ。',emo:'{"primary":"calm","gesture":"nod","duration_ms":500}'});
      Math.random=window.__savedRandom;
    },{side,random});
    await page.waitForFunction(value=>document.querySelector('.stage').dataset.replySide===value,side);
    await assertBubbleLayout();
    if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.'+side+'.png',omitBackground:true});
  }
  await page.getByRole('button',{name:'Tulis pesan dan kontrol',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'Pesan untuk Vivian',exact:true});
  assert.equal(await composer.evaluate(node=>node===document.activeElement),true);
  await page.getByRole('button',{name:'Kirim pesan',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Kirim pesan',exact:true}).isEnabled(),false);
  await composer.fill('Bisa dance kecil?');
  await composer.press('Shift+Enter');
  await composer.type('Lalu membungkuk.');
  assert.ok((await composer.inputValue()).includes('\n'));
  await assertBubbleLayout();
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.composer.png',omitBackground:true});
  await page.getByRole('button',{name:'Tutup kolom pesan',exact:true}).click();
  await page.getByRole('button',{name:'Tulis pesan dan kontrol',exact:true}).click();
  assert.ok((await composer.inputValue()).includes('Lalu membungkuk.'));
  const sentBefore=await page.evaluate(()=>window.__test.sent.length);
  await composer.press('Enter');
  await page.waitForFunction(count=>window.__test.sent.length===count+1,sentBefore);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Pesan untuk Vivian"]').value==='');
  await page.getByRole('button',{name:'Tutup kolom pesan',exact:true}).click();
  // Quick actions must visibly move the body, not just change the facial expression.
  await openExtras();
  await page.waitForFunction(()=>!document.querySelector('.typing'));
  await page.evaluate(()=>{
    window.__bodyMotion=[];
    const stage=window.__stage;
    stage.model.internalModel.on('beforeModelUpdate',()=>window.__bodyMotion.push({body:stage.model.internalModel.coreModel.getParameterValueById('ParamBodyAngleZ'),x:stage.model.x,y:stage.model.y}));
  });
  await page.getByRole('button',{name:/^♫Dance kecil|Dance kecil/}).click();
  await page.waitForTimeout(1200);
  const bodyMotion=await page.evaluate(()=>({body:Math.max(...window.__bodyMotion.map(v=>v.body))-Math.min(...window.__bodyMotion.map(v=>v.body)),x:Math.max(...window.__bodyMotion.map(v=>v.x))-Math.min(...window.__bodyMotion.map(v=>v.x))}));
  assert.ok(bodyMotion.body>1,'Dance must deform the body rig');
  assert.ok(bodyMotion.x>.25,'Dance must move the character body');
  await page.getByRole('button',{name:'Hentikan aksi & suara',exact:true}).click();
  await page.getByRole('button',{name:'Tutup kontrol',exact:true}).click();
  assert.deepEqual(errors,[]);
  const continuousActions=await page.evaluate(async()=>{
    const {ConversationDirector}=await import('/src/avatar/conversation.ts');
    const gestures=[];let spoken=0,finishSpeech;
    const audio=new Promise(resolve=>finishSpeech=resolve);
    const stage={gesture:(name)=>gestures.push(name),pose:()=>{},setSemanticExpression:()=>{}};
    const director=new ConversationDirector(()=>stage,async()=>{spoken++;await audio;},()=>{});
    const running=director.run({actions:[{gesture:'dance',duration_ms:500},{gesture:'bow',duration_ms:500}]},'こんにちは！');
    await new Promise(resolve=>setTimeout(resolve,1250));
    const repeated=gestures.filter(name=>name==='dance').length>=2;
    finishSpeech();await running;
    return {repeated,spoken};
  });
  assert.deepEqual(continuousActions,{repeated:true,spoken:1},'Long speech keeps visual actions running without duplicate audio');
  // Even with actions, speech and pointer input absent, the model itself stays alive.
  await page.bringToFront();
  await page.evaluate(async()=>{
    const {AvatarVitality}=await import('/src/avatar/vitality.ts');
    window.__idle.interrupt();window.__proactive.interrupt();
    window.__idle.nextAt=Date.now()+60000;window.__proactive.nextAt=Date.now()+60000;
    const stage=window.__stage;
    stage.gesture('none');stage.pose('neutral');stage.setSemanticExpression('neutral');stage.setReducedMotion(false);stage.setListening(false);
    stage.pointerAt=-Infinity;
    stage.vitality=new AvatarVitality(()=>.8);
    window.__vitalFrames=[];
    stage.model.internalModel.on('beforeModelUpdate',()=>{
      const core=stage.model.internalModel.coreModel;
      window.__vitalFrames.push({eye:core.getParameterValueById('ParamEyeLOpen'),body:core.getParameterValueById('Param7'),gaze:core.getParameterValueById('ParamEyeBallX'),x:stage.model.x,y:stage.model.y});
    });
    const internal=stage.model.internalModel;
    const meshIndices=internal.getDrawableIDs().flatMap((_,i)=>internal.coreModel.getDrawableOpacity(i)>.8?[i]:[]);
    window.__sampleMesh=()=>meshIndices.flatMap(i=>{
      const vertices=internal.getDrawableVertices(i),sample=[];
      for(let j=0;j<vertices.length;j+=16) sample.push(vertices[j],vertices[j+1]);
      return sample;
    });
    window.__restMesh=window.__sampleMesh();
  });
  await page.waitForTimeout(7000);
  const vitality=await page.evaluate(()=>{
    const frames=window.__vitalFrames,range=key=>Math.max(...frames.map(v=>v[key]))-Math.min(...frames.map(v=>v[key]));
    const mesh=window.__sampleMesh(),base=window.__restMesh;
    return {blinkMin:Math.min(...frames.map(v=>v.eye)),blinkMax:Math.max(...frames.map(v=>v.eye)),body:range('body'),gaze:range('gaze'),x:range('x'),y:range('y'),deformPixels:mesh.reduce((sum,v,i)=>sum+Math.abs(v-base[i]),0)/mesh.length*window.__stage.model.scale.x,blinkRig:!!window.__stage.model.internalModel.eyeBlink};
  });
  assert.ok(vitality.blinkRig && vitality.blinkMin<.2 && vitality.blinkMax>.8,'Nicole must automatically close and reopen her eyelids');
  assert.ok(vitality.body>1,'The actual custom torso rig must shift at rest');
  assert.ok(vitality.gaze>.03,'Gaze changes without pointer movement');
  assert.ok(vitality.x<.01 && vitality.y<.01 && vitality.deformPixels>.2,'Rest motion deforms the model, rather than sliding a static image');
  if(process.env.VTUBER_TEST_SCREENSHOT) await page.screenshot({path:process.env.VTUBER_TEST_SCREENSHOT+'.alive.png',omitBackground:true});
  console.log('PASS: autonomous eyelid blinking, custom body-rig deformation and gaze at rest, continuous body movement during speech without duplicate audio, independent hand/prop and facial layers, body actions on ordinary replies, minimal three-icon dock, continuous microphone renewal/two utterances/no echo, proactive AI voice/actions/cancellation, AI touch bursts, varied replies/context, bilingual speech and late-response cancellation, spontaneous idle poses/expressions, immediate touch interruption, idle toggle and nonrepeating routines, themes/preferences, reduced motion, mute, clipboard, pinned reply, voiced quick actions and touch sounds, voiced pose/expression sequences, no duplicate speech, stop action queue, non-overlapping bubbles at 640x520, reviewed screen context, screen cancel/denial, renderer retry and visible avatar pixels, 2048px atlases, no second model in controls, Indonesian text/Japanese speech, microphone icon, blocked playback does not block recording, reconnect status, local VOICEVOX WAV, explicit recording, interim transcript, one final → one reply, side bubble with hidden controls, emotion, lip sync, denial and cancellation.');
} finally {
  await browser?.close();
  server.kill();
  await rm(temporary,{recursive:true,force:true});
}
