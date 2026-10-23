import { errorText, supportedPageUrl } from './ui-state.js';

const openPanel = document.getElementById('open-panel');
const openTasks = document.getElementById('open-tasks');
const status = document.getElementById('page-status');
const feedback = document.getElementById('popup-error');
let activeTab;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, payload });
  if (!response?.ok) throw new Error(errorText(response?.error || '扩展未响应，请稍后重试。'));
  return response.data;
}
function showError(error) { feedback.hidden = false; feedback.textContent = errorText(error); }

async function connectCurrentPage() {
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const supported = supportedPageUrl(activeTab?.url);
    openPanel.disabled = !supported;
    status.textContent = supported ? '已连接 B 站播放页' : '请先打开 B 站视频或番剧播放页';
    document.querySelector('.current-page').classList.toggle('connected', Boolean(supported));
  } catch (error) { status.textContent = '无法读取当前页面'; showError(error); }
}
connectCurrentPage();

openPanel.addEventListener('click', async () => {
  openPanel.disabled = true; feedback.hidden = true;
  try { await request('OPEN_PANEL', { tabId: activeTab.id }); window.close(); }
  catch (error) { showError(error); openPanel.disabled = false; }
});
openTasks.addEventListener('click', async () => {
  openTasks.disabled = true; feedback.hidden = true;
  try { await request('OPEN_TASKS'); window.close(); }
  catch (error) { showError(error); openTasks.disabled = false; }
});
