import { signWbi } from './wbi.js';
export { signWbi } from './wbi.js';

const API = 'https://api.bilibili.com';
const PAGE = 'https://www.bilibili.com';
const MEDIA_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com'];
const MISSING_QUALITY_WARNING = '部分公布的画质未返回媒体资源，可能受登录、会员、地区或服务端限制。';
const MAX_LEGACY_PLAY_REQUESTS = 16;
const numeric = value => value === null || value === undefined || value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined;
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flag = value => value === true || value === 'true' || (numeric(value) ?? 0) > 0;

function failure(code, message, apiCode) {
  const error = new Error(message); error.code = code;
  if (apiCode !== undefined) error.apiCode = apiCode;
  return error;
}
function apiFailure(code) {
  if (code === -101) return failure('LOGIN_REQUIRED', '请先在 B 站登录，然后刷新资源。', code);
  if (code === -352 || code === -401 || code === -412 || code === 429) return failure('RATE_LIMITED', 'B 站暂时拒绝请求，请稍后重试，并确认网页可正常播放。', code);
  if (code === -404 || code === 404) return failure('NOT_FOUND', '视频不存在、已删除或当前地区不可用。', code);
  if (code === -403 || code === -10403 || code === 403) return failure('ACCESS_DENIED', '当前账号或地区没有取得播放资源，请在网页确认登录、会员或购买权限。', code);
  return failure('API_ERROR', `B 站接口返回错误（${code}），请在网页确认能否播放后重试。`, code);
}
function checkApi(payload, allowed = []) {
  if (!isObject(payload)) throw failure('INVALID_RESPONSE', 'B 站接口返回了无法识别的数据，请稍后重试。');
  const code = numeric(payload.code);
  if (code !== undefined && code !== 0 && !allowed.includes(code)) throw apiFailure(code);
}

/** Only canonical video and PGC page addresses are accepted at the trust boundary. */
export function parsePageUrl(input) {
  const invalid = () => failure('INVALID_URL', '仅支持 B 站 BV/av 视频及 ep/ss 剧集播放页，请检查地址和分 P。');
  let url;
  try { url = new URL(input); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw invalid();
  const ugc = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/i);
  if (ugc) {
    const parts = url.searchParams.getAll('p');
    if (parts.length > 1 || (parts.length && !/^[1-9]\d*$/.test(parts[0]))) throw invalid();
    const page = parts.length ? positiveId(parts[0]) : 1;
    if (!page) throw invalid();
    const id = ugc[1];
    const result = { kind: 'ugc', page };
    if (/^bv/i.test(id)) result.bvid = `BV${id.slice(2)}`;
    else { result.aid = positiveId(id.slice(2)); if (!result.aid) throw invalid(); }
    result.pageUrl = `${PAGE}/video/${result.bvid || `av${result.aid}`}${page > 1 ? `?p=${page}` : ''}`;
    return result;
  }
  const pgc = url.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)\/?$/i);
  if (pgc) {
    const id = positiveId(pgc[2]); if (!id) throw invalid();
    return { kind: 'pgc', [pgc[1].toLowerCase() === 'ep' ? 'epId' : 'seasonId']: id,
      pageUrl: `${PAGE}/bangumi/play/${pgc[1].toLowerCase()}${id}` };
  }
  throw invalid();
}

async function request(path, params, { fetchImpl = globalThis.fetch, signal, timeoutMs = 15000 } = {}, allowedCodes = []) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
  try {
    const url = new URL(path, API);
    for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, String(value));
    const response = await fetchImpl(url.href, { credentials: 'include', signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw apiFailure(response.status);
    let payload;
    try { payload = await response.json(); }
    catch (error) { if (controller.signal.aborted) throw error; throw failure('INVALID_RESPONSE', 'B 站接口未返回有效 JSON，请稍后重试。'); }
    checkApi(payload, allowedCodes);
    return payload;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
    if (timedOut) throw failure('REQUEST_TIMEOUT', 'B 站接口请求超时，请检查网络后重试。');
    if (error.code) throw error;
    throw failure('NETWORK_ERROR', '无法连接 B 站接口，请检查网络和扩展站点权限。');
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', relayAbort);
  }
}

export async function resolveMedia(url, options = {}) {
  const parsed = parsePageUrl(url);
  if (parsed.kind === 'pgc') return resolvePgc(parsed, options);
  const payload = await request('/x/web-interface/view', { bvid: parsed.bvid, aid: parsed.aid }, options);
  const data = payload.data;
  if (!isObject(data)) throw failure('INVALID_RESPONSE', '视频元数据缺失，请刷新网页后重试。');
  if (data.redirect_url) {
    let redirected;
    try { redirected = parsePageUrl(data.redirect_url); } catch { /* Ignore non-playback redirects. */ }
    if (redirected?.kind === 'pgc') return resolvePgc(redirected, options);
  }
  const bvid = /^BV[0-9A-Za-z]{10}$/.test(data.bvid) ? data.bvid : parsed.bvid;
  const aid = positiveId(data.aid) || parsed.aid;
  const pages = list(data.pages).filter(page => positiveId(page.cid) && positiveId(page.page));
  const page = pages.find(page => Number(page.page) === parsed.page);
  if (!page) throw failure('PART_NOT_FOUND', '这个分 P 已不存在，请重新选择分 P。');
  const canonical = `${PAGE}/video/${bvid || `av${aid}`}`;
  return { kind: 'ugc', bvid, aid, cid: Number(page.cid), title: String(data.title || bvid || `av${aid}`),
    partTitle: String(page.part || `P${page.page}`), pageUrl: `${canonical}?p=${page.page}`,
    duration: numeric(page.duration) ?? numeric(data.duration), selectedPartId: String(page.cid),
    parts: pages.map(part => ({ id: String(part.cid), title: `P${part.page} ${part.part || ''}`.trim(), pageUrl: `${canonical}?p=${part.page}` })) };
}

async function resolvePgc(parsed, options) {
  const payload = await request('/pgc/view/web/season', { ep_id: parsed.epId, season_id: parsed.seasonId }, options);
  const data = payload.result || payload.data;
  if (!isObject(data)) throw failure('INVALID_RESPONSE', '剧集元数据缺失，请刷新网页后重试。');
  const seen = new Set();
  const episodes = [...list(data.episodes), ...list(data.section).flatMap(section => list(section.episodes))]
    .filter(episode => {
      const id = positiveId(episode.id); if (!id || !positiveId(episode.cid) || seen.has(id)) return false;
      seen.add(id); return true;
    });
  const episode = parsed.epId ? episodes.find(item => Number(item.id) === parsed.epId) : episodes[0];
  if (!episode) throw failure('PART_NOT_FOUND', '没有找到所选剧集，请在 B 站打开具体剧集后重试。');
  const label = item => [item.title, item.long_title].filter(Boolean).join(' ') || `第 ${item.id} 集`;
  return { kind: 'pgc', bvid: episode.bvid, aid: positiveId(episode.aid), cid: Number(episode.cid), epId: Number(episode.id),
    seasonId: positiveId(data.season_id) || parsed.seasonId, title: String(data.title || 'B 站剧集'),
    partTitle: label(episode), pageUrl: `${PAGE}/bangumi/play/ep${episode.id}`, duration: numeric(episode.duration) === undefined ? undefined : Number(episode.duration) / 1000,
    selectedPartId: String(episode.id), parts: episodes.map(item => ({ id: String(item.id), title: label(item), pageUrl: `${PAGE}/bangumi/play/ep${item.id}` })) };
}

export async function getCatalog(context, options = {}) {
  const quality = options.quality === undefined || options.quality === null || options.quality === '' ? undefined : positiveId(options.quality);
  if (options.quality !== undefined && options.quality !== null && options.quality !== '' && !quality) throw failure('INVALID_QUALITY', '画质参数无效。');
  let fetchPlayInfo;
  if (context.kind === 'pgc') {
    if (!positiveId(context.epId)) throw failure('INVALID_CONTEXT', '剧集编号无效，请刷新网页。');
    fetchPlayInfo = qn => request('/pgc/player/web/v2/playurl', { ep_id: context.epId, fnval: 12240, qn }, options);
  } else if (context.kind === 'ugc' && positiveId(context.cid) && (/^BV[0-9A-Za-z]{10}$/.test(context.bvid) || positiveId(context.aid))) {
    const nav = await request('/x/web-interface/nav', {}, options, [-101]);
    const basename = value => String(value || '').split('/').at(-1).split('.')[0];
    const keys = nav.data?.wbi_img;
    if (!keys) throw failure('INVALID_RESPONSE', '未取得 B 站签名密钥，请刷新重试。');
    fetchPlayInfo = qn => request('/x/player/wbi/playurl', signWbi({ bvid: context.bvid, aid: context.bvid ? undefined : context.aid,
      cid: context.cid, fnval: 4048, qn }, basename(keys.img_url), basename(keys.sub_url)), options);
  } else throw failure('INVALID_CONTEXT', '视频编号无效，请刷新网页。');
  const catalog = normalizePlayInfo(await fetchPlayInfo(quality), context);
  if (quality && ![...catalog.videos, ...catalog.progressive].some(track => track.quality === quality)) {
    throw failure('QUALITY_UNAVAILABLE', '当前账号没有取得所选画质的资源，请选择实际可用的画质或在网页确认权限。');
  }
  // DASH already enumerates its actual representations. Legacy endpoints often
  // return only the current qn, so bounded sequential probes discover the rest.
  if (!quality && !catalog.videos.length && catalog.progressive.length) {
    let requests = 1;
    const candidates = [...new Set(catalog.qualities.map(item => positiveId(item.id)).filter(Boolean))];
    for (const candidate of candidates) {
      options.signal?.throwIfAborted();
      if (catalog.videos.length) break;
      if (catalog.progressive.some(track => track.quality === candidate)) continue;
      if (requests >= MAX_LEGACY_PLAY_REQUESTS) {
        catalog.warnings.push('已达到旧式资源画质查询上限，保留本次已确认的资源。');
        break;
      }
      requests++;
      try {
        const additional = normalizePlayInfo(await fetchPlayInfo(candidate), context);
        for (const field of ['videos', 'audios', 'progressive']) {
          catalog[field] = [...new Map([...catalog[field], ...additional[field]].map(track => [track.key, track])).values()];
        }
        catalog.qualities = [...new Map([...catalog.qualities, ...additional.qualities].map(item => [item.id, item])).values()];
        catalog.warnings.push(...additional.warnings);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error.name === 'AbortError') throw error;
        if (['RATE_LIMITED', 'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code) || !error.code) {
          catalog.warnings.push(`已停止查询其他画质，已确认的资源仍可下载。${error.message}`);
          break;
        }
        // Access-denied, missing, protected or preview-only quality probes do
        // not invalidate already confirmed full-length clear representations.
      }
    }
    const actual = new Set([...catalog.videos, ...catalog.progressive].map(track => track.quality));
    catalog.warnings = catalog.warnings.filter(warning => warning !== MISSING_QUALITY_WARNING);
    if (catalog.qualities.some(item => !actual.has(item.id))) catalog.warnings.push(MISSING_QUALITY_WARNING);
    catalog.warnings = [...new Set(catalog.warnings)];
  }
  return catalog;
}

function unwrap(payload) {
  const levels = []; let current = payload;
  for (let depth = 0; depth < 8 && isObject(current); depth++) {
    checkApi(current); levels.push(current);
    if (isObject(current.video_info)) { current = current.video_info; checkApi(current); levels.push(current); break; }
    if (current.dash || current.durl || current.durls) break;
    const next = current.raw || current.data || current.result;
    if (!isObject(next)) break;
    current = next;
  }
  if (!isObject(current)) throw failure('INVALID_RESPONSE', '播放资源数据格式无效。');
  return { info: current, levels };
}
function hasDrm(value) {
  return flag(value?.is_drm) || flag(value?.has_drm) || flag(value?.drm_tech_type) || flag(value?.drm_type);
}
function mediaUrls(source) {
  const candidates = [source.baseUrl, source.base_url, source.url,
    ...list(source.backupUrl), ...list(source.backup_url)];
  // Backup URL arrays are arrays of strings, whereas list() also accepts object
  // records for the platform's audio arrays.
  const output = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    let url;
    try { url = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) continue;
    if (!output.includes(url.href)) output.push(url.href);
  }
  return output;
}
function frameRate(value) {
  if (typeof value === 'string' && value.includes('/')) {
    const [n, d] = value.split('/').map(Number); return n > 0 && d > 0 ? n / d : undefined;
  }
  return numeric(value);
}

/** Parse only actual returned media. Published quality labels are not access proof. */
export function normalizePlayInfo(payload, context) {
  const { info, levels } = unwrap(payload);
  if (levels.some(hasDrm)) throw failure('DRM_PROTECTED', '这个资源启用了 DRM/加密保护，扩展不支持解密下载。');
  if (levels.some(level => flag(level.is_preview) || level.play_video_type === 'preview' || level.play_check?.play_detail === 'PLAY_PREVIEW')) {
    throw failure('PREVIEW_ONLY', '当前接口只返回试看资源，请先在网页确认完整播放权限。');
  }
  if (levels.some(level => level.play_video_type === 'none' || level.play_check?.play_detail === 'PLAY_NONE')) throw failure('NO_ACCESS', '当前账号未取得这段视频的播放权限。');
  const warnings = [];
  const qualityMap = new Map();
  for (const format of list(info.support_formats)) {
    const id = numeric(format.quality); if (id !== undefined) qualityMap.set(id, String(format.new_description || format.display_desc || format.description || id));
  }
  list(info.accept_quality).forEach((value, i) => { const id = numeric(value); if (id !== undefined && !qualityMap.has(id)) qualityMap.set(id, String(info.accept_description?.[i] || id)); });
  const qualityLabel = quality => qualityMap.get(quality) || `${quality}`;
  const duration = numeric(info.timelength) === undefined ? context.duration : Number(info.timelength) / 1000;
  const trackLists = { videos: [], audios: [], progressive: [] };
  const seen = new Map();
  const putDash = (source, kind, audioRole) => {
    if (!isObject(source)) return;
    if (hasDrm(source)) throw failure('DRM_PROTECTED', '返回的音视频轨道启用了 DRM/加密保护，扩展不支持解密下载。');
    const urls = mediaUrls(source);
    if (!urls.length) { warnings.push('已忽略缺少可信媒体地址的轨道。'); return; }
    const quality = numeric(source.id) ?? 0;
    const codec = String(source.codecs || source.codec || 'unknown');
    const width = numeric(source.width), height = numeric(source.height), fps = frameRate(source.frameRate ?? source.frame_rate);
    const bandwidth = numeric(source.bandwidth) ?? 0;
    const key = [kind, quality, codec, audioRole || '', width || '', height || '', fps || '', bandwidth].join(':');
    if (seen.has(key)) { const existing = seen.get(key); existing.urls = [...new Set([...existing.urls, ...urls])]; return; }
    const track = { key, kind, quality, qualityLabel: kind === 'audio' ? audioRole === 'dolby' ? '杜比音轨' : audioRole === 'flac' ? 'Hi-Res / FLAC' : '普通音轨' : qualityLabel(quality),
      codec, mime: String(source.mimeType || source.mime_type || (kind === 'video' ? 'video/mp4' : 'audio/mp4')),
      bandwidth, urls, duration };
    const size = numeric(source.size); if (size !== undefined && size >= 0) track.size = size;
    if (kind === 'video') { track.width = width; track.height = height; track.fps = fps; }
    else track.audioRole = audioRole;
    trackLists[kind === 'video' ? 'videos' : 'audios'].push(track); seen.set(key, track);
  };
  for (const item of list(info.dash?.video)) putDash(item, 'video');
  for (const item of list(info.dash?.audio)) putDash(item, 'audio', 'standard');
  for (const item of list(info.dash?.dolby?.audio)) putDash(item, 'audio', 'dolby');
  for (const item of list(info.dash?.flac?.audio)) putDash(item, 'audio', 'flac');

  const putProgressive = source => {
    if (!isObject(source)) return;
    checkApi(source);
    if (hasDrm(source) || list(source.durl).some(hasDrm)) throw failure('DRM_PROTECTED', '返回的视频分段启用了 DRM/加密保护，扩展不支持解密下载。');
    if (flag(source.is_preview)) throw failure('PREVIEW_ONLY', '当前画质组只返回试看资源，请先在网页确认完整播放权限。');
    const segments = list(source.durl).map((item, index) => ({ item, index }))
      .sort((a, b) => (numeric(a.item?.order) ?? a.index + 1) - (numeric(b.item?.order) ?? b.index + 1))
      .map(({ item }) => ({ urls: isObject(item) ? mediaUrls(item) : [], size: numeric(item?.size), duration: numeric(item?.length) === undefined ? undefined : Number(item.length) / 1000 }));
    if (!segments.length) return;
    if (segments.some(segment => !segment.urls.length)) throw failure('INVALID_MEDIA_URL', '分段资源缺少可信下载地址，无法生成完整文件。');
    const quality = numeric(source.quality) ?? 0;
    const flv = String(source.format || '').includes('flv') || segments[0].urls[0].split('?')[0].endsWith('.flv');
    // durls groups describe separate representations. The outer format/codec
    // describes only the currently selected quality, not every group.
    const codec = String(source.codecs || source.codec || 'unknown');
    const track = { key: `progressive:${quality}:${codec}:${flv ? 'flv' : 'mp4'}`, kind: 'progressive', quality, qualityLabel: qualityLabel(quality),
      codec, mime: String(source.mimeType || source.mime_type || (flv ? 'video/x-flv' : 'video/mp4')),
      bandwidth: numeric(source.bandwidth) ?? 0, urls: segments[0].urls, segments,
      duration: numeric(source.timelength) === undefined ? duration : Number(source.timelength) / 1000 };
    if (segments.every(segment => segment.size !== undefined && segment.size >= 0)) track.size = segments.reduce((sum, segment) => sum + segment.size, 0);
    const existing = seen.get(track.key);
    if (existing && existing.segments.length === segments.length) {
      existing.segments.forEach((segment, index) => { segment.urls = [...new Set([...segment.urls, ...segments[index].urls])]; });
      existing.urls = existing.segments[0].urls;
      return;
    }
    // Different segment layouts must not share a selectable key.
    if (existing) track.key += `:segments-${segments.length}`;
    trackLists.progressive.push(track); seen.set(track.key, track);
  };
  putProgressive(info);
  for (const group of list(info.durls)) {
    if (!isObject(group)) continue;
    const isCurrentQuality = numeric(group.quality) !== undefined && numeric(group.quality) === numeric(info.quality);
    putProgressive({ ...(isCurrentQuality ? { format: info.format, codecs: info.codecs, codec: info.codec } : {}), ...group });
  }
  if (!trackLists.videos.length && !trackLists.audios.length && !trackLists.progressive.length) throw failure('NO_MEDIA', '接口没有返回可下载的媒体资源，请确认网页可完整播放并刷新。');
  const actualQualities = new Set([...trackLists.videos, ...trackLists.progressive].map(track => track.quality));
  const missing = [...qualityMap.keys()].filter(quality => !actualQualities.has(quality));
  if (missing.length) warnings.push(MISSING_QUALITY_WARNING);
  return { context, ...trackLists, qualities: [...qualityMap].map(([id, label]) => ({ id, label })), warnings: [...new Set(warnings)] };
}
