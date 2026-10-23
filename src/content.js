import { createPanel } from './panel.js';
import { supportedPageUrl } from './ui-state.js';

if (!document.getElementById('bili-local-downloader')) {
  const host = document.createElement('div');
  host.id = 'bili-local-downloader';
  const initialUrl = supportedPageUrl(location.href);
  host.hidden = !initialUrl;
  document.documentElement.append(host);
  const panel = createPanel(host, initialUrl);
  const checkNavigation = () => panel.setPageUrl(supportedPageUrl(location.href));
  // Isolated worlds cannot rely on observing the page's history.pushState override.
  setInterval(checkNavigation, 800);
  addEventListener('popstate', checkNavigation);
  addEventListener('hashchange', checkNavigation);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'OPEN_PANEL') return;
    checkNavigation();
    if (!supportedPageUrl(location.href)) { respond({ ok: false, error: '请先打开 B 站视频或番剧播放页。' }); return; }
    panel.open();
    respond({ ok: true });
  });
}
