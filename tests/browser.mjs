import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { interceptOffscreen } from './cdp-background.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.cache/ms-playwright');
const { chromium }=await import('playwright');
const root=path.resolve('.'),results=path.join(root,'test-results');
const profile=path.join(results,`profile-${Date.now()}`),downloadDir=path.join(results,'downloads');
await mkdir(path.join(profile,'Default'),{recursive:true});await mkdir(downloadDir,{recursive:true});
await mkdir(path.join(results,'artifacts'),{recursive:true});
await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false,directory_upgrade:true}}));
const video=await readFile('tests/fixtures/video.mp4'),audio=await readFile('tests/fixtures/audio.m4a');
const report={startedAt:new Date().toISOString(),tests:[],errors:[],outputs:[]};
const pageUrl='https://www.bilibili.com/video/BV1234567890';
const fixtureHost='https://upos-test.bilivideo.com';
let delayed=false,failMedia=false,apiGate,apiPaused=false;
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,downloadsPath:downloadDir,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${path.join(root,'dist')}`,`--load-extension=${path.join(root,'dist')}`]});
const errors=[];context.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const network=[];context.on('request',r=>network.push({event:'request',url:r.url()}));context.on('requestfailed',r=>network.push({event:'failed',url:r.url(),failure:r.failure()}));
const checks=async(name,fn)=>{await fn();report.tests.push(name);console.log(`PASS ${name}`);};
async function until(fn,timeout=60000){const start=Date.now();let last;while(Date.now()-start<timeout){last=await fn();if(last)return last;await delay(150);}throw new Error(`Timed out after ${timeout}ms; ${JSON.stringify(last)}`);}
try {
  const offscreenRoute=await interceptOffscreen(context.browser(),async request=>{
    if(delayed)await delay(1500);
    if(failMedia)return {status:403,body:'denied'};
    const body=request.url.endsWith('.m4a')?audio:video;
    return {headers:{'Content-Type':'application/octet-stream','Content-Length':body.length},body};
  },errors);
  await context.route('https://www.bilibili.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><title>测试视频 - Bilibili</title></head><body style="background:#f4f5f7;font-family:sans-serif;padding:32px"><h1>合成测试视频</h1><div style="height:500px;background:#151922;color:white;display:grid;place-items:center">受控测试页面 · 无用户数据</div></body></html>'}));
  await context.route('https://api.bilibili.com/**',async route=>{
    const u=new URL(route.request().url());let data;
    if(apiGate&&u.pathname==='/x/web-interface/view'){const wait=apiGate;apiGate=null;apiPaused=true;await wait;}
    if(u.pathname==='/x/web-interface/view')data={code:0,data:{bvid:'BV1234567890',aid:1,title:'合成测试视频',duration:1.2,pages:[{cid:11,page:1,part:'第一段',duration:1.2},{cid:22,page:2,part:'第二段',duration:1.2}]}};
    else if(u.pathname==='/x/web-interface/nav')data={code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}};
    else if(u.pathname.includes('playurl'))data={code:0,data:{quality:80,timelength:1200,accept_quality:[120,80,32],accept_description:['4K（不可用）','1080P','480P'],dash:{video:[{id:80,codecs:'avc1.640028',mimeType:'video/mp4',baseUrl:`${fixtureHost}/video.mp4`,bandwidth:800000,width:1920,height:1080,frameRate:'10'},{id:32,codecs:'avc1.640028',mimeType:'video/mp4',baseUrl:`${fixtureHost}/video.mp4`,bandwidth:200000,width:640,height:480,frameRate:'10'}],audio:[{id:30280,codecs:'mp4a.40.2',mimeType:'audio/mp4',baseUrl:`${fixtureHost}/audio.m4a`,bandwidth:128000}]}}};
    else throw new Error(`Unexpected API ${u.pathname}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await context.route(`${fixtureHost}/**`,async route=>{
    if(delayed)await delay(1500);
    if(failMedia)return route.fulfill({status:403,body:'denied'});
    const body=route.request().url().endsWith('.m4a')?audio:video;
    await route.fulfill({contentType:'application/octet-stream',headers:{'Content-Length':String(body.length)},body});
  });
  let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  const taskPage=await context.newPage();await taskPage.goto(`chrome-extension://${extensionId}/tasks.html`);
  await taskPage.evaluate(()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Controlled media integration test'}));
  await offscreenRoute.attach();
  const send=(type,payload={})=>taskPage.evaluate(async({type,payload})=>{const r=await chrome.runtime.sendMessage({target:'background',type,payload});if(!r?.ok)throw new Error(r?.error??'No extension response');return r.data;},{type,payload});
  const page=await context.newPage();await page.goto(pageUrl);
  await checks('extension injects panel and loads actual available qualities',async()=>{
    await page.locator('#bili-launcher').click();await page.locator('#bili-panel[data-state="ready"]').waitFor({timeout:30000});
    assert.equal(await page.locator('#bili-quality option[value="120"]:not([disabled])').count(),0);
    assert.equal(await page.locator('#bili-video option').count(),1);
  });
  await checks('quality and part changes select the requested resource',async()=>{
    await page.locator('#bili-quality').selectOption('32');await page.locator('#bili-panel[data-state="ready"]').waitFor();
    assert.match(await page.locator('#bili-video').inputValue(),/^video:32:/);
    await page.locator('#bili-part').selectOption(`${pageUrl}?p=2`);await page.locator('#bili-panel[data-state="ready"]').waitFor();assert.match(await page.locator('#bili-part').inputValue(),/p=2$/);
  });
  const catalog=await send('CATALOG',{url:pageUrl});
  const selection={mode:'video',videoKey:catalog.videos[0].key,audioKey:catalog.audios[0].key,format:'mp4',quality:80};
  async function waitJob(id){return until(async()=>{const j=(await send('JOBS')).find(j=>j.id===id);if(j?.status==='failed'||j?.status==='interrupted'){const records=await taskPage.evaluate(async ids=>(await Promise.all(ids.map(id=>chrome.downloads.search({id})))).flat().map(({id,mime,state,error,bytesReceived})=>({id,mime,state,error,bytesReceived})),j.downloadIds);throw new Error(`${j.status}: ${j.error??j.message} ${JSON.stringify(records)}`);}return j?.status==='completed'?j:false;},120000);}
  async function output(job){const downloads=await taskPage.evaluate(async ids=>(await Promise.all(ids.map(id=>chrome.downloads.search({id})))).flat(),job.downloadIds);for(const d of downloads){assert.ok(path.resolve(d.filename).startsWith(downloadDir+path.sep),d.filename);const b=await readFile(d.filename);assert.ok(b.length>500);const saved=path.join(results,'artifacts',`${job.id}-${d.id}.bin`);await copyFile(d.filename,saved);const decoded=spawnSync(process.env.FFMPEG_TEST_BINARY??'ffmpeg',['-hide_banner','-v','error','-i',saved,'-f','null','-'],{encoding:'utf8'});assert.equal(decoded.status,0,decoded.stderr??String(decoded.error));report.outputs.push(saved);}return downloads;}
  await checks('real packaged FFmpeg WASM muxes MP4 and saves completed download',async()=>{
    await page.locator('#bili-download').click();const job=await until(async()=>(await send('JOBS'))[0]);const done=await waitJob(job.id);await output(done);
  });
  for(const format of ['mkv','m4a','mp3','wav','flac'])await checks(`real WASM exports ${format}`,async()=>{
    const job=await send('ENQUEUE',{url:pageUrl,selection:{...selection,mode:format==='mkv'?'video':'audio',format}});await output(await waitJob(job.id));
  });
  const rawSelection={...selection,mode:'raw',format:'original',rawTarget:'both'};
  await checks('original tracks stream through OPFS, both save and temporary files are removed',async()=>{
    const job=await send('ENQUEUE',{url:pageUrl,selection:rawSelection});const done=await waitJob(job.id);assert.equal(done.downloadIds.length,2);await output(done);
    await until(()=>taskPage.evaluate(async()=>{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('bili-local-temp');return !(await Array.fromAsync(dir.keys())).length;}));
  });
  await checks('cancellation interrupts metadata preparation and immediately advances the queue',async()=>{
    let release;apiGate=new Promise(resolve=>{release=resolve;});apiPaused=false;
    try{
      const job=await send('ENQUEUE',{url:pageUrl,selection});await until(()=>apiPaused);
      const next=await send('ENQUEUE',{url:pageUrl,selection:rawSelection});
      await send('CANCEL',{id:job.id});await output(await waitJob(next.id));
      assert.equal((await send('JOBS')).find(j=>j.id===job.id).status,'cancelled');
    }finally{release();}
  });
  await checks('worker exit during first native save recovers both raw tracks without duplicates',async()=>{
    worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js'));
    await worker.evaluate(()=>{const original=chrome.downloads.download.bind(chrome.downloads);let first=true;globalThis.savePaused=false;chrome.downloads.download=async options=>{const id=await original(options);if(first){first=false;globalThis.savePaused=true;await new Promise(()=>{});}return id;};});
    const job=await send('ENQUEUE',{url:pageUrl,selection:rawSelection});
    await until(()=>worker.evaluate(()=>globalThis.savePaused));
    const session=await context.newCDPSession(taskPage);await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
    const done=await waitJob(job.id);assert.equal(done.downloadIds.length,2);await output(done);await session.detach();
    const urls=await taskPage.evaluate(async ids=>(await Promise.all(ids.map(id=>chrome.downloads.search({id})))).flat().map(d=>d.url),done.downloadIds);
    for(const url of urls)assert.equal(await taskPage.evaluate(async url=>(await chrome.downloads.search({url})).length,url),1);
  });
  await checks('cancellation terminates transfer and a following job succeeds',async()=>{
    delayed=true;const job=await send('ENQUEUE',{url:pageUrl,selection});
    await until(async()=>{const j=(await send('JOBS')).find(x=>x.id===job.id);return j?.status==='downloading';});
    await send('CANCEL',{id:job.id});assert.equal((await send('JOBS')).find(j=>j.id===job.id).status,'cancelled');
    delayed=false;const next=await send('ENQUEUE',{url:pageUrl,selection:{...selection,mode:'audio',format:'mp3'}});await output(await waitJob(next.id));
  });
  await checks('HTTP failure is visible and retry refreshes source and succeeds',async()=>{
    failMedia=true;const job=await send('ENQUEUE',{url:pageUrl,selection});await until(async()=>{const j=(await send('JOBS')).find(x=>x.id===job.id);return j?.status==='failed';});
    failMedia=false;const retry=await send('RETRY',{id:job.id});await output(await waitJob(retry.id));
  });
  await checks('service worker restart reconnects to the running offscreen job',async()=>{
    delayed=true;const job=await send('ENQUEUE',{url:pageUrl,selection});
    await until(async()=>(await send('JOBS')).find(x=>x.id===job.id)?.status==='downloading');
    const session=await context.newCDPSession(taskPage);await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
    delayed=false;await output(await waitJob(job.id));await session.detach();
  });
  await checks('SPA navigation updates the current part without duplicate panels',async()=>{
    await page.evaluate(()=>history.pushState({},'','?p=2'));await until(async()=>await page.locator('#bili-part').inputValue()===`${pageUrl}?p=2`);
    assert.equal(await page.locator('#bili-local-downloader').count(),1);
  });
  await checks('both task surfaces reveal their own saved download through the Chrome API',async()=>{
    // Native Explorer windows cannot be asserted in headless Chrome. Intercept
    // only the final OS-facing API; job lookup, messaging and UI stay real.
    worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js'));
    await worker.evaluate(()=>{globalThis.originalShow=chrome.downloads.show;globalThis.revealed=[];chrome.downloads.show=id=>{globalThis.revealed.push(id);};});
    const job=(await send('JOBS')).find(j=>j.status==='completed');
    const selector=`[data-job-id="${job.id}"] .folder-button`;
    await taskPage.bringToFront();await taskPage.locator(selector).click();
    await until(()=>worker.evaluate(()=>globalThis.revealed.length===1));
    await page.bringToFront();await page.locator(selector).click();
    await until(()=>worker.evaluate(()=>globalThis.revealed.length===2));
    assert.deepEqual(await worker.evaluate(()=>globalThis.revealed),[job.downloadIds[0],job.downloadIds[0]]);
  });
  await checks('folder errors remain visible across job polling and can be retried',async()=>{
    await worker.evaluate(()=>{chrome.downloads.show=()=>{throw new Error('test native failure');};});
    const job=(await send('JOBS')).find(j=>j.status==='completed');
    const card=page.locator(`[data-job-id="${job.id}"]`);
    await card.locator('.folder-button').click();
    await card.locator('.job-folder-feedback:not([hidden])').waitFor();
    await delay(1500);assert.match(await card.locator('.job-folder-feedback').innerText(),/无法打开/);
    await worker.evaluate(()=>{chrome.downloads.show=id=>globalThis.revealed.push(id);});
    await card.locator('.folder-button').click();
    await until(()=>card.locator('.job-folder-feedback:not([hidden])').count().then(n=>n===0));
    await worker.evaluate(()=>{chrome.downloads.show=globalThis.originalShow;});
  });
  await page.screenshot({path:path.join(results,'panel.png')});
  await taskPage.screenshot({path:path.join(results,'tasks.png'),fullPage:true});
  const storage=await taskPage.evaluate(()=>chrome.storage.local.get(null));
  assert.ok(!JSON.stringify(storage).includes(fixtureHost),'signed media URLs must not be persisted');
  report.tests.push('persistent storage contains no media URLs');
  report.browser=await context.browser().version();report.errors=errors;
}catch(e){report.failure=e.stack;report.network=network;report.errors=errors;const cdp=await context.browser().newBrowserCDPSession();report.targets=await cdp.send('Target.getTargets');throw e;}
finally {report.finishedAt=new Date().toISOString();await writeFile(path.join(results,'browser-report.json'),JSON.stringify(report,null,2));await context.close();}
