import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogLoader, reconcileSelection, supportedPageUrl, jobProgress, selectionForEnqueue, availableQualities, videoTracksForQuality } from '../src/ui-state.js';

const catalog = (title, videos = [{ key: 'avc' }], audios = [{ key: 'aac' }]) => ({
  context: { title }, videos, audios, progressive: [], qualities: [], warnings: [],
});

test('navigation keeps the selected P and rejects pages outside supported Bilibili routes', () => {
  assert.equal(supportedPageUrl('https://www.bilibili.com/video/BV1ab411c7De/?p=3#reply'), 'https://www.bilibili.com/video/BV1ab411c7De/?p=3');
  assert.equal(supportedPageUrl('https://www.bilibili.com/bangumi/play/ep123'), 'https://www.bilibili.com/bangumi/play/ep123');
  assert.equal(supportedPageUrl('https://www.bilibili.com/bangumi/play/ss456'), 'https://www.bilibili.com/bangumi/play/ss456');
  for (const url of ['https://www.bilibili.com/', 'https://bilibili.com.evil.test/video/BV1ab411c7De', 'https://m.bilibili.com/video/BV1ab411c7De', 'https://bilibili.com/video/BV1ab411c7De', 'https://user:pass@www.bilibili.com/video/BV1ab411c7De', 'https://www.bilibili.com:8443/video/BV1ab411c7De', 'javascript:alert(1)']) {
    assert.equal(supportedPageUrl(url), null);
  }
});

test('popup does not offer unsupported malformed IDs or ambiguous part selections', () => {
  for (const path of ['/video/BVshort', '/video/BV1ab411c7Dex', '/video/av0', '/bangumi/play/ep0', '/bangumi/play/ss9007199254740992', '/video/BV1ab411c7De?p=0', '/video/BV1ab411c7De?p=1&p=2']) {
    assert.equal(supportedPageUrl(`https://www.bilibili.com${path}`), null);
  }
  assert.equal(supportedPageUrl('https://www.bilibili.com/video/bv1ab411c7De?p=2'), 'https://www.bilibili.com/video/bv1ab411c7De?p=2');
});

test('a slow earlier part cannot replace the newly selected part catalog', async () => {
  const requests = [];
  const loader = createCatalogLoader(({ url, quality }) => new Promise((resolve, reject) => requests.push({ url, quality, resolve, reject })));
  const first = loader.load('https://www.bilibili.com/video/BV1ab411c7De/?p=1', 80);
  const second = loader.load('https://www.bilibili.com/video/BV1ab411c7De/?p=2', 64);
  assert.equal(loader.state.catalog, null);
  requests[1].resolve(catalog('第二 P'));
  await second;
  requests[0].resolve(catalog('第一 P'));
  await first;
  assert.equal(loader.state.catalog.context.title, '第二 P');
  assert.equal(loader.state.url, 'https://www.bilibili.com/video/BV1ab411c7De/?p=2');
  assert.equal(loader.state.quality, 64);
  assert.equal(loader.state.loading, false);
});

test('an old request failure cannot hide a newer catalog and navigation invalidates in-flight requests', async () => {
  const requests = [];
  const loader = createCatalogLoader(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const first = loader.load('first');
  const second = loader.load('second');
  requests[1].resolve(catalog('new'));
  await second;
  requests[0].reject(new Error('stale failure'));
  await first;
  assert.equal(loader.state.error, '');
  assert.equal(loader.state.catalog.context.title, 'new');
  const third = loader.load('third');
  loader.invalidate();
  requests[2].resolve(catalog('navigated away'));
  await third;
  assert.equal(loader.state.catalog, null);
  assert.equal(loader.state.loading, false);
});

test('current catalog failure disables stale resources and reports the actual error', async () => {
  const loader = createCatalogLoader(async () => { throw new Error('当前账号没有该画质权限'); });
  await loader.load('part', 120);
  assert.equal(loader.state.catalog, null);
  assert.equal(loader.state.error, '当前账号没有该画质权限');
  assert.equal(loader.state.loading, false);
});

test('selection preserves an available codec and audio track, but removes disappeared keys', () => {
  const prior = { mode: 'audio', format: 'flac', videoKey: 'av1', audioKey: 'hires', rawTarget: 'both' };
  const current = catalog('next', [{ key: 'avc' }, { key: 'av1' }], [{ key: 'aac' }, { key: 'hires' }]);
  assert.deepEqual(reconcileSelection(current, prior), prior);
  const changed = reconcileSelection(catalog('next'), prior);
  assert.equal(changed.videoKey, 'avc');
  assert.equal(changed.audioKey, 'aac');
  assert.equal(changed.format, 'flac');
});

test('progressive-only and audio-only catalogs create usable raw selections', () => {
  const progressive = { ...catalog('legacy', [], []), progressive: [{ key: 'durl' }] };
  assert.deepEqual(reconcileSelection(progressive, { mode: 'raw', format: 'original' }), {
    mode: 'raw', format: 'original', videoKey: 'durl', audioKey: undefined, rawTarget: 'video',
  });
  const audio = reconcileSelection(catalog('sound', [], [{ key: 'aac' }]), { mode: 'raw', format: 'original', rawTarget: 'both' });
  assert.equal(audio.rawTarget, 'audio');
  assert.equal(audio.videoKey, undefined);
  assert.equal(audio.audioKey, 'aac');
});

test('job progress is safely clamped and unknown progress is not fabricated', () => {
  assert.equal(jobProgress({ progress: 0.425 }), 43);
  assert.equal(jobProgress({ progress: 1.1 }), 100);
  assert.equal(jobProgress({ progress: -0.2 }), 0);
  assert.equal(jobProgress({}), null);
  assert.equal(jobProgress({ progress: NaN }), null);
});

test('progressive audio extraction uses a conversion format because no independent original audio exists', () => {
  const progressive = { ...catalog('legacy', [], []), progressive: [{ key: 'durl', kind: 'progressive' }] };
  const next = reconcileSelection(progressive, { mode: 'audio', format: 'original' });
  assert.equal(next.format, 'm4a');
  assert.equal(next.videoKey, 'durl');
  assert.equal(next.audioKey, undefined);
});

test('enqueue carries the selected actual video quality so a refresh cannot switch to default quality', () => {
  const actual = catalog('high', [{ key: 'high-av1', quality: 120 }, { key: 'low-avc', quality: 80 }]);
  const selected = selectionForEnqueue(actual, { mode: 'video', format: 'mkv', videoKey: 'high-av1', audioKey: 'aac' });
  assert.equal(selected.quality, 120);
  assert.equal(selected.videoKey, 'high-av1');
  assert.equal(selected.format, 'mkv');
});

test('advertised VIP quality is not selectable until an actual matching track exists', () => {
  const actual = { ...catalog('normal', [{ key: 'avc', quality: 80, qualityLabel: '1080P' }]), qualities: [{ id: 120, label: '4K' }, { id: 80, label: '1080P' }] };
  assert.deepEqual(availableQualities(actual), [{ id: 80, label: '1080P' }]);
  assert.deepEqual(videoTracksForQuality(actual, 120), []);
});

test('choosing a quality replaces an old codec key from a different quality and only offers matching variants', () => {
  const actual = catalog('mixed', [{ key: 'old-avc', quality: 80 }, { key: 'new-hevc', quality: 120 }, { key: 'new-av1', quality: 120 }]);
  assert.deepEqual(videoTracksForQuality(actual, 120).map(track => track.key), ['new-hevc', 'new-av1']);
  const selected = reconcileSelection(actual, { mode: 'video', format: 'mp4', videoKey: 'old-avc', audioKey: 'aac' }, 120);
  assert.equal(selected.videoKey, 'new-hevc');
  assert.equal(selected.audioKey, 'aac');
});
