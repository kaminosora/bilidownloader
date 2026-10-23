import test from 'node:test';
import assert from 'node:assert/strict';
import { isMediaUrl, sanitizeFilename, planOutput } from '../src/core/media.js';
const video = {key:'v',kind:'video',quality:80,qualityLabel:'1080P',codec:'avc1.640028',urls:['https://a.bilivideo.com/v.m4s']};
const audio = {key:'a',kind:'audio',codec:'mp4a.40.2',audioRole:'AAC',urls:['https://a.bilivideo.com/a.m4s']};
const catalog = {context:{title:'测试/视频',partTitle:'P1',duration:2},videos:[video],audios:[audio],progressive:[]};
test('media URLs reject spoofed domains, credentials, HTTP and nonstandard ports',()=>{
  for (const url of ['https://a.bilivideo.com/v','https://x.bilivideo.cn/v']) assert.equal(isMediaUrl(url),true);
  for (const url of ['http://a.bilivideo.com/v','https://bilivideo.com.evil.test/v','https://x@a.bilivideo.com/v','https://a.bilivideo.com:444/v','file:///v','https://127.0.0.1/v']) assert.equal(isMediaUrl(url),false,url);
});
test('filenames cannot escape download directory or use reserved Windows names',()=>{
  assert.equal(sanitizeFilename('../A:*?"<>|\\B. '),'_A________B');
  assert.equal(sanitizeFilename('CON'),'_CON');
  assert.ok(sanitizeFilename('名'.repeat(300)).length <= 150);
});
test('video mux explicitly maps chosen audio and preserves original video codec',()=>{
  const p=planOutput(catalog,{mode:'video',videoKey:'v',audioKey:'a',format:'mp4'});
  assert.deepEqual(p.inputs.map(x=>x.name),['video.m4s','audio.m4s']);
  assert.ok(p.args.includes('copy')); assert.ok(p.args.includes('1:a:0'));
  assert.match(p.outputName,/\.mp4$/); assert.equal(p.raw,false);
});
test('FLAC audio in MP4 fails with actionable compatible-container error',()=>{
  const c={...catalog,audios:[{...audio,codec:'fLaC'}]};
  assert.throws(()=>planOutput(c,{mode:'video',videoKey:'v',audioKey:'a',format:'mp4'}),/MKV/);
  assert.ok(planOutput(c,{mode:'video',videoKey:'v',audioKey:'a',format:'mkv'}).args.includes('copy'));
});
test('MP3 export uses audio encoder and M4A preserves AAC',()=>{
  assert.ok(planOutput(catalog,{mode:'audio',audioKey:'a',format:'mp3'}).args.includes('libmp3lame'));
  const p=planOutput(catalog,{mode:'audio',audioKey:'a',format:'m4a'});
  assert.ok(p.args.includes('copy')); assert.ok(p.args.includes('-vn'));
});
test('missing or replaced selected track is rejected instead of silently downgraded',()=>{
  assert.throws(()=>planOutput(catalog,{mode:'video',videoKey:'missing',format:'mp4'}),/重新|资源/);
});
test('raw both exports original separate tracks with matching extension and rejects arbitrary URL',()=>{
  const p=planOutput(catalog,{mode:'raw',rawTarget:'both',videoKey:'v',audioKey:'a',format:'original'});
  assert.equal(p.raw,true); assert.equal(p.inputs.length,2); assert.match(p.inputs[0].filename,/视频轨.*\.mp4$/); assert.match(p.inputs[1].filename,/\.m4a$/);
  assert.throws(()=>planOutput({...catalog,videos:[{...video,urls:['https://evil.test/v']}]},{mode:'raw',videoKey:'v',rawTarget:'video',format:'original'}),/地址/);
});
test('legacy segments generate concat manifest rather than binary concatenation',()=>{
  const c={...catalog,videos:[],audios:[],progressive:[{...video,key:'p',kind:'progressive',segments:[{urls:video.urls},{urls:['https://a.bilivideo.com/v2.flv']}]}]};
  const p=planOutput(c,{mode:'video',videoKey:'p',format:'mkv'});
  assert.equal(p.inputs.length,2); assert.match(p.concat,/file 'segment-1\.bin'/); assert.ok(p.args.includes('concat'));
});
test('audio extraction from progressive media honors the selected source',()=>{
  const first={...video,key:'low',kind:'progressive',urls:['https://a.bilivideo.com/low.mp4']};
  const second={...first,key:'high',urls:['https://a.bilivideo.com/high.mp4']};
  const c={...catalog,videos:[],audios:[],progressive:[first,second]};
  assert.deepEqual(planOutput(c,{mode:'audio',videoKey:'high',format:'m4a'}).inputs[0].urls,second.urls);
});
