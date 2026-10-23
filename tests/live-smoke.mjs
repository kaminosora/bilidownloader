// Optional anonymous real-network check; never reads an existing Chrome profile.
import path from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.cache/ms-playwright');
const {chromium}=await import('playwright');
const resultDir=path.resolve('test-results'),profile=path.join(resultDir,`live-profile-${Date.now()}`),downloads=path.join(resultDir,'live-downloads');
await mkdir(downloads,{recursive:true});
const extension=path.resolve('dist');
const report={at:new Date().toISOString(),authenticated:false,page:'https://www.bilibili.com/video/BV13x41117TL',checks:[],files:[]};
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,downloadsPath:downloads,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
try{
  const sw=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/tasks.html`);
  const send=(type,payload={})=>page.evaluate(async({type,payload})=>{const r=await chrome.runtime.sendMessage({target:'background',type,payload});if(!r?.ok)throw new Error(r?.error);return r.data;},{type,payload});
  const c=await send('CATALOG',{url:report.page});
  report.catalog={videos:c.videos.map(v=>({quality:v.quality,codec:v.codec})),audios:c.audios.map(a=>({codec:a.codec,bandwidth:a.bandwidth})),duration:c.context.duration};report.checks.push('anonymous extension API catalog');
  const v=[...c.videos].sort((a,b)=>a.bandwidth-b.bandwidth)[0],a=[...c.audios].sort((a,b)=>a.bandwidth-b.bandwidth)[0];
  const selection={videoKey:v.key,audioKey:a.key,quality:v.quality};
  for(const mode of ['raw','video']){
    const job=await send('ENQUEUE',{url:report.page,selection:{...selection,mode,rawTarget:'both',format:mode==='raw'?'original':'mp4'}});
    let done;
    for(let i=0;i<360;i++){
      const j=(await send('JOBS')).find(j=>j.id===job.id);
      if(j?.status==='completed'){done=j;break;}
      if(['failed','interrupted'].includes(j?.status))throw new Error(j.error??j.message);
      await delay(500);
    }
    if(!done)throw new Error(`${mode} media download timed out`);
    const records=await page.evaluate(async ids=>(await Promise.all(ids.map(id=>chrome.downloads.search({id})))).flat(),done.downloadIds);
    if(records.length!==(mode==='raw'?2:1))throw new Error('Unexpected output count');
    for(const record of records){
      if(!path.resolve(record.filename).startsWith(downloads+path.sep))throw new Error('Download outside test directory');
      const bytes=(await stat(record.filename)).size;
      const decoded=spawnSync(process.env.FFMPEG_TEST_BINARY??'ffmpeg',['-hide_banner','-v','error','-i',record.filename,'-f','null','-'],{encoding:'utf8'});
      if(decoded.status!==0)throw new Error(decoded.stderr??String(decoded.error));
      report.files.push({mode,bytes,state:record.state});
    }
    report.checks.push(mode==='raw'?'OPFS original video and audio save and decode':'real-site video and audio mux in bundled WASM, save and decode');
  }
  report.success=true;report.browser=await context.browser().version();
}catch(e){report.success=false;report.error=String(e.message??e).replace(/https?:\/\/\S+/g,'[media URL]');process.exitCode=1;}
finally{console.log(JSON.stringify(report,null,2));await writeFile(path.join(resultDir,'live-report.json'),JSON.stringify(report,null,2));await context.close();}
