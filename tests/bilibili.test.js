import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePageUrl, resolveMedia, getCatalog, normalizePlayInfo, signWbi } from '../src/core/bilibili.js';
import { md5 } from '../src/core/wbi.js';

const context = { kind: 'ugc', bvid: 'BV13x41117TL', aid: 8903802, cid: 14694589,
  title: '示例', partTitle: '第一部分', pageUrl: 'https://www.bilibili.com/video/BV13x41117TL/',
  duration: 120, parts: [], selectedPartId: '14694589' };
const cdn = 'https://upos-sz-mirrorali.bilivideo.com';
const nav = { code: -101, message: '账号未登录', data: { isLogin: false, wbi_img: {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
function dashFixture() {
  return { code: 0, data: { quality: 80, timelength: 120000,
    accept_quality: [120, 80, 64], accept_description: ['4K', '1080P', '720P'],
    support_formats: [{ quality: 120, new_description: '4K 超清' }, { quality: 80, new_description: '1080P 高清' }],
    dash: { video: [
      { id: 80, codecs: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '30000/1001', bandwidth: 5000000,
        baseUrl: `${cdn}/video-avc.m4s?deadline=100`, backupUrl: [`${cdn}/video-avc-backup.m4s`, `${cdn}/video-avc.m4s?deadline=100`] },
      { id: 80, codecs: 'hev1.1.6.L120.90', mime_type: 'video/mp4', width: 1920, height: 1080, frame_rate: '30', bandwidth: 3000000, base_url: `${cdn}/video-hevc.m4s` },
      { id: 80, codecs: 'av01.0.08M.08', mimeType: 'video/mp4', width: 1920, height: 1080, bandwidth: 2500000, baseUrl: `${cdn}/video-av1.m4s` }],
      audio: [{ id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 192000, baseUrl: `${cdn}/audio.m4s` }],
      dolby: { type: 1, audio: [{ id: 30250, codecs: 'ec-3', mime_type: 'audio/mp4', bandwidth: 384000, base_url: `${cdn}/dolby.m4s` }] },
      flac: { display: true, audio: { id: 30251, codecs: 'fLaC', mimeType: 'audio/mp4', bandwidth: 900000, baseUrl: `${cdn}/flac.m4s` } } } } };
}
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(url.origin, 'https://api.bilibili.com');
    const route = routes[url.pathname];
    assert.ok(route, `Unexpected API route ${url.pathname}`);
    const value = typeof route === 'function' ? route(url, options) : route;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('parses BV, av, ep and ss URLs and preserves a valid part selection', () => {
  const bv = parsePageUrl('https://www.bilibili.com/video/BV13x41117TL/?p=2&spm_id_from=abc');
  assert.equal(bv.kind, 'ugc'); assert.equal(bv.bvid, 'BV13x41117TL'); assert.equal(bv.page, 2);
  assert.equal(parsePageUrl('https://www.bilibili.com/video/av8903802').aid, 8903802);
  assert.equal(parsePageUrl('https://www.bilibili.com/bangumi/play/ep21495').epId, 21495);
  assert.equal(parsePageUrl('https://www.bilibili.com/bangumi/play/ss1182').seasonId, 1182);
});
test('rejects off-site, credential-bearing, malformed or ambiguous page URLs', () => {
  for (const url of ['https://www.bilibili.com.evil.test/video/BV13x41117TL', 'https://user@www.bilibili.com/video/BV13x41117TL',
    'https://www.bilibili.com:444/video/BV13x41117TL', 'https://www.bilibili.com/video/BVinvalid',
    'https://www.bilibili.com/video/BV13x41117TL?p=0', 'https://www.bilibili.com/video/BV13x41117TL?p=1&p=2',
    'https://www.bilibili.com/video/BV13x41117TL?p=1.5', 'https://www.bilibili.com/video/av9007199254740993']) {
    assert.throws(() => parsePageUrl(url), { code: 'INVALID_URL' }, url);
  }
});
test('MD5 matches standard vectors, UTF-8 input and block padding boundaries', () => {
  for (const [input, expected] of [['', 'd41d8cd98f00b204e9800998ecf8427e'], ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['中文', 'a7bac2239fcdcb3a067903d8077c4a07']]) assert.equal(md5(input), expected);
});
test('WBI signs a fixed vector independently checked with native MD5 and does not mutate input', () => {
  const params = { foo: 114, bar: 514, baz: 1919810 };
  const signed = signWbi(params, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  // Native crypto check: MD5(query + "ea1db124af3c7062474693fa704f4ff8").
  assert.equal(new URLSearchParams(signed).toString(), 'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee');
  assert.deepEqual(params, { foo: 114, bar: 514, baz: 1919810 });
});
test('WBI sanitizes forbidden punctuation while preserving spaces and Unicode', () => {
  const signed = signWbi({ text: "中文 !'()* x", w_rid: 'obsolete', wts: 1 },
    '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  assert.equal(signed.text, '中文  x'); assert.equal(signed.wts, '1702204169');
  assert.notEqual(signed.w_rid, 'obsolete'); assert.match(signed.w_rid, /^[a-f0-9]{32}$/);
});
test('normalization preserves actual codec variants separately from advertised qualities', () => {
  const catalog = normalizePlayInfo(dashFixture(), context);
  assert.equal(catalog.videos.length, 3);
  assert.deepEqual(catalog.videos.map(t => t.quality), [80, 80, 80]);
  assert.deepEqual(catalog.qualities.map(q => q.id), [120, 80, 64]);
  assert.equal(catalog.videos[0].qualityLabel, '1080P 高清');
  assert.equal(catalog.videos[0].fps, 30000 / 1001);
  assert.equal(new Set(catalog.videos.map(t => t.key)).size, 3);
  assert.deepEqual(catalog.videos[0].urls, [`${cdn}/video-avc.m4s?deadline=100`, `${cdn}/video-avc-backup.m4s`]);
  assert.equal(catalog.context, context);
});
test('normalization includes ordinary, Dolby and FLAC audio roles', () => {
  const audios = normalizePlayInfo(dashFixture(), context).audios;
  assert.deepEqual(audios.map(t => t.audioRole), ['standard', 'dolby', 'flac']);
  assert.deepEqual(audios.map(t => t.codec), ['mp4a.40.2', 'ec-3', 'fLaC']);
  assert.equal(new Set(audios.map(t => t.key)).size, 3);
});
test('track keys survive signed URL refresh and do not collapse different bitrate representations', () => {
  const first = dashFixture();
  first.data.dash.video.push({ ...first.data.dash.video[0], bandwidth: 6000000, baseUrl: `${cdn}/video-other.m4s` });
  const refreshed = structuredClone(first);
  refreshed.data.dash.video[0].baseUrl = `${cdn}/video-avc.m4s?deadline=200`;
  assert.deepEqual(normalizePlayInfo(first, context).videos.map(t => t.key), normalizePlayInfo(refreshed, context).videos.map(t => t.key));
  assert.equal(new Set(normalizePlayInfo(first, context).videos.map(t => t.key)).size, 4);
});
test('all current PGC wrappers yield the same actual tracks', () => {
  const info = dashFixture().data;
  for (const wrapper of [{ code: 0, result: { video_info: info } }, { code: 0, raw: { data: { video_info: info } } },
    { data: { code: 0, result: { video_info: info } } }]) {
    assert.equal(normalizePlayInfo(wrapper, { ...context, kind: 'pgc', epId: 21495 }).videos.length, 3);
  }
});
test('legacy durl preserves ordered segments, backup URLs, durations and size', () => {
  const result = normalizePlayInfo({ code: 0, data: { quality: 32, format: 'flv480', timelength: 3000, accept_quality: [32],
    accept_description: ['480P'], durl: [{ order: 2, url: `${cdn}/2.flv`, size: 20, length: 2000 },
      { order: 1, url: `${cdn}/1.flv`, backup_url: [`${cdn}/1-backup.flv`], size: 10, length: 1000 }] } }, context);
  assert.equal(result.progressive.length, 1);
  assert.equal(result.progressive[0].size, 30); assert.equal(result.progressive[0].duration, 3);
  assert.equal(result.progressive[0].mime, 'video/x-flv');
  assert.deepEqual(result.progressive[0].segments.map(s => [s.urls[0], s.duration]), [[`${cdn}/1.flv`, 1], [`${cdn}/2.flv`, 2]]);
});
test('progressive media does not invent an audio codec from the file container', () => {
  const result = normalizePlayInfo({ data: { quality: 32, format: 'mp4', durl: [{ url: `${cdn}/complete.mp4` }] } }, context);
  assert.equal(result.progressive[0].codec, 'unknown');
  assert.equal(result.progressive[0].size, undefined);
});
test('encrypted or incomplete progressive segments cannot produce a partial success', () => {
  assert.throws(() => normalizePlayInfo({ data: { durl: [{ url: `${cdn}/one.mp4`, is_drm: true }] } }, context), { code: 'DRM_PROTECTED' });
  assert.throws(() => normalizePlayInfo({ data: { durl: [{ url: `${cdn}/one.mp4` }, { url: 'https://example.org/two.mp4' }] } }, context), { code: 'INVALID_MEDIA_URL' });
});
test('explicit non-DRM and non-preview flags do not reject a valid catalog', () => {
  const fixture = dashFixture(); fixture.data.is_drm = '0'; fixture.data.is_preview = false;
  assert.equal(normalizePlayInfo(fixture, context).videos.length, 3);
});
function groupedPgcFixture() {
  return { code: 0, result: { play_check: { play_detail: 'PLAY_WHOLE' }, video_info: {
    quality: 80, format: 'flv', codecs: 'avc1', video_codecid: 7, timelength: 3000, is_drm: false, is_preview: 0,
    accept_quality: [80, 64], accept_description: ['1080P', '720P'], durl: null, dash: null,
    durls: [
      { quality: 80, format: 'flv', codecs: 'avc1', timelength: 3000, durl: [
        { order: 2, url: `${cdn}/80-2.flv`, size: 200, length: 2000 },
        { order: 1, url: `${cdn}/80-1.flv`, backup_url: [`${cdn}/80-1-backup.flv`], size: 100, length: 1000 }] },
      { quality: 64, format: 'mp4', codecs: 'hev1', timelength: 3000, durl: [
        { order: 1, url: `${cdn}/64.mp4`, backup_url: [`${cdn}/64-backup.mp4`], size: 150, length: 3000 }] }
    ] } } };
}
test('PGC v2 durls yields one complete progressive track per actual quality group', () => {
  const catalog = normalizePlayInfo(groupedPgcFixture(), { ...context, kind: 'pgc', epId: 21495 });
  assert.equal(catalog.progressive.length, 2);
  const [high, low] = catalog.progressive;
  assert.deepEqual([high.quality, high.codec, high.mime, high.size, high.duration], [80, 'avc1', 'video/x-flv', 300, 3]);
  assert.deepEqual([low.quality, low.codec, low.mime, low.size, low.duration], [64, 'hev1', 'video/mp4', 150, 3]);
  assert.deepEqual(high.segments.map(segment => [segment.urls[0], segment.duration]), [[`${cdn}/80-1.flv`, 1], [`${cdn}/80-2.flv`, 2]]);
  assert.deepEqual(high.segments[0].urls, [`${cdn}/80-1.flv`, `${cdn}/80-1-backup.flv`]);
  assert.deepEqual(low.urls, [`${cdn}/64.mp4`, `${cdn}/64-backup.mp4`]);
});
test('grouped progressive keys preserve codec variants and survive URL refresh', () => {
  const first = groupedPgcFixture();
  first.result.video_info.durls.push({ quality: 64, format: 'mp4', codecs: 'avc1', durl: [{ url: `${cdn}/64-avc.mp4`, length: 3000, size: 250 }] });
  const refreshed = structuredClone(first);
  refreshed.result.video_info.durls[1].durl[0].url += '?deadline=300';
  const originalKeys = normalizePlayInfo(first, context).progressive.map(track => track.key);
  assert.equal(new Set(originalKeys).size, 3);
  assert.deepEqual(normalizePlayInfo(refreshed, context).progressive.map(track => track.key), originalKeys);
});
test('grouped progressive metadata is not borrowed from a different current quality', () => {
  const fixture = groupedPgcFixture();
  const low = fixture.result.video_info.durls[1]; delete low.codecs; delete low.format;
  const track = normalizePlayInfo(fixture, context).progressive[1];
  assert.equal(track.codec, 'unknown'); assert.equal(track.mime, 'video/mp4');
});
test('DRM markers on quality groups or their segments remain blocking', () => {
  for (const segmentLevel of [false, true]) {
    const fixture = groupedPgcFixture();
    const group = fixture.result.video_info.durls[1];
    (segmentLevel ? group.durl[0] : group).is_drm = true;
    assert.throws(() => normalizePlayInfo(fixture, context), { code: 'DRM_PROTECTED' });
  }
});
test('an unsafe grouped segment prevents an incomplete progressive output', () => {
  const fixture = groupedPgcFixture();
  fixture.result.video_info.durls[0].durl[0].url = 'https://attacker.test/part.flv';
  assert.throws(() => normalizePlayInfo(fixture, context), { code: 'INVALID_MEDIA_URL' });
});
test('PGC requested quality is matched against actual durls groups', async () => {
  const api = fakeApi({ '/pgc/player/web/v2/playurl': groupedPgcFixture() });
  const result = await getCatalog({ ...context, kind: 'pgc', epId: 21495 }, { ...api, quality: 64 });
  assert.ok(result.progressive.some(track => track.quality === 64));
});
test('a current durl repeated in durls is not offered as duplicate download choices', () => {
  const fixture = groupedPgcFixture();
  fixture.result.video_info.durl = structuredClone(fixture.result.video_info.durls[0].durl);
  const result = normalizePlayInfo(fixture, context);
  assert.equal(result.progressive.length, 2);
  assert.equal(new Set(result.progressive.map(track => track.key)).size, 2);
});
test('a preview-only quality group does not appear as a complete video', () => {
  const fixture = groupedPgcFixture(); fixture.result.video_info.durls[0].is_preview = 1;
  assert.throws(() => normalizePlayInfo(fixture, context), { code: 'PREVIEW_ONLY' });
});
test('DRM and previews fail explicitly even if media URLs are present', () => {
  for (const [mutation, code] of [[p => { p.data.is_drm = true; }, 'DRM_PROTECTED'],
    [p => { p.data.is_preview = 1; }, 'PREVIEW_ONLY'],
    [p => { p.data.dash.video[0].drm_tech_type = 2; }, 'DRM_PROTECTED']]) {
    const fixture = dashFixture(); mutation(fixture); assert.throws(() => normalizePlayInfo(fixture, context), { code });
  }
  assert.throws(() => normalizePlayInfo({ result: { play_check: { play_detail: 'PLAY_PREVIEW' }, video_info: dashFixture().data } }, context), { code: 'PREVIEW_ONLY' });
  assert.throws(() => normalizePlayInfo({ result: { play_check: { play_detail: 'PLAY_NONE' }, video_info: dashFixture().data } }, context), { code: 'NO_ACCESS' });
});
test('API errors and missing media produce actionable failures without trusting quality labels', () => {
  for (const [code, expected] of [[-101, 'LOGIN_REQUIRED'], [-10403, 'ACCESS_DENIED'], [-352, 'RATE_LIMITED'], [-404, 'NOT_FOUND']]) {
    assert.throws(() => normalizePlayInfo({ code, message: 'server denied' }, context), { code: expected });
  }
  assert.throws(() => normalizePlayInfo({ code: 0, data: { support_formats: [{ quality: 120, new_description: '4K' }] } }, context), { code: 'NO_MEDIA' });
});
test('unsafe media URLs never enter the catalog and missing primary URL uses a valid backup', () => {
  const fixture = dashFixture();
  fixture.data.dash.video = [{ id: 80, codecs: 'avc1', baseUrl: 'https://attacker.test/movie.mp4', backupUrl: [`${cdn}/valid.m4s`] },
    { id: 80, codecs: 'av01', baseUrl: 'https://user@upos-sz-mirrorali.bilivideo.com/movie.m4s' }];
  const catalog = normalizePlayInfo(fixture, context);
  assert.equal(catalog.videos.length, 1); assert.deepEqual(catalog.videos[0].urls, [`${cdn}/valid.m4s`]);
  assert.ok(catalog.warnings.length);
});
test('resolves AV metadata and the selected P into the correct CID', async () => {
  const api = fakeApi({ '/x/web-interface/view': url => {
    assert.equal(url.searchParams.get('aid'), '8903802');
    return { code: 0, data: { bvid: 'BV13x41117TL', aid: 8903802, title: '双 P', cid: 1,
      pages: [{ cid: 1, page: 1, part: '甲', duration: 10 }, { cid: 2, page: 2, part: '乙', duration: 20 }] } };
  } });
  const result = await resolveMedia('https://www.bilibili.com/video/av8903802?p=2', api);
  assert.equal(result.cid, 2); assert.equal(result.partTitle, '乙'); assert.equal(result.duration, 20);
  assert.equal(result.selectedPartId, '2'); assert.equal(result.parts[0].id, '1');
  assert.equal(new URL(result.parts[1].pageUrl).searchParams.get('p'), '2');
  assert.equal(api.calls[0].options.credentials, 'include'); assert.ok(api.calls[0].options.signal);
});
test('nonexistent part does not silently download the first part', async () => {
  const api = fakeApi({ '/x/web-interface/view': { code: 0, data: { bvid: 'BV13x41117TL', title: '测试', pages: [{ cid: 1, page: 1 }] } } });
  await assert.rejects(resolveMedia('https://www.bilibili.com/video/BV13x41117TL?p=9', api), { code: 'PART_NOT_FOUND' });
});
test('PGC episode resolution includes additional sections and selects the exact episode', async () => {
  const api = fakeApi({ '/pgc/view/web/season': url => {
    assert.equal(url.searchParams.get('ep_id'), '3');
    return { code: 0, result: { season_id: 1182, title: '剧名', episodes: [{ id: 1, cid: 11, aid: 111, title: '1', long_title: '正片', duration: 60000 }],
      section: [{ episodes: [{ id: 3, cid: 33, aid: 333, title: '花絮', long_title: '幕后', duration: 30000 }] }] } };
  } });
  const result = await resolveMedia('https://www.bilibili.com/bangumi/play/ep3', api);
  assert.equal(result.epId, 3); assert.equal(result.cid, 33); assert.equal(result.duration, 30);
  assert.equal(result.selectedPartId, '3'); assert.equal(result.parts.length, 2); assert.match(result.partTitle, /幕后/);
});
test('PGC season resolution chooses its first real episode', async () => {
  const api = fakeApi({ '/pgc/view/web/season': { code: 0, result: { season_id: 1182, title: '剧名', episodes: [{ id: 21495, cid: 10, title: '1' }] } } });
  const result = await resolveMedia('https://www.bilibili.com/bangumi/play/ss1182', api);
  assert.equal(result.epId, 21495); assert.equal(result.pageUrl, 'https://www.bilibili.com/bangumi/play/ep21495');
});
test('UGC catalog makes signed requests with credentials and requested quality', async () => {
  const api = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': url => {
    assert.equal(url.searchParams.get('cid'), '14694589'); assert.equal(url.searchParams.get('bvid'), 'BV13x41117TL');
    assert.equal(url.searchParams.get('qn'), '80'); assert.equal(url.searchParams.get('fnval'), '4048');
    assert.match(url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/); return dashFixture();
  } });
  const result = await getCatalog(context, { ...api, quality: 80 });
  assert.equal(result.videos.length, 3); assert.ok(api.calls.every(call => call.options.credentials === 'include'));
});
test('PGC catalog uses v2 endpoint and rejects a requested quality missing from actual tracks', async () => {
  const api = fakeApi({ '/pgc/player/web/v2/playurl': url => {
    assert.equal(url.searchParams.get('ep_id'), '21495'); assert.equal(url.searchParams.get('fnval'), '12240');
    return { code: 0, result: { video_info: dashFixture().data } };
  } });
  await assert.rejects(getCatalog({ ...context, kind: 'pgc', epId: 21495 }, { ...api, quality: 120 }), { code: 'QUALITY_UNAVAILABLE' });
});
function legacyFixture(quality = 80, advertised = [80, 64]) {
  return { code: 0, data: { quality, format: 'flv', timelength: 3000, accept_quality: advertised,
    accept_description: advertised.map(id => `${id}P`),
    durl: [{ order: 1, url: `${cdn}/legacy-${quality}.flv`, backup_url: [`${cdn}/legacy-${quality}-backup.flv`], size: 300, length: 3000 }] } };
}
test('default legacy discovery adds other actually accessible qualities and reuses WBI keys', async () => {
  const api = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': url => legacyFixture(Number(url.searchParams.get('qn') || 80)) });
  const catalog = await getCatalog(context, api);
  assert.deepEqual(catalog.progressive.map(track => track.quality), [80, 64]);
  assert.equal(new Set(catalog.progressive.map(track => track.key)).size, 2);
  assert.equal(catalog.context, context);
  assert.equal(api.calls.filter(call => call.url.pathname === '/x/web-interface/nav').length, 1);
  assert.deepEqual(api.calls.filter(call => call.url.pathname.endsWith('playurl')).map(call => call.url.searchParams.get('qn')), [null, '64']);
  assert.equal(catalog.warnings.length, 0);
});
test('default PGC legacy discovery never promotes forbidden or missing advertised quality', async () => {
  const api = fakeApi({ '/pgc/player/web/v2/playurl': url => {
    if (url.searchParams.get('qn') === '80') return { code: -10403, message: 'forbidden' };
    return { code: 0, result: { video_info: legacyFixture(32, [80, 64, 32]).data } };
  } });
  const catalog = await getCatalog({ ...context, kind: 'pgc', epId: 21495 }, api);
  assert.deepEqual(catalog.progressive.map(track => track.quality), [32]);
  assert.deepEqual(catalog.qualities.map(quality => quality.id), [80, 64, 32]);
  assert.deepEqual(api.calls.map(call => call.url.searchParams.get('qn')), [null, '80', '64']);
  assert.ok(catalog.warnings.length);
});
test('default DASH catalog does not probe advertised qualities absent from the actual list', async () => {
  const api = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': dashFixture() });
  const catalog = await getCatalog(context, api);
  assert.equal(catalog.videos.length, 3);
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith('playurl')).length, 1);
});
test('explicit legacy quality makes only its selected playback request and fails if missing', async () => {
  const api = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': legacyFixture(32, [80, 64, 32]) });
  await assert.rejects(getCatalog(context, { ...api, quality: 80 }), { code: 'QUALITY_UNAVAILABLE' });
  assert.deepEqual(api.calls.filter(call => call.url.pathname.endsWith('playurl')).map(call => call.url.searchParams.get('qn')), ['80']);
});
test('legacy discovery limits total playback requests and preserves the completed results', async () => {
  const advertised = Array.from({ length: 20 }, (_, i) => i + 1);
  const api = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': url => legacyFixture(Number(url.searchParams.get('qn') || 1), advertised) });
  const catalog = await getCatalog(context, api);
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith('playurl')).length, 16);
  assert.equal(catalog.progressive.length, 16);
  assert.ok(catalog.warnings.some(warning => /上限/.test(warning)));
});
for (const problem of ['rate-limit', 'network', 'timeout']) {
  test(`legacy discovery stops on ${problem} and retains confirmed tracks with a warning`, async () => {
    const attempts = [];
    const base = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': legacyFixture(32, [80, 64, 32]) });
    const fetchImpl = async (input, options) => {
      const url = new URL(input);
      if (url.pathname.endsWith('playurl')) attempts.push(url.searchParams.get('qn'));
      if (url.searchParams.has('qn')) {
        if (problem === 'rate-limit') return new Response(JSON.stringify({ code: -352 }));
        if (problem === 'network') throw new TypeError('network is unreachable');
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return base.fetchImpl(input, options);
    };
    const catalog = await getCatalog(context, { fetchImpl, timeoutMs: 10 });
    assert.deepEqual(attempts, [null, '80']);
    assert.deepEqual(catalog.progressive.map(track => track.quality), [32]);
    assert.ok(catalog.warnings.some(warning => /停止/.test(warning)));
  });
}
test('cancelling during legacy discovery aborts the operation instead of returning partial success', async () => {
  const controller = new AbortController();
  const base = fakeApi({ '/x/web-interface/nav': nav, '/x/player/wbi/playurl': legacyFixture() });
  const fetchImpl = async (input, options) => {
    if (new URL(input).searchParams.has('qn')) { controller.abort(); throw controller.signal.reason; }
    return base.fetchImpl(input, options);
  };
  await assert.rejects(getCatalog(context, { fetchImpl, signal: controller.signal }), { name: 'AbortError' });
});
test('aborted requests and HTTP failures propagate as explicit errors', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveMedia(context.pageUrl, { signal: controller.signal, fetchImpl: async () => { throw new Error('must not fetch'); } }), { name: 'AbortError' });
  await assert.rejects(resolveMedia(context.pageUrl, { fetchImpl: async () => new Response('', { status: 429 }) }), { code: 'RATE_LIMITED' });
});
test('request deadline cancels a hung API fetch', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(resolveMedia(context.pageUrl, { fetchImpl, timeoutMs: 10 }), { code: 'REQUEST_TIMEOUT' });
});
