import { resolveMedia, getCatalog, parsePageUrl } from './core/bilibili.js';
import { planOutput, MEDIA_DOMAINS, sanitizeFilename } from './core/media.js';
import { addJob, updateJob, reconcileJobs, publicJobs, isActive, TERMINAL, downloadState } from './core/jobs.js';
let jobs=[],bootPromise,creatingOffscreen,pumping=false,saveTail=Promise.resolve();
const preparing=new Map(),saving=new Map();
const extensionRoot=chrome.runtime.getURL('');
const offscreenUrl=chrome.runtime.getURL('offscreen.html');
const errorText=e=>String(e?.message??e).replace(/https?:\/\/\S+/g,'[媒体地址]').slice(0,350);
function persist(){const snapshot=jobs.map(({id,url,selection,title,status,progress,message,createdAt,downloadIds,expectedDownloads,error})=>({id,url,selection,title,status,progress,message,createdAt,downloadIds:[...downloadIds],expectedDownloads,error}));saveTail=saveTail.catch(()=>{}).then(()=>chrome.storage.local.set({jobs:snapshot}));return saveTail;}
async function cleanup(job){
  preparing.get(job.id)?.abort();
  if(job.status!=='completed')await Promise.all((job.downloadIds??[]).map(id=>chrome.downloads.cancel(id).catch(()=>{})));
  if(await offscreenExists())await offscreen('RELEASE',{id:job.id}).catch(()=>{});
}
async function offscreenExists(){return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[offscreenUrl]})).length>0;}
async function offscreen(type,payload={}){return chrome.runtime.sendMessage({target:'offscreen',type,payload});}
async function ensureOffscreen(){
  if(await offscreenExists())return;
  if(!creatingOffscreen)creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'在本地下载媒体、合并音视频并生成供用户保存的文件。'}).finally(()=>{creatingOffscreen=null;});
  await creatingOffscreen;
}
async function setupRules(){
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1],addRules:[{id:1,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:'https://www.bilibili.com/'}]},condition:{initiatorDomains:[chrome.runtime.id],requestDomains:['api.bilibili.com',...MEDIA_DOMAINS],resourceTypes:['xmlhttprequest','media','other']}}]});
}
async function refreshDownloads(job){
  if(!job.downloadIds?.length)return false;
  const ids=[...job.downloadIds];
  const entries=(await Promise.all(ids.map(id=>chrome.downloads.search({id})))).flat();
  if(ids.length!==job.downloadIds.length||ids.some((id,i)=>id!==job.downloadIds[i]))return false;
  updateJob(job,downloadState(job,entries));
  return true;
}
async function boot(){
  if(!bootPromise)bootPromise=(async()=>{
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    await setupRules();
    jobs=(await chrome.storage.local.get('jobs')).jobs??[];
    const session=(await chrome.storage.session.get('alive')).alive;
    await chrome.storage.session.set({alive:true});
    if(!session)for(const job of jobs.filter(j=>!TERMINAL.has(j.status)))updateJob(job,{status:'interrupted',message:'上次浏览器会话已结束，请重新开始。'});
    let live=[];if(await offscreenExists()){const r=await offscreen('SNAPSHOT');live=r?.data??[];}
    for(const snapshot of live)if(snapshot.files?.length){const job=jobs.find(j=>j.id===snapshot.id);if(job&&!TERMINAL.has(job.status))await saveFiles(job,snapshot.files);}
    for(const job of jobs.filter(isActive)){
      if(job.downloadIds.length&&(job.expectedDownloads??1)>job.downloadIds.length&&!live.some(s=>s.id===job.id&&s.files?.length))updateJob(job,{status:'interrupted',message:'保存过程已中断，请重试。'});
      else if(await refreshDownloads(job))live.push({...job});
    }
    reconcileJobs(jobs,live);
    for(const job of jobs.filter(j=>TERMINAL.has(j.status)))await cleanup(job);
    for(const snapshot of live)if(!jobs.some(j=>j.id===snapshot.id&&isActive(j)))await offscreen('RELEASE',{id:snapshot.id}).catch(()=>{});
    await persist();queueMicrotask(()=>void pump());
  })().catch(e=>{bootPromise=null;throw e;});
  return bootPromise;
}
async function finish(job,patch){
  if(!updateJob(job,patch))return;
  if(TERMINAL.has(job.status))await cleanup(job);
  await persist();void pump();
}
// The live offscreen document owns file URLs. Match them during recovery before
// dispatching a missing save, including a worker exit between download() and persist().
async function saveFiles(job,files){
  if(saving.has(job.id))return saving.get(job.id);
  const operation=(async()=>{
    if(!Array.isArray(files)||!files.length||files.some(f=>!f.url?.startsWith(`blob:${extensionRoot}`)||typeof f.filename!=='string'))throw new Error('无效的本地文件地址。');
    job.expectedDownloads=files.length;
    updateJob(job,{status:'saving',progress:.96,message:'Chrome 正在保存文件'});await persist();
    try{
      for(let i=0;i<files.length;i++){
        if(TERMINAL.has(job.status))break;
        if(job.downloadIds[i]!==undefined)continue;
        const f=files[i],existing=await chrome.downloads.search({url:f.url});
        const id=existing[0]?.id??await chrome.downloads.download({url:f.url,filename:`BiliLocal/${sanitizeFilename(f.filename.replace(/\.[^.]+$/,''))}.${f.filename.split('.').pop()}`,conflictAction:'uniquify',saveAs:false});
        job.downloadIds[i]=id;await persist();
        if(TERMINAL.has(job.status))await chrome.downloads.cancel(id).catch(()=>{});
      }
      if(!TERMINAL.has(job.status))await refreshDownloads(job);
      if(TERMINAL.has(job.status))await cleanup(job);
      await persist();
    }catch(e){await finish(job,{status:'failed',message:'文件保存失败',error:errorText(e)});}
  })();
  saving.set(job.id,operation);try{await operation;}finally{saving.delete(job.id);}
}
async function catalogFor(url,quality){parsePageUrl(url);const context=await resolveMedia(url);return getCatalog(context,{quality});}
async function pump(){
  if(pumping||jobs.some(isActive))return;
  const job=jobs.find(j=>j.status==='queued');if(!job)return;
  pumping=true;
  const controller=new AbortController();preparing.set(job.id,controller);const {signal}=controller;
  try {
    updateJob(job,{status:'preparing',message:'重新获取当前账号可用的媒体链接'});await persist();
    // Resolve the selected quality again rather than reusing expiring links from the panel.
    const context=await resolveMedia(job.url,{signal});
    signal.throwIfAborted();
    let catalog=await getCatalog(context,{signal});
    const key=job.selection.videoKey;
    if(key&&![...catalog.videos,...catalog.progressive].some(t=>t.key===key)) {
      // Stable keys come from the API module; quality is also captured explicitly on enqueue.
      if(job.selection.quality)catalog=await getCatalog(context,{quality:job.selection.quality,signal});
    }
    if(TERMINAL.has(job.status))return;
    const plan=planOutput(catalog,job.selection);
    updateJob(job,{title:[context.title,context.partTitle].filter(Boolean).join(' · ')});await persist();
    await ensureOffscreen();
    if(TERMINAL.has(job.status))return;
    const r=await offscreen('RUN',{id:job.id,plan,title:job.title});if(!r?.ok)throw new Error(r?.error??'无法启动本地处理。');
  } catch(e){await finish(job,{status:'failed',error:errorText(e),message:'任务失败'});}
  finally {preparing.delete(job.id);pumping=false;if(!jobs.some(isActive))void pump();}
}
function trusted(sender){return sender.id===chrome.runtime.id&&(sender.url?.startsWith(extensionRoot)||/^https:\/\/www\.bilibili\.com\//.test(sender.url??''));}
async function handle(message,sender){
  if(!trusted(sender))throw new Error('不允许的消息来源。');
  await boot();const p=message.payload??{};
  if(['PROGRESS','SAVE','FAILED'].includes(message.type)){
    if(sender.url!==offscreenUrl)throw new Error('仅允许本地处理页面更新任务。');
    const job=jobs.find(j=>j.id===(p.id??p.job?.id));
    if(!job||TERMINAL.has(job.status))throw new Error('任务已结束。');
    if(message.type==='PROGRESS'){updateJob(job,{status:p.job.status,progress:p.job.progress,message:p.job.message});await persist();return;}
    if(message.type==='FAILED'){await finish(job,{status:'failed',error:errorText(p.error),message:'本地处理失败'});return;}
    await saveFiles(job,p.files);void pump();
    return;
  }
  if(message.type==='CATALOG')return catalogFor(p.url,p.quality);
  if(message.type==='ENQUEUE'){
    parsePageUrl(p.url);
    if(!p.selection||!['video','audio','raw'].includes(p.selection.mode))throw new Error('下载参数无效。');
    const selection=Object.fromEntries(['mode','videoKey','audioKey','format','rawTarget','quality'].filter(k=>p.selection[k]!==undefined).map(k=>[k,p.selection[k]]));
    const job=addJob(jobs,{url:p.url,selection});jobs=jobs.filter(j=>!TERMINAL.has(j.status)).concat(jobs.filter(j=>TERMINAL.has(j.status)).slice(-40)).sort((a,b)=>a.createdAt-b.createdAt);
    await persist();void pump();return publicJobs([job])[0];
  }
  if(message.type==='JOBS'){
    for(const job of jobs.filter(isActive))if(job.downloadIds.length){await refreshDownloads(job);if(TERMINAL.has(job.status))await cleanup(job);}
    await persist();void pump();return publicJobs(jobs);
  }
  if(message.type==='SHOW_DOWNLOAD_FOLDER'){
    const job=jobs.find(j=>j.id===p.id);
    if(!job?.downloadIds?.length)throw new Error('该任务还没有已保存的文件。');
    // Only recorded IDs belonging to this task are accepted, never caller paths.
    const records=(await Promise.all(job.downloadIds.map(id=>chrome.downloads.search({id})))).flat();
    const file=records.find(d=>d.state==='complete'&&d.exists!==false);
    if(!file){
      if(records.some(d=>d.state==='in_progress'))throw new Error('文件尚未保存完成，请稍后再打开所在文件夹。');
      throw new Error('下载记录已清除，或文件已被移动、删除；请在 Chrome 下载记录中检查。');
    }
    try{await chrome.downloads.show(file.id);}catch{throw new Error('无法打开所在文件夹，请在 Chrome 下载记录中定位文件。');}
    return;
  }
  if(message.type==='CANCEL'){const job=jobs.find(j=>j.id===p.id);await finish(job,{status:'cancelled',message:'已取消',error:undefined});return;}
  if(message.type==='RETRY'){
    const old=jobs.find(j=>j.id===p.id);
    if(!old||!TERMINAL.has(old.status))throw new Error('只能重试已结束的任务。');
    const job=addJob(jobs,{url:old.url,selection:old.selection});await persist();void pump();return publicJobs([job])[0];
  }
  if(message.type==='OPEN_TASKS'){await chrome.tabs.create({url:chrome.runtime.getURL('tasks.html')});return;}
  if(message.type==='OPEN_PANEL'){
    const tab=p.tabId?await chrome.tabs.get(p.tabId):(await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if(!tab?.id)throw new Error('没有当前标签页。');
    try{return await chrome.tabs.sendMessage(tab.id,{type:'OPEN_PANEL',target:'content'});}catch{throw new Error('请打开 B 站视频页并刷新一次，再打开下载面板。');}
  }
  throw new Error('不支持的操作。');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='background')return;
  handle(message,sender).then(data=>respond({ok:true,data}),e=>respond({ok:false,error:errorText(e)}));return true;
});
chrome.downloads.onChanged.addListener(delta=>{
  if(!delta.state&&!delta.error)return;
  void boot().then(async()=>{
    const job=jobs.find(j=>isActive(j)&&j.downloadIds.includes(delta.id));if(!job)return;
    await refreshDownloads(job);
    if(TERMINAL.has(job.status))await cleanup(job);
    await persist();void pump();
  }).catch(()=>{});
});
chrome.runtime.onInstalled.addListener(()=>void boot().catch(()=>{}));
chrome.runtime.onStartup.addListener(()=>void boot().catch(()=>{}));
