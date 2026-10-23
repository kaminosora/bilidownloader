import test from 'node:test';
import assert from 'node:assert/strict';
import { addJob, updateJob, reconcileJobs, publicJobs, isActive, downloadState } from '../src/core/jobs.js';
test('queue rejects sixth pending job and terminal history does not consume capacity',()=>{
  const jobs=[{id:'old',status:'completed'}];for(let i=0;i<5;i++)addJob(jobs,{url:'https://www.bilibili.com/video/BV1234567890',selection:{mode:'audio'}},`j${i}`);
  assert.throws(()=>addJob(jobs,{},'extra'),/队列/);assert.equal(jobs.length,6);
});
test('late processing/save events cannot revive cancelled or completed jobs',()=>{
  const job={id:'a',status:'cancelled',progress:0};assert.equal(updateJob(job,{status:'saving'}),false);assert.equal(job.status,'cancelled');
});
test('recovery preserves known active job, marks orphan interrupted, retains queued work',()=>{
  const jobs=[{id:'a',status:'processing'},{id:'b',status:'downloading'},{id:'c',status:'queued'}];
  reconcileJobs(jobs,[{id:'a',status:'processing',progress:.6}]);
  assert.equal(jobs[0].progress,.6);assert.equal(jobs[1].status,'interrupted');assert.equal(jobs[2].status,'queued');assert.equal(isActive(jobs[0]),true);
});
test('public and persistent summaries do not leak full media plans',()=>{
  const j={id:'a',status:'queued',title:'x',url:'page',selection:{mode:'audio'},plan:{inputs:['secret']}};
  assert.equal(publicJobs([j])[0].plan,undefined);assert.equal(publicJobs([j])[0].url,undefined);
});
test('first completed raw track does not finish a two-track download',()=>{
  const job={expectedDownloads:2,downloadIds:[1],progress:0};
  assert.equal(downloadState(job,[{id:1,state:'complete',totalBytes:8,bytesReceived:8}]).status,'saving');
  job.downloadIds.push(2);
  assert.equal(downloadState(job,[{id:1,state:'complete',totalBytes:8,bytesReceived:8},{id:2,state:'complete',totalBytes:3,bytesReceived:3}]).status,'completed');
});
test('completed error documents are rejected as invalid media downloads',()=>{
  const job={expectedDownloads:1,downloadIds:[1],progress:0};
  for(const mime of ['text/html','application/json'])assert.equal(downloadState(job,[{id:1,state:'complete',mime,totalBytes:100,bytesReceived:100}]).status,'failed');
});
