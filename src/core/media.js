export const MEDIA_DOMAINS = ['bilivideo.com','bilivideo.cn','bilivideo.net','hdslb.com'];
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
export function isMediaUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:' && !u.username && !u.password && !u.port && MEDIA_DOMAINS.some(d=>u.hostname===d||u.hostname.endsWith(`.${d}`)); } catch { return false; }
}
export function sanitizeFilename(value) {
  let s=String(value??'未命名').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').replace(/^\.+/,'').replace(/[. ]+$/,'').trim().slice(0,150).replace(/[. ]+$/,'');
  if(!s) s='未命名';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s=`_${s}`;
  return s;
}
function urls(track) {
  const list=[...new Set(track.urls??[])];
  if(!list.length||list.some(url=>!isMediaUrl(url))) throw new Error('媒体地址无效或不在允许的 B 站媒体域名内。');
  return list;
}
function codec(track) { return String(track?.codec??'').toLowerCase(); }
function isAac(track) { return /mp4a|aac/.test(codec(track)); }
function mp4Audio(track) { return !track || /mp4a|aac|ec-3|ac-3|eac3|ac3/.test(codec(track)); }
function originalExt(track) {
  if(track.kind==='audio') return /audio\/flac/i.test(track.mime??'')?'flac':'m4a';
  return /\.flv(?:\?|$)/i.test(track.urls?.[0]??'')?'flv':'mp4';
}
export function planOutput(catalog,selection) {
  if(!catalog?.context || !selection || !['video','audio','raw'].includes(selection.mode)) throw new Error('下载参数无效。');
  const {mode,format='mp4'}=selection;
  const video=[...(catalog.videos??[]),...(catalog.progressive??[])].find(t=>t.key===selection.videoKey);
  const audio=(catalog.audios??[]).find(t=>t.key===selection.audioKey);
  if(selection.videoKey&&!video || selection.audioKey&&!audio) throw new Error('所选资源已变化，请重新选择画质或音轨。');
  const base=sanitizeFilename([catalog.context.title,catalog.context.partTitle].filter(Boolean).join(' - '));
  const inputs=[];const notes=[];
  function add(track,name) { inputs.push({name,urls:urls(track),size:track.size}); }
  function addProgressive(track) {
    if(track.segments?.length) track.segments.forEach((s,i)=>add(s,`segment-${i}.bin`));
    else add(track,'source.bin');
  }
  if(mode==='raw' || mode==='audio'&&format==='original') {
    const target=mode==='audio'?'audio':selection.rawTarget??'both';
    if(!['video','audio','both'].includes(target)) throw new Error('原始轨选择无效。');
    if(target!=='audio') { if(!video) throw new Error('请选择视频资源。'); video.kind==='progressive'?addProgressive(video):add(video,'video.m4s'); }
    if(target!=='video' && !(video?.kind==='progressive'&&target==='both')) {
      if(audio) add(audio,'audio.m4s');
      else if(mode==='audio'&&catalog.progressive?.length) throw new Error('此资源音画合一，请选择 M4A 或其他格式提取音频。');
      else if(target==='audio') throw new Error('当前资源没有独立音轨。');
    }
    if(!inputs.length) throw new Error('没有可下载资源。');
    inputs.forEach((i,n)=>{const a=i.name==='audio.m4s'; const t=a?audio:video; i.filename=`${base} - ${a?'音频轨':video?.kind==='progressive'?'原始视频':'视频轨（无声）'}${inputs.length>1?`-${n+1}`:''}.${originalExt(t)}`;});
    return {raw:true,inputs,outputName:inputs[0].filename,notes:['原始分离视频轨不包含声音；请同时保存音轨。']};
  }
  if(mode==='video'&&!['mp4','mkv'].includes(format) || mode==='audio'&&!['m4a','mp3','wav','flac'].includes(format)) throw new Error('输出格式无效。');
  const args=['-hide_banner','-y'];let concat;
  const source=mode==='video'?video:audio??(video?.kind==='progressive'?video:catalog.progressive?.[0]);
  if(!source) throw new Error('没有选中的媒体资源，请重新加载。');
  if(source.kind==='progressive') {
    addProgressive(source);
    if(inputs.length>1) { concat=inputs.map(i=>`file '${i.name}'`).join('\n'); args.push('-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i','inputs.txt'); }
    else args.push('-protocol_whitelist','file,pipe','-i',inputs[0].name);
  } else { add(source,mode==='video'?'video.m4s':'audio.m4s'); args.push('-protocol_whitelist','file,pipe','-i',inputs[0].name); }
  if(mode==='video') {
    if(format==='mp4'&&!mp4Audio(audio)) throw new Error('此音轨不适合无损封装为 MP4，请选择 MKV。');
    if(audio && source.kind!=='progressive') { add(audio,'audio.m4s'); args.push('-protocol_whitelist','file,pipe','-i','audio.m4s','-map','0:v:0','-map','1:a:0'); }
    else args.push('-map','0:v:0','-map','0:a?');
    args.push('-c','copy');
    if(format==='mp4'&&/hevc|hev1|hvc1/.test(codec(source)))args.push('-tag:v','hvc1');
  } else {
    args.push('-map','0:a:0','-vn');
    if(format==='m4a') { if(isAac(source))args.push('-c:a','copy');else {args.push('-c:a','aac','-b:a','256k');notes.push('将源音轨转换为 AAC，属于有损转换。');} }
    if(format==='mp3') {args.push('-c:a','libmp3lame','-b:a','320k');notes.push('MP3 是有损转换。');}
    if(format==='wav')args.push('-c:a','pcm_s16le');
    if(format==='flac')args.push('-c:a','flac');
    if(['wav','flac'].includes(format))notes.push('转换不会提升源音质。');
  }
  if(['mp4','m4a'].includes(format))args.push('-movflags','+faststart');
  const workingOutput=`output.${format}`;args.push(workingOutput);
  const label=mode==='video'?[source.qualityLabel??source.quality,source.codec].filter(Boolean).join(' '):source.audioRole??source.codec??'音频';
  return {raw:false,inputs,args,concat,workingOutput,outputName:`${base} - ${sanitizeFilename(label||mode)}.${format}`,outputMime:({mp4:'video/mp4',mkv:'video/x-matroska',m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac'})[format],duration:catalog.context.duration,notes};
}
export function ffmpegArgs(plan) { return [...plan.args]; }
