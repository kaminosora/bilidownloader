import { createJobsView } from './panel.js';

const jobs = createJobsView();
document.getElementById('tasks-root').append(jobs.element);
if (!document.hidden) jobs.start();
document.addEventListener('visibilitychange', () => { if (document.hidden) jobs.stop(); else jobs.start(); });
addEventListener('pagehide', () => jobs.stop());
