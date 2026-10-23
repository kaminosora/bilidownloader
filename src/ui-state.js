export function supportedPageUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'www.bilibili.com') return null;
    const ugc = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/i);
    const pgc = url.pathname.match(/^\/bangumi\/play\/(?:ep|ss)(\d+)\/?$/i);
    if (!ugc && !pgc) return null;
    const numericId = pgc?.[1] || (/^av/i.test(ugc?.[1] || '') ? ugc[1].slice(2) : null);
    if (numericId && (!Number.isSafeInteger(Number(numericId)) || Number(numericId) <= 0)) return null;
    if (ugc) {
      const parts = url.searchParams.getAll('p');
      if (parts.length > 1 || (parts.length && (!/^[1-9]\d*$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0]))))) return null;
    }
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.message || '操作未完成，请刷新资源后重试。';
}

export function createCatalogLoader(request, onChange = () => {}) {
  let generation = 0;
  let state = { url: '', quality: undefined, catalog: null, loading: false, error: '' };
  const update = (next) => { state = next; onChange(state); };
  return {
    get state() { return state; },
    async load(url, quality) {
      const current = ++generation;
      update({ url, quality, catalog: null, loading: true, error: '' });
      try {
        const catalog = await request({ url, ...(quality === undefined ? {} : { quality }) });
        if (current !== generation) return null;
        update({ url, quality, catalog, loading: false, error: '' });
        return catalog;
      } catch (error) {
        if (current === generation) update({ url, quality, catalog: null, loading: false, error: errorText(error) });
        return null;
      }
    },
    invalidate() {
      ++generation;
      update({ url: '', quality: undefined, catalog: null, loading: false, error: '' });
    },
  };
}

export const FORMATS = {
  video: [['mp4', 'MP4 · 无损封装'], ['mkv', 'MKV · 无损封装']],
  audio: [['original', '原始音轨'], ['m4a', 'M4A'], ['mp3', 'MP3'], ['wav', 'WAV'], ['flac', 'FLAC']],
  raw: [['original', '原始文件 · 分别保存']],
};

export function availableFormats(catalog, mode) {
  return mode === 'audio' && !catalog?.audios?.length && catalog?.progressive?.length
    ? FORMATS.audio.filter(([format]) => format !== 'original') : FORMATS[mode];
}

export function videoTracksForQuality(catalog, quality) {
  const tracks = [...(catalog.videos || []), ...(catalog.progressive || [])];
  return quality === undefined || quality === null ? tracks : tracks.filter(track => Number(track.quality) === Number(quality));
}

export function availableQualities(catalog) {
  const tracks = videoTracksForQuality(catalog);
  const ids = [...new Set(tracks.map(track => track.quality).filter(value => value !== undefined))];
  return ids.map(id => ({ id, label: catalog.qualities?.find(item => Number(item.id) === Number(id))?.label || tracks.find(track => track.quality === id)?.qualityLabel || `画质 ${id}` }));
}

export function reconcileSelection(catalog, previous = {}, quality) {
  const mode = ['video', 'audio', 'raw'].includes(previous.mode) ? previous.mode : 'video';
  const videos = videoTracksForQuality(catalog, quality);
  const audios = catalog.audios || [];
  const videoKey = videos.find(({ key }) => key === previous.videoKey)?.key ?? videos[0]?.key;
  const audioKey = audios.find(({ key }) => key === previous.audioKey)?.key ?? audios[0]?.key;
  let rawTarget = previous.rawTarget || 'both';
  if (!videoKey) rawTarget = 'audio';
  else if (!audioKey) rawTarget = 'video';
  const formats = availableFormats(catalog, mode);
  const format = formats.some(([value]) => value === previous.format) ? previous.format : formats[0][0];
  return { mode, format, videoKey, audioKey, rawTarget };
}

export function jobProgress(job) {
  return Number.isFinite(job.progress) ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : null;
}

export function selectionForEnqueue(catalog, selection) {
  const video = [...(catalog.videos || []), ...(catalog.progressive || [])].find(({ key }) => key === selection.videoKey);
  return { ...selection, ...(video?.quality ? { quality: video.quality } : {}) };
}
