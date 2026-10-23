export const TERMINAL = new Set(['completed','failed','cancelled','interrupted']);
export const isActive = job => !TERMINAL.has(job.status)&&job.status!=='queued';
export function addJob(jobs,request,id=crypto.randomUUID()) {
  if(jobs.filter(j=>j.status==='queued').length>=5)throw new Error('队列已满（最多等待 5 个任务），请稍后再试。');
  const job={id,url:request.url,selection:request.selection,title:'等待解析资源',status:'queued',progress:0,message:'等待前一个任务完成',createdAt:Date.now(),downloadIds:[]};jobs.push(job);return job;
}
export function updateJob(job,patch) {
  if(!job||TERMINAL.has(job.status))return false;
  Object.assign(job,patch);job.progress=Math.min(1,Math.max(0,Number(job.progress)||0));return true;
}
export function reconcileJobs(jobs,live=[]) {
  for(const job of jobs)if(isActive(job)) {
    const snapshot=live.find(j=>j.id===job.id);
    if(snapshot)updateJob(job,snapshot);
    else updateJob(job,{status:'interrupted',error:'浏览器处理已中断，请重新选择资源开始下载。',message:'任务已中断'});
  }
  return jobs;
}
export function publicJobs(jobs) {
  return jobs.map(({id,title,status,progress,message,createdAt,downloadIds,error})=>({id,title,status,progress,message,createdAt,downloadIds,error})).reverse();
}
export function downloadState(job,entries) {
  if(entries.length!==job.downloadIds.length)return {status:'interrupted',message:'下载记录丢失，请重新开始。'};
  if(entries.some(d=>/text\/|json/i.test(d.mime??'')))return {status:'failed',message:'下载内容无效',error:'服务器返回了错误页面，请刷新资源后重试。'};
  const bad=entries.find(d=>d.state==='interrupted');
  if(bad)return {status:'failed',error:`Chrome 下载中断（${bad.error??'网络或用户取消'}），请重新获取资源后再试。`,message:'下载中断'};
  if(entries.length===(job.expectedDownloads??1)&&entries.every(d=>d.state==='complete'))return {status:'completed',progress:1,message:'已保存到 Chrome 下载目录'};
  const total=entries.reduce((n,d)=>n+Math.max(0,d.totalBytes),0),received=entries.reduce((n,d)=>n+d.bytesReceived,0);
  return {status:'saving',progress:total?Math.min(.99,received/total):job.progress,message:'Chrome 正在保存文件'};
}
