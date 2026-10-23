import panelStyles from './panel.css';
import { availableFormats, availableQualities, createCatalogLoader, errorText, FORMATS, jobProgress, reconcileSelection, selectionForEnqueue, videoTracksForQuality } from './ui-state.js';

export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== false) node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function requestBackground(type, payload = {}) {
  let response;
  try { response = await chrome.runtime.sendMessage({ target: 'background', type, payload }); }
  catch (error) {
    if (/context invalidated|receiving end does not exist|message port closed/i.test(errorText(error))) {
      throw new Error('扩展连接已更新，请刷新这个 B 站页面后重试。');
    }
    throw error;
  }
  if (!response?.ok) throw new Error(errorText(response?.error || '扩展没有响应，请稍后重试。'));
  return response.data;
}

const STATUS = {
  queued: '等待中', preparing: '准备资源', running: '执行中', downloading: '下载中',
  processing: '本地处理中', saving: '正在保存', completed: '已完成', failed: '失败',
  cancelled: '已取消', interrupted: '已中断',
};
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export function createJobsView({ compact = false, visible = () => !document.hidden } = {}) {
  const list = element('div', { className: 'job-list', 'aria-label': '下载任务列表' });
  const error = element('p', { className: 'feedback error', role: 'alert', hidden: true });
  const count = element('span', { className: 'count', text: '0' });
  const refresh = element('button', { className: 'text-button', type: 'button', text: '刷新任务', onClick: () => poll() });
  const header = element('div', { className: 'section-heading' }, element('h2', { text: compact ? '最近任务' : '下载任务' }), count, refresh);
  const root = element('section', { className: compact ? 'jobs compact' : 'jobs' }, header, error, list);
  let active = false;
  let timer;
  let generation = 0;
  let fingerprint = '';
  const folderActions = new Map();

  function updateFolderAction(action) {
    action.button.disabled = action.pending;
    action.button.textContent = action.pending ? '正在打开…' : '打开所在文件夹';
    action.button.setAttribute('aria-busy', String(action.pending));
    action.feedback.hidden = !action.message;
    action.feedback.textContent = action.message;
  }

  function render(jobs) {
    count.textContent = String(jobs.length);
    const jobIds = new Set(jobs.map((job) => job.id));
    for (const id of folderActions.keys()) if (!jobIds.has(id)) folderActions.delete(id);
    if (!jobs.length) {
      list.replaceChildren(element('div', { className: 'empty-state' }, element('span', { className: 'empty-icon', 'aria-hidden': true, text: '↓' }), element('p', { text: '还没有下载任务' }), element('small', { text: '选好资源后，任务会显示在这里。' })));
      return;
    }
    const ordered = [...jobs].sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt)));
    list.replaceChildren(...ordered.map((job) => {
      const percent = jobProgress(job);
      const status = element('span', { className: `job-status status-${job.status}`, text: STATUS[job.status] || '处理中' });
      const title = element('h3', { className: 'job-title', text: job.title || '下载任务', title: job.title || '下载任务' });
      const row = element('div', { className: 'job-top' }, title, status);
      const message = element('p', { className: 'job-message', text: errorText(job.error || job.message || STATUS[job.status] || '处理中') });
      const details = element('div', { className: 'job-details' }, message);
      if (!TERMINAL.has(job.status)) {
        const cancel = element('button', {
          type: 'button', className: 'cancel-button', 'aria-label': `取消任务：${job.title || '下载任务'}`, text: '取消',
          onClick: async () => {
            cancel.disabled = true;
            try { await requestBackground('CANCEL', { id: job.id }); fingerprint = ''; await poll(); }
            catch (cause) { error.hidden = false; error.textContent = errorText(cause); cancel.disabled = false; }
          },
        });
        details.append(cancel);
      } else if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
        const retry = element('button', {
          type: 'button', className: 'cancel-button retry-button', 'aria-label': `重试任务：${job.title || '下载任务'}`, text: '重试',
          onClick: async () => {
            retry.disabled = true;
            try { await requestBackground('RETRY', { id: job.id }); fingerprint = ''; await poll(); }
            catch (cause) { error.hidden = false; error.textContent = errorText(cause); retry.disabled = false; }
          },
        });
        details.append(retry);
      }
      const body = element('article', { className: 'job-card', 'data-job-id': job.id }, row, details);
      if (job.downloadIds?.length) {
        const action = folderActions.get(job.id) || { pending: false, message: '' };
        folderActions.set(job.id, action);
        action.button = element('button', {
          type: 'button', className: 'cancel-button folder-button', text: '打开所在文件夹',
          onClick: async () => {
            if (action.pending) return;
            action.pending = true;
            action.message = '';
            updateFolderAction(action);
            try { await requestBackground('SHOW_DOWNLOAD_FOLDER', { id: job.id }); }
            catch (cause) { action.message = errorText(cause); }
            finally { action.pending = false; updateFolderAction(action); }
          },
        });
        action.feedback = element('p', { className: 'feedback error job-folder-feedback', role: 'alert', hidden: true });
        updateFolderAction(action);
        body.append(element('div', { className: 'job-actions' }, action.button), action.feedback);
      }
      if (!TERMINAL.has(job.status)) {
        const progress = element('progress', { max: '100', 'aria-label': `${job.title || '任务'}进度` });
        if (percent !== null) progress.value = percent;
        body.append(element('div', { className: 'progress-row' }, progress, element('span', { text: percent === null ? '…' : `${percent}%` })));
      }
      return body;
    }));
  }

  async function poll() {
    clearTimeout(timer);
    if (!active || !visible()) return;
    const current = ++generation;
    try {
      const jobs = await requestBackground('JOBS');
      if (!active || current !== generation || !visible()) return;
      error.hidden = true;
      const next = JSON.stringify(jobs);
      if (fingerprint !== next) { fingerprint = next; render(jobs); }
    } catch (cause) {
      if (active && current === generation) { error.hidden = false; error.textContent = errorText(cause); }
    } finally {
      if (active && current === generation && visible()) timer = setTimeout(poll, 1200);
    }
  }
  render([]);
  return {
    element: root,
    start() { if (!active) { active = true; poll(); } },
    stop() { active = false; ++generation; clearTimeout(timer); },
    refresh: poll,
  };
}

function setOptions(select, options, value) {
  select.replaceChildren(...options.map(([key, label]) => element('option', { value: key, text: label })));
  if (value !== undefined && options.some(([key]) => String(key) === String(value))) select.value = String(value);
}

function trackLabel(track) {
  const details = [track.qualityLabel, track.codec];
  if (track.width && track.height) details.push(`${track.width}×${track.height}`);
  if (track.fps) details.push(`${track.fps} fps`);
  if (track.audioRole && !['normal', 'default'].includes(track.audioRole)) details.push(track.audioRole);
  if (track.bandwidth) details.push(`${Math.round(track.bandwidth / 1000)} kbps`);
  if (track.kind === 'progressive') details.push('音画合一');
  return details.filter(Boolean).join(' · ') || '原始资源';
}

export function createPanel(host, initialUrl) {
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(element('style', { text: panelStyles }));
  let pageUrl = initialUrl;
  let chosenUrl = initialUrl;
  let open = false;
  let enqueueing = false;
  let selection = { mode: 'video', format: 'mp4' };
  let lastFocus;

  const launcher = element('button', { id: 'bili-launcher', className: 'launcher', type: 'button', 'aria-label': '打开下载面板', 'aria-expanded': 'false', 'aria-controls': 'bili-panel' }, element('span', { className: 'launcher-icon', 'aria-hidden': true, text: '↓' }), element('span', { text: '下载' }));
  const close = element('button', { className: 'icon-button close', type: 'button', 'aria-label': '关闭下载面板', text: '×' });
  const title = element('h2', { id: 'bili-title', text: '准备好，带走喜欢的片段。' });
  const subtitle = element('p', { className: 'media-subtitle', text: '读取当前页面提供的真实播放资源' });
  const connection = element('span', { className: 'connection', text: '待读取' });
  const refresh = element('button', { className: 'icon-button', type: 'button', 'aria-label': '重新获取资源', text: '↻' });
  const heading = element('header', { className: 'panel-header' }, element('div', { className: 'brand' }, element('span', { className: 'brand-mark', 'aria-hidden': true, text: '↓' }), element('div', {}, element('strong', { text: 'Bili 本地下载' }), element('small', { text: 'LOCAL FILES, YOUR CHOICE' }))), element('div', { className: 'header-actions' }, refresh, close));
  const hero = element('section', { className: 'media-heading' }, element('div', { className: 'eyebrow' }, element('span', { text: '当前资源' }), connection), title, subtitle);
  const part = element('select', { id: 'bili-part', 'aria-label': '选择分 P 或剧集' });
  const quality = element('select', { id: 'bili-quality', 'aria-label': '选择画质' });
  const video = element('select', { id: 'bili-video', 'aria-label': '选择视频编码' });
  const audio = element('select', { id: 'bili-audio', 'aria-label': '选择音轨' });
  const format = element('select', { id: 'bili-format', 'aria-label': '选择输出格式' });
  const rawTarget = element('select', { id: 'bili-raw-target', 'aria-label': '选择原始轨类型' });
  function field(label, control, hint) {
    return element('div', { className: 'field' }, element('label', { for: control.id, text: label }), control, hint ? element('small', { text: hint }) : null);
  }
  const partField = field('分 P / 剧集', part, '此处选集仅决定下载内容，不切换网页播放器。');
  const qualityField = field('画质', quality, '仅列出本次已取得真实资源的画质。');
  const videoField = field('视频资源 / 编码', video);
  const audioField = field('音轨', audio);
  const formatField = field('保存格式', format);
  const rawField = field('下载内容', rawTarget);
  const tabs = element('div', { className: 'tabs', role: 'tablist', 'aria-label': '下载类型' });
  const tabButtons = ['video', 'audio', 'raw'].map((mode, index) => {
    const button = element('button', { type: 'button', id: `tab-${mode}`, role: 'tab', 'aria-controls': 'bili-options', 'aria-selected': String(index === 0), tabindex: index === 0 ? '0' : '-1', 'data-mode': mode, text: ['视频', '音频', '原始轨'][index] });
    button.addEventListener('click', () => setMode(mode));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      tabButtons[next].click(); tabButtons[next].focus();
    });
    tabs.append(button); return button;
  });
  const notes = element('p', { className: 'format-note' });
  const warnings = element('div', { className: 'warnings', hidden: true });
  const feedback = element('p', { className: 'feedback', role: 'status', 'aria-live': 'polite', hidden: true });
  const submit = element('button', { type: 'submit', id: 'bili-download', className: 'primary-button', disabled: true, text: '加入下载任务' });
  const options = element('div', { id: 'bili-options', role: 'tabpanel', 'aria-labelledby': 'tab-video' }, rawField, qualityField, videoField, audioField, formatField, notes);
  const form = element('form', { className: 'download-form' }, partField, tabs, options, warnings, feedback, submit, element('p', { className: 'local-note', text: '浏览器本地处理 · 合并 / 转码输入上限 512 MiB' }));
  const jobs = createJobsView({ compact: true, visible: () => open && !document.hidden });
  const allTasks = element('button', { className: 'text-button all-tasks', type: 'button', text: '打开全部任务 ↗', onClick: async () => { try { await requestBackground('OPEN_TASKS'); } catch (cause) { showFeedback(errorText(cause), true); } } });
  const panel = element('section', { id: 'bili-panel', className: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Bili 本地下载面板', hidden: true }, heading, element('div', { className: 'panel-scroll' }, hero, form, jobs.element, allTasks));
  shadow.append(panel, launcher);
  const loader = createCatalogLoader((payload) => requestBackground('CATALOG', payload), renderState);

  function showFeedback(message, isError = false) {
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.className = isError ? 'feedback error' : 'feedback success';
    feedback.setAttribute('role', isError ? 'alert' : 'status');
  }

  function renderState(state) {
    panel.dataset.state = state.loading ? 'loading' : state.error ? 'error' : state.catalog ? 'ready' : 'idle';
    connection.textContent = state.loading ? '读取中…' : state.error ? '读取失败' : state.catalog ? '资源已就绪' : '待读取';
    refresh.disabled = state.loading;
    if (state.loading) showFeedback('正在读取所选分 P / 剧集的可用资源…');
    else if (state.error) showFeedback(state.error, true);
    else showFeedback('');
    if (state.catalog) {
      selection = reconcileSelection(state.catalog, selection, state.quality);
      const context = state.catalog.context;
      title.textContent = context.title || '当前视频';
      title.title = context.title || '';
      const length = Number(context.duration);
      const duration = Number.isFinite(length) && length > 0 ? `${Math.floor(length / 60)}:${String(Math.floor(length % 60)).padStart(2, '0')}` : '';
      subtitle.textContent = [context.partTitle, duration].filter(Boolean).join(' · ') || '按原始资源选择画质与编码';
      const parts = context.parts?.length ? context.parts : [{ id: context.selectedPartId || 'current', title: context.partTitle || '当前视频', pageUrl: context.pageUrl || chosenUrl }];
      setOptions(part, parts.map((item, index) => [item.pageUrl, `${context.kind === 'pgc' ? '第 ' + (index + 1) + ' 集' : 'P' + (index + 1)} · ${item.title || '未命名'}`]), parts.find((item) => String(item.id) === String(context.selectedPartId))?.pageUrl || context.pageUrl || chosenUrl);
      chosenUrl = part.value || context.pageUrl || chosenUrl;
      const selectedTrack = videoTracksForQuality(state.catalog).find((item) => item.key === selection.videoKey);
      const selectedQuality = state.quality ?? selectedTrack?.quality;
      const videoTracks = videoTracksForQuality(state.catalog, selectedQuality);
      setOptions(quality, availableQualities(state.catalog).map((item) => [item.id, item.label]), selectedQuality);
      if (!quality.options.length) setOptions(quality, [['', '原始画质']]);
      setOptions(video, videoTracks.length ? videoTracks.map((item) => [item.key, trackLabel(item)]) : [['', '没有可用视频轨']], selection.videoKey);
      setOptions(audio, state.catalog.audios.length ? state.catalog.audios.map((item) => [item.key, trackLabel(item)]) : [['', state.catalog.progressive.length ? '从音画合一资源提取音频' : '没有独立音轨']], selection.audioKey);
      warnings.replaceChildren(...(state.catalog.warnings || []).map((warning) => element('p', { text: warning })));
      warnings.hidden = !state.catalog.warnings?.length;
    }
    renderControls();
  }

  function renderControls() {
    const catalog = loader.state.catalog;
    const busy = loader.state.loading || enqueueing || !catalog;
    const videos = catalog ? [...catalog.videos, ...catalog.progressive] : [];
    const selectedVideo = videos.find((track) => track.key === selection.videoKey);
    const hasVideo = videos.length > 0;
    const hasAudio = Boolean(catalog?.audios.length);
    tabButtons.forEach((button) => {
      const selected = button.dataset.mode === selection.mode;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    options.setAttribute('aria-labelledby', `tab-${selection.mode}`);
    rawField.hidden = selection.mode !== 'raw';
    const wantsVideo = selection.mode === 'video' || (selection.mode === 'raw' && selection.rawTarget !== 'audio');
    qualityField.hidden = !wantsVideo;
    videoField.hidden = !wantsVideo;
    audioField.hidden = selection.mode === 'raw' ? selection.rawTarget === 'video' : selection.mode === 'video' && selectedVideo?.kind === 'progressive';
    setOptions(format, availableFormats(catalog, selection.mode), selection.format);
    const rawOptions = [];
    if (hasVideo && hasAudio) rawOptions.push(['both', '视频轨 + 音轨 · 分别保存']);
    if (hasVideo) rawOptions.push(['video', selectedVideo?.kind === 'progressive' ? '原始视频文件 · 音画合一' : '仅视频轨 · 可能没有声音']);
    if (hasAudio) rawOptions.push(['audio', '仅音轨']);
    setOptions(rawTarget, rawOptions, selection.rawTarget);
    [part, quality, video, audio, format, rawTarget].forEach((control) => { control.disabled = busy; });
    quality.disabled = busy || (catalog ? availableQualities(catalog).length < 2 : true);
    video.disabled = busy || !hasVideo;
    audio.disabled = busy || !hasAudio;
    const canExtractAudio = Boolean(catalog?.progressive.length) && selection.format !== 'original';
    const possible = selection.mode === 'audio' ? hasAudio || canExtractAudio : selection.mode === 'video' ? hasVideo : (selection.rawTarget === 'audio' ? hasAudio : hasVideo);
    submit.disabled = busy || !possible;
    submit.textContent = enqueueing ? '正在加入任务…' : selection.mode === 'raw' ? '下载原始文件' : selection.mode === 'audio' ? '下载音频' : '下载视频';
    let note;
    if (selection.mode === 'raw') note = '原始轨先流式写入浏览器临时存储，再由 Chrome 保存。不受 512 MiB 输入限制，但需要足够磁盘空间和存储配额。分离视频轨通常没有声音。';
    else if (selection.mode === 'audio') {
      note = selection.format === 'original' ? '保留原始编码与音质；先写入浏览器临时存储，再保存。受磁盘和存储配额限制，不受 512 MiB 输入预算限制。' : selection.format === 'm4a' ? 'AAC 音轨无损封装；其他编码将转成 AAC，并在任务中说明。' : ['flac', 'wav'].includes(selection.format) ? '本地转换为所选格式。转成 FLAC / WAV 不会提升源音质，文件通常更大。' : '在浏览器本地转成 MP3，有损转换会改变源音质。';
      if (catalog && !hasAudio) note = canExtractAudio ? '当前资源为音画合一文件，将下载完整原始视频并提取音频，计入 512 MiB 处理预算。' : '当前资源没有可提取的音轨。可选择「原始轨」保存原始视频文件。';
    } else note = hasVideo && !hasAudio && selectedVideo?.kind !== 'progressive' ? '当前资源没有独立音轨；下载的视频将不包含声音。' : '保留所选画质与编码，无损封装。若编码不兼容该容器，会提示更换格式。';
    notes.textContent = note;
  }

  function setMode(mode) {
    selection.mode = mode;
    selection.format = FORMATS[mode][0][0];
    if (loader.state.catalog) selection = reconcileSelection(loader.state.catalog, selection, loader.state.quality);
    showFeedback(''); renderControls();
  }
  async function load(url = chosenUrl, ...qualityChoice) {
    if (!url) return;
    const selectedQuality = qualityChoice.length ? qualityChoice[0] : loader.state.quality;
    chosenUrl = url;
    await loader.load(url, selectedQuality);
  }
  part.addEventListener('change', () => { selection = { mode: selection.mode, format: selection.format }; load(part.value, undefined); });
  quality.addEventListener('change', () => load(chosenUrl, Number(quality.value)));
  video.addEventListener('change', () => { selection.videoKey = video.value; renderControls(); });
  audio.addEventListener('change', () => { selection.audioKey = audio.value; renderControls(); });
  format.addEventListener('change', () => { selection.format = format.value; renderControls(); });
  rawTarget.addEventListener('change', () => { selection.rawTarget = rawTarget.value; renderControls(); });
  refresh.addEventListener('click', () => load());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    enqueueing = true; renderControls();
    try {
      await requestBackground('ENQUEUE', { url: chosenUrl, selection: selectionForEnqueue(loader.state.catalog, selection) });
      showFeedback('已加入下载任务。关闭面板后，任务仍会继续。');
      jobs.refresh();
    } catch (cause) { showFeedback(errorText(cause), true); }
    finally { enqueueing = false; renderControls(); }
  });
  function setOpen(value) {
    if (value && !pageUrl) return;
    open = value;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? '收起下载面板' : '打开下载面板');
    if (open) {
      lastFocus = document.activeElement;
      close.focus();
      if (!loader.state.catalog && !loader.state.loading) load();
      if (!document.hidden) jobs.start();
    } else { jobs.stop(); if (lastFocus?.isConnected && lastFocus !== host) lastFocus.focus(); else launcher.focus(); }
  }
  launcher.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } });
  document.addEventListener('visibilitychange', () => { if (open && !document.hidden) jobs.start(); else jobs.stop(); });
  renderControls();
  return {
    open() { setOpen(true); },
    setPageUrl(url) {
      if (pageUrl === url) return;
      pageUrl = url; chosenUrl = url;
      selection = { mode: selection.mode, format: selection.format };
      loader.invalidate();
      host.hidden = !url;
      if (!url) setOpen(false);
      else if (open) load(url, undefined);
    },
  };
}
