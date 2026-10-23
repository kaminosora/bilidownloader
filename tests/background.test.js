import test from 'node:test';
import assert from 'node:assert/strict';

const root = 'chrome-extension://background-test/';
const offscreenUrl = `${root}offscreen.html`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for background lifecycle event');
}

async function backgroundHarness({ job, search, download, show }) {
  const listeners = {};
  const calls = { cancel: [], offscreen: [], show: [] };
  const local = { jobs: [structuredClone(job)] };
  const session = { alive: true };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: 'background-test',
      getURL: path => `${root}${path}`,
      getContexts: async () => [{ documentUrl: offscreenUrl }],
      sendMessage: async message => {
        calls.offscreen.push(message);
        if (message.type === 'SNAPSHOT') return { data: [{ id: job.id, status: 'saving' }] };
        return { ok: true };
      },
      onMessage: { addListener: listener => { listeners.message = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => structuredClone(local),
        set: async value => { Object.assign(local, structuredClone(value)); },
      },
      session: {
        get: async () => structuredClone(session),
        set: async value => { Object.assign(session, structuredClone(value)); },
      },
    },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    downloads: {
      search,
      download,
      show: id => { calls.show.push(id); return show?.(id); },
      cancel: async id => { calls.cancel.push(id); },
      onChanged: { addListener: listener => { listeners.changed = listener; } },
    },
  };
  await import(`../src/background.js?test=${crypto.randomUUID()}`);
  const send = (type, payload = {}, senderUrl = root) => new Promise(resolve => {
    listeners.message({ target: 'background', type, payload }, { id: 'background-test', url: senderUrl }, resolve);
  });
  return {
    calls, local, listeners, send,
    restore() { globalThis.chrome = previousChrome; },
  };
}

function savingJob(downloadIds, expectedDownloads) {
  return {
    id: 'job-1', url: 'https://www.bilibili.com/video/BV13x41117TL',
    selection: { mode: 'raw', format: 'original', rawTarget: 'both' },
    title: 'Two tracks', status: 'saving', progress: 0.96, message: 'Chrome 正在保存文件',
    createdAt: 1, downloadIds, expectedDownloads,
  };
}

function entry(id, state = 'in_progress') {
  return { id, state, mime: 'video/mp4', totalBytes: 100, bytesReceived: state === 'complete' ? 100 : 50 };
}

test('stale download search cannot interrupt a SAVE that appended another download ID', async () => {
  const secondDownload = deferred();
  const secondStarted = deferred();
  const staleSearch = deferred();
  const staleStarted = deferred();
  let holdOneSearch = false;
  const files = [
    { url: `${root.replace('chrome-extension:', 'blob:chrome-extension:')}one`, filename: 'video.m4s' },
    { url: `${root.replace('chrome-extension:', 'blob:chrome-extension:')}two`, filename: 'audio.m4s' },
  ];
  const harness = await backgroundHarness({
    job: savingJob([1], 1),
    search: async query => {
      if (query.url) return [];
      if (query.id === 1 && holdOneSearch) {
        holdOneSearch = false;
        staleStarted.resolve();
        return staleSearch.promise;
      }
      return [entry(query.id)];
    },
    download: async () => { secondStarted.resolve(); return secondDownload.promise; },
  });
  try {
    assert.equal((await harness.send('JOBS')).ok, true);
    const save = harness.send('SAVE', { id: 'job-1', files }, offscreenUrl);
    await secondStarted.promise;
    holdOneSearch = true;
    const staleJobs = harness.send('JOBS');
    await staleStarted.promise;
    secondDownload.resolve(2);
    assert.equal((await save).ok, true);
    await until(() => harness.local.jobs[0].downloadIds.length === 2);
    staleSearch.resolve([entry(1)]);
    const response = await staleJobs;
    assert.equal(response.ok, true);
    assert.equal(response.data[0].status, 'saving');
    assert.deepEqual(response.data[0].downloadIds, [1, 2]);
    assert.equal(harness.local.jobs[0].status, 'saving');
    assert.deepEqual(harness.calls.cancel, []);
  } finally { harness.restore(); }
});

test('an interrupted saved track cancels every other download and releases its offscreen files', async () => {
  let firstState = 'in_progress';
  const harness = await backgroundHarness({
    job: savingJob([1, 2], 2),
    search: async query => [entry(query.id, query.id === 1 ? firstState : 'in_progress')],
    download: async () => assert.fail('No new download should start during recovery'),
  });
  try {
    assert.equal((await harness.send('JOBS')).ok, true);
    firstState = 'interrupted';
    harness.listeners.changed({ id: 1, state: { current: 'interrupted' } });
    await until(() => harness.calls.cancel.includes(1) && harness.calls.cancel.includes(2)
      && harness.calls.offscreen.some(message => message.type === 'RELEASE' && message.payload.id === 'job-1'));
    const response = await harness.send('JOBS');
    assert.equal(response.data[0].status, 'failed');
    assert.match(response.data[0].error, /Chrome 下载中断/);
    assert.deepEqual(new Set(harness.calls.cancel), new Set([1, 2]));
  } finally { harness.restore(); }
});

test('folder action reveals a completed download owned by the requested job', async () => {
  const job={...savingJob([11],1),status:'completed'};
  const harness=await backgroundHarness({job,search:async({id})=>[{...entry(id,'complete'),exists:true}]});
  try{
    const response=await harness.send('SHOW_DOWNLOAD_FOLDER',{id:job.id,downloadId:999,path:'C:/unrelated'});
    assert.equal(response.ok,true);assert.deepEqual(harness.calls.show,[11]);
    assert.equal(JSON.stringify(response).includes('unrelated'),false);
  }finally{harness.restore();}
});

test('folder action skips a missing first track and locates a saved second track', async () => {
  const job={...savingJob([11,12],2),status:'failed'};
  const harness=await backgroundHarness({job,search:async({id})=>[{...entry(id,'complete'),exists:id===12}]});
  try{assert.equal((await harness.send('SHOW_DOWNLOAD_FOLDER',{id:job.id})).ok,true);assert.deepEqual(harness.calls.show,[12]);}
  finally{harness.restore();}
});

test('folder action rejects unknown jobs and arbitrary download IDs', async () => {
  const job={...savingJob([11],1),status:'completed'};
  const harness=await backgroundHarness({job,search:async()=>assert.fail('Unknown job must not query download records')});
  try{
    const response=await harness.send('SHOW_DOWNLOAD_FOLDER',{id:'other',downloadId:11});
    assert.equal(response.ok,false);assert.match(response.error,/任务|文件/);assert.deepEqual(harness.calls.show,[]);
  }finally{harness.restore();}
});

test('folder action explains incomplete files and removed download history', async () => {
  for(const records of [[],[{...entry(11,'complete'),exists:false}],[entry(11)]]){
    const job={...savingJob([11],1),status:'completed'};
    const harness=await backgroundHarness({job,search:async()=>records});
    try{
      const response=await harness.send('SHOW_DOWNLOAD_FOLDER',{id:job.id});
      assert.equal(response.ok,false);assert.match(response.error,/完成|删除|移|记录/);assert.deepEqual(harness.calls.show,[]);
    }finally{harness.restore();}
  }
});

test('folder action reports native API errors without changing a completed task', async () => {
  const job={...savingJob([11],1),status:'completed'};
  const harness=await backgroundHarness({job,search:async({id})=>[entry(id,'complete')],show:()=>{throw new Error('platform unavailable');}});
  try{
    const response=await harness.send('SHOW_DOWNLOAD_FOLDER',{id:job.id});
    assert.equal(response.ok,false);assert.match(response.error,/文件夹|资源管理器/);
    assert.equal(harness.local.jobs[0].status,'completed');
  }finally{harness.restore();}
});
