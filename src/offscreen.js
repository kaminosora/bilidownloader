import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchInput, streamInput, createBudget } from './core/transfer.js';
import { MAX_INPUT_BYTES } from './core/media.js';
let current=null;
let temporaryRoot;
function tempDirectory(){
  if(!temporaryRoot)temporaryRoot=(async()=>{
    const root=await navigator.storage.getDirectory();
    const directory=await root.getDirectoryHandle('bili-local-temp',{create:true});
    // Only this extension's temporary directory is touched. A new offscreen
    // document cannot resume old Blob URLs, so remove leftovers after a crash.
    for await(const name of directory.keys())await directory.removeEntry(name,{recursive:true});
    return directory;
  })();
  return temporaryRoot;
}
const send=(type,payload)=>chrome.runtime.sendMessage({target:'background',type,payload});
async function requestSave(task){
  for(let attempt=0;attempt<3;attempt++){
    task.controller.signal.throwIfAborted();
    try{return await send('SAVE',{id:task.id,files:task.files});}
    catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,150));}
  }
}
function progress(task,status,value,message) {
  if(current!==task||task.controller.signal.aborted)return;
  task.snapshot={id:task.id,status,progress:value,message};
  const now=Date.now();if(now-task.lastUpdate>300||task.lastStatus!==status){task.lastUpdate=now;task.lastStatus=status;void send('PROGRESS',{job:task.snapshot}).catch(()=>{});}
}
async function run(task,plan) {
  const {signal}=task.controller;
  try {
    if(!Array.isArray(plan.inputs)||!plan.inputs.length)throw new Error('没有可下载的媒体。');
    if(plan.raw){
      const root=await tempDirectory();signal.throwIfAborted();
      task.tempName=`job-${task.id}`;task.tempRoot=root;
      const directory=await root.getDirectoryHandle(task.tempName,{create:true});
      const files=[];
      for(let i=0;i<plan.inputs.length;i++){
        signal.throwIfAborted();const input=plan.inputs[i];
        const handle=await directory.getFileHandle(`track-${i}`,{create:true});
        progress(task,'downloading',.9*i/plan.inputs.length,`下载原始轨 ${i+1}/${plan.inputs.length}`);
        await streamInput(input,{signal,openWritable:()=>handle.createWritable(),onProgress:(bytes,total)=>progress(task,'downloading',.9*(i+(total?bytes/total:0))/plan.inputs.length,`下载原始轨 ${i+1}/${plan.inputs.length} · ${(bytes/1048576).toFixed(1)} MiB`)});
        signal.throwIfAborted();
        const file=await handle.getFile();signal.throwIfAborted();
        // An extensionless OPFS File has an empty MIME type; Chrome otherwise
        // labels its Blob download text/plain. slice sets type without buffering.
        const url=URL.createObjectURL(file.slice(0,file.size,'application/octet-stream'));task.urls.push(url);files.push({url,filename:input.filename});
      }
      task.files=files;
    }else{
    if(plan.inputs.reduce((n,i)=>n+(Number(i.size)||0),0)>MAX_INPUT_BYTES)throw new Error('文件大小超过浏览器处理预算，请使用原始轨下载。');
    progress(task,'preparing',0,'加载本地音视频处理组件');
    const ffmpeg=task.ffmpeg=new FFmpeg();
    ffmpeg.on('progress',({progress:p})=>progress(task,'processing',.65+.3*Math.min(1,Math.max(0,p)),'本地处理音视频'));
    ffmpeg.on('log',({message})=>{task.logs.push(message);if(task.logs.length>8)task.logs.shift();});
    await ffmpeg.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')},{signal});
    const budget=createBudget();
    for(let i=0;i<plan.inputs.length;i++) {
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      const input=plan.inputs[i];
      progress(task,'downloading',.65*i/plan.inputs.length,`下载媒体 ${i+1}/${plan.inputs.length}`);
      const data=await fetchInput(input,{budget,signal,onProgress:(bytes,total)=>progress(task,'downloading',.65*(i+(total?bytes/total:0))/plan.inputs.length,`下载媒体 ${i+1}/${plan.inputs.length} · ${(bytes/1048576).toFixed(1)} MiB`)});
      await ffmpeg.writeFile(input.name,data,{signal});
    }
    if(plan.concat)await ffmpeg.writeFile('inputs.txt',new TextEncoder().encode(plan.concat),{signal});
    progress(task,'processing',.65,'本地处理音视频');
    const result=await ffmpeg.exec(plan.args,-1,{signal});
    if(result!==0)throw new Error('音视频处理失败；请尝试 MKV 或分别下载原始轨。');
    const data=await ffmpeg.readFile(plan.workingOutput,undefined,{signal});
    if(!data.byteLength)throw new Error('处理结果为空。');
    if(signal.aborted)throw new DOMException('Aborted','AbortError');
    const url=URL.createObjectURL(new Blob([data],{type:plan.outputMime}));task.urls.push(url);task.files=[{url,filename:plan.outputName}];
    ffmpeg.terminate();task.ffmpeg=null;
    }
    progress(task,'saving',.96,'保存到 Chrome 下载目录');
    const reply=await requestSave(task);
    if(!reply?.ok)throw new Error(reply?.error??'无法保存文件。');
  } catch(e) {
    if(!signal.aborted)await send('FAILED',{id:task.id,error:String(e?.message??e).slice(0,300)}).catch(()=>{});
    dispose(task);
  }
}
function dispose(task) {
  if(task.disposed)return;task.disposed=true;
  task.controller.abort();task.ffmpeg?.terminate();for(const url of task.urls)URL.revokeObjectURL(url);if(current===task)current=null;
  // Let pending writes finish aborting before deleting their directory. Waiting
  // here would deadlock a SAVE -> RELEASE round trip, so cleanup follows run().
  void task.work?.finally(async()=>{if(task.tempRoot&&task.tempName)await task.tempRoot.removeEntry(task.tempName,{recursive:true}).catch(()=>{});}).catch(()=>{});
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='offscreen'||sender.id!==chrome.runtime.id)return;
  const p=message.payload??{};
  if(message.type==='SNAPSHOT'){respond({ok:true,data:current?[{...current.snapshot,files:current.files}]:[]});return;}
  if(message.type==='CANCEL'||message.type==='RELEASE'){if(current?.id===p.id)dispose(current);respond({ok:true});return;}
  if(message.type==='RUN') {
    if(current){respond({ok:false,error:'已有媒体任务正在处理。'});return;}
    const task=current={id:p.id,controller:new AbortController(),snapshot:{id:p.id,status:'preparing',progress:0,message:'准备处理'},logs:[],urls:[],files:[],lastUpdate:0};
    respond({ok:true});task.work=run(task,p.plan);
  }
});
