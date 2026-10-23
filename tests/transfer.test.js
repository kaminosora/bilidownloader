import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInput, createBudget, streamInput } from '../src/core/transfer.js';
const urls=['https://a.bilivideo.com/a','https://b.bilivideo.com/a'];
function response(chunks,headers={}) { return new Response(new ReadableStream({start(c){for(const x of chunks)c.enqueue(Uint8Array.from(x));c.close();}}),{headers}); }
test('unknown length input stops at aggregate budget and releases partial allocation',async()=>{
  const budget=createBudget(5); budget.used=2;
  await assert.rejects(fetchInput({urls:[urls[0]]},{budget,fetchImpl:async()=>response([[1,2],[3,4]])}),/大小|预算/);
  assert.equal(budget.used,2);
});
test('Content-Length preflight refuses oversized media before consuming body',async()=>{
  await assert.rejects(fetchInput({urls},{budget:createBudget(3),fetchImpl:async()=>response([[1]],{'Content-Length':'4'})}),/大小|预算/);
});
test('backup URL is used after failed CDN without charging failed partial bytes',async()=>{
  let i=0;const budget=createBudget(3);
  const data=await fetchInput({urls},{budget,fetchImpl:async()=>{if(i++===0)return new Response(null,{status:403});return response([[1,2,3]]);}});
  assert.deepEqual([...data],[1,2,3]); assert.equal(budget.used,3); assert.equal(i,2);
});
test('aborted job does not attempt backup URL',async()=>{
  const c=new AbortController();c.abort();let calls=0;
  await assert.rejects(fetchInput({urls},{budget:createBudget(10),signal:c.signal,fetchImpl:async()=>{calls++;return response([[1]]);}}),/abort/i);
  assert.equal(calls,0);
});
test('HTML login/error pages cannot be saved as video',async()=>{
  await assert.rejects(fetchInput({urls:[urls[0]]},{budget:createBudget(100),fetchImpl:async()=>new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}})}),/媒体|格式/);
});

test('fetchInput rejects a partial HTTP 206 body and restores its processing budget', async () => {
  const budget = createBudget(10); budget.used = 3;
  await assert.rejects(fetchInput({ urls: [urls[0]] }, { budget,
    fetchImpl: async () => new Response(Uint8Array.of(1, 2), { status: 206,
      headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/4', 'Content-Type': 'video/mp4' } }) }), /完整|部分/);
  assert.equal(budget.used, 3);
});

test('fetchInput accepts a complete HTTP 206 range and charges the exact input bytes', async () => {
  const budget = createBudget(5); budget.used = 3;
  const bytes = await fetchInput({ urls: [urls[0]] }, { budget,
    fetchImpl: async () => new Response(Uint8Array.of(1, 2), { status: 206,
      headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/2', 'Content-Type': 'video/mp4' } }) });
  assert.deepEqual([...bytes], [1, 2]); assert.equal(budget.used, 5);
});

function writableFactory(handlers = {}) {
  const writers = [];
  const openWritable = async () => {
    const writer = { chunks: [], closed: false, aborted: false,
      async write(chunk) { this.chunks.push([...chunk]); await handlers.write?.(chunk, this); },
      async close() { await handlers.close?.(this); this.closed = true; },
      async abort() { this.aborted = true; await handlers.abort?.(this); } };
    writers.push(writer); return writer;
  };
  return { openWritable, writers };
}

test('streamInput writes each incoming chunk before waiting for the rest of the response', async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; value.enqueue(Uint8Array.of(1, 2)); } });
  const target = writableFactory({ write(chunk) { if (chunk[0] === 1) { controller.enqueue(Uint8Array.of(3)); controller.close(); } } });
  const progress = [];
  const total = await streamInput({ urls: [urls[0]] }, { ...target,
    fetchImpl: async () => new Response(body, { headers: { 'Content-Length': '3', 'Content-Type': 'video/mp4' } }),
    onProgress: (received, length) => progress.push([received, length]) });
  assert.equal(total, 3); assert.deepEqual(target.writers[0].chunks, [[1, 2], [3]]);
  assert.equal(target.writers[0].closed, true); assert.equal(target.writers[0].aborted, false);
  assert.deepEqual(progress, [[2, 3], [3, 3]]);
});

test('streamInput aborts a partial file and opens a fresh writable for its backup', async () => {
  const target = writableFactory(); let attempts = 0;
  const total = await streamInput({ urls }, { ...target, fetchImpl: async () => {
    attempts++;
    if (attempts === 1) return response([[9]], { 'Content-Length': '2' });
    return response([[1, 2, 3]], { 'Content-Length': '3' });
  } });
  assert.equal(total, 3); assert.equal(attempts, 2); assert.equal(target.writers.length, 2);
  assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].closed, false);
  assert.deepEqual(target.writers[1].chunks, [[1, 2, 3]]); assert.equal(target.writers[1].closed, true);
});

test('streamInput aborts cancelled writes and does not try a backup', async () => {
  const controller = new AbortController(); let attempts = 0;
  const target = writableFactory({ write() { controller.abort(); } });
  await assert.rejects(streamInput({ urls }, { ...target, signal: controller.signal,
    fetchImpl: async () => { attempts++; return response([[1], [2]]); } }), { name: 'AbortError' });
  assert.equal(attempts, 1); assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].closed, false);
});

test('streamInput cancellation terminates a pending reader without waiting for more bytes', async () => {
  const controller = new AbortController(); let streamCancelled = false;
  const target = writableFactory();
  let pulls = 0;
  await assert.rejects(streamInput({ urls }, { ...target, signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(stream) { if (!pulls++) stream.enqueue(Uint8Array.of(1)); else setTimeout(() => controller.abort(), 0); },
      cancel() { streamCancelled = true; }
    })) }), { name: 'AbortError' });
  assert.equal(streamCancelled, true); assert.equal(target.writers[0].aborted, true);
});

test('streamInput rejects empty and truncated bodies before closing the file', async () => {
  for (const [chunks, headers] of [[[], {}], [[[1]], { 'Content-Length': '2' }], [[[1, 2]], { 'Content-Length': '1' }]]) {
    const target = writableFactory();
    await assert.rejects(streamInput({ urls: [urls[0]] }, { ...target, fetchImpl: async () => response(chunks, headers) }), /完整|为空/);
    assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].closed, false);
  }
});

test('streamInput rejects a partial HTTP range even when that range matches Content-Length', async () => {
  const target = writableFactory();
  await assert.rejects(streamInput({ urls: [urls[0]] }, { ...target,
    fetchImpl: async () => new Response(Uint8Array.of(1, 2), { status: 206,
      headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/4', 'Content-Type': 'video/mp4' } }) }), /完整|部分/);
  assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].closed, false);
});

test('streamInput accepts a range response only when it covers the entire declared file', async () => {
  const target = writableFactory();
  const total = await streamInput({ urls: [urls[0]] }, { ...target,
    fetchImpl: async () => new Response(Uint8Array.of(1, 2), { status: 206,
      headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/2', 'Content-Type': 'video/mp4' } }) });
  assert.equal(total, 2); assert.equal(target.writers[0].closed, true);
});

test('streamInput rejects HTML and JSON bodies and can retry a binary backup', async () => {
  for (const mime of ['text/html', 'application/problem+json']) {
    const target = writableFactory(); let attempts = 0;
    const total = await streamInput({ urls }, { ...target, fetchImpl: async () => {
      attempts++; return attempts === 1 ? response([[1]], { 'Content-Type': mime }) : response([[2, 3]], { 'Content-Type': 'application/octet-stream' });
    } });
    assert.equal(total, 2); assert.equal(target.writers[0].chunks.length, 0); assert.equal(target.writers[0].aborted, true);
    assert.equal(target.writers[1].closed, true);
  }
});

test('streamInput validates media URL and HTTP status before writing', async () => {
  const target = writableFactory(); let fetches = 0;
  await assert.rejects(streamInput({ urls: ['https://attacker.test/file'] }, { ...target, fetchImpl: async () => { fetches++; } }), /媒体地址/);
  assert.equal(fetches, 0); assert.equal(target.writers.length, 0);
  await assert.rejects(streamInput({ urls: [urls[0]] }, { ...target, fetchImpl: async () => new Response(null, { status: 403 }) }), /HTTP 403/);
  assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].chunks.length, 0);
});

test('streamInput has no 512 MiB preflight budget and still verifies declared final length', async () => {
  const target = writableFactory(); let consumed = false;
  const body = new ReadableStream({ pull(controller) { consumed = true; controller.enqueue(Uint8Array.of(7)); controller.close(); } });
  await assert.rejects(streamInput({ urls: [urls[0]] }, { ...target,
    fetchImpl: async () => new Response(body, { headers: { 'Content-Length': String(700 * 1024 * 1024) } }) }), /完整/);
  assert.equal(consumed, true); assert.deepEqual(target.writers[0].chunks, [[7]]);
  assert.equal(target.writers[0].aborted, true);
});

test('streamInput reports disk quota exhaustion in Chinese and does not retry', async () => {
  const target = writableFactory({ write() { throw new DOMException('quota', 'QuotaExceededError'); } });
  let attempts = 0;
  await assert.rejects(streamInput({ urls }, { ...target, fetchImpl: async () => { attempts++; return response([[1]]); } }), /磁盘.*不足|空间.*不足/);
  assert.equal(attempts, 1); assert.equal(target.writers[0].aborted, true); assert.equal(target.writers[0].closed, false);
});

test('streamInput stops before fetching if opening the output exceeds disk quota', async () => {
  let attempts = 0, opens = 0;
  await assert.rejects(streamInput({ urls }, { openWritable: async () => { opens++; throw new DOMException('quota', 'QuotaExceededError'); },
    fetchImpl: async () => { attempts++; return response([[1]]); } }), /磁盘.*不足|空间.*不足/);
  assert.equal(attempts, 0); assert.equal(opens, 1);
});
