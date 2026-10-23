import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['src', 'static', 'scripts', 'tests', 'fixtures', 'docs'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'manifest.json', '.npmrc', '.gitignore', '.gitattributes', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE'];
const EXCLUDED = new Set(['.git', '.cache', '.tools', '.agents', '.codex', '__pycache__', 'node_modules', 'dist', 'release', 'test-results']);

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[:\x00]/.test(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) throw new Error(`不安全的打包路径：${value}`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`不安全的打包路径：${value}`);
  return normalized;
}

async function collectTree(root, relative, { optional = false, exclude = false } = {}) {
  relative = safeRelative(relative);
  const absolute = path.resolve(root, relative);
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if (optional && error.code === 'ENOENT') return []; throw error; }
  if (info.isSymbolicLink()) throw new Error(`拒绝打包符号链接或目录联接：${relative}`);
  const resolved = await realpath(absolute);
  const boundary = path.relative(await realpath(root), resolved);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error(`打包文件超出项目：${relative}`);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new Error(`不支持的文件类型：${relative}`);
  const files = [];
  for (const name of (await readdir(absolute)).sort()) {
    if (exclude && (EXCLUDED.has(name) || name.endsWith('.pyc'))) continue;
    files.push(...await collectTree(root, `${relative}/${name}`, { exclude }));
  }
  return files;
}

export async function collectSourceFiles(root = ROOT) {
  const files = [];
  for (const name of SOURCE_FILES) files.push(...await collectTree(root, name));
  for (const directory of SOURCE_DIRS) files.push(...await collectTree(root, directory, { optional: directory === 'fixtures', exclude: true }));
  return files.sort();
}

async function createPlan() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('package.json 版本号无效。');
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'dist/manifest.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error('dist 版本与 package.json 不一致，请先 npm run build。');
  const required = ['dist/content.js', 'dist/background.js', 'dist/offscreen.js', 'dist/popup.js', 'dist/tasks.js', 'dist/popup.html', 'dist/tasks.html', 'dist/offscreen.html', 'dist/vendor/core/ffmpeg-core.wasm', 'dist/vendor/core/ffmpeg-core.js', 'dist/vendor/ffmpeg/worker.js', 'dist/LICENSE', 'dist/licenses/GPL-2.0.txt', 'dist/licenses/GPL-3.0.txt', 'dist/licenses/ffmpeg-wasm-MIT.txt', 'docs/TEST_REPORT.md'];
  for (const name of required) {
    const files = await collectTree(ROOT, name);
    if (files.length !== 1) throw new Error(`缺少发布文件：${name}`);
  }
  for (const name of ['README.md', 'CHANGELOG.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) {
    if (!(await readFile(path.join(ROOT, name))).equals(await readFile(path.join(ROOT, 'dist', name)))) throw new Error(`dist/${name} 已过期，请重新构建。`);
  }
  const base = `bili-local-downloader-${pkg.version}`;
  const runtimeFiles = await collectTree(ROOT, 'dist', { exclude: false });
  const runtimeEntries = runtimeFiles.map(source => ({ source, archive: `${base}/${source.slice('dist/'.length)}` }));
  const reportPath = `${base}/docs/TEST_REPORT.md`;
  const existingReport = runtimeEntries.findIndex(entry => entry.archive === reportPath);
  if (existingReport !== -1) runtimeEntries.splice(existingReport, 1);
  runtimeEntries.push({ source: 'docs/TEST_REPORT.md', archive: reportPath });
  return {
    version: pkg.version,
    archives: [
      { name: `${base}.zip`, entries: runtimeEntries.sort((a, b) => a.archive.localeCompare(b.archive)) },
      { name: `${base}-source.zip`, entries: (await collectSourceFiles()).map(source => ({ source, archive: `${base}-source/${source}` })) },
    ],
  };
}

function pythonCommand() {
  const candidates = process.env.PYTHON ? [[process.env.PYTHON, []]] : [['python', []], ['python3', []], ['py', ['-3']]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { shell: false, windowsHide: true, stdio: 'ignore' });
    if (result.status === 0) return { command, prefix };
  }
  throw new Error('打包需要 Python 3.8+；请安装 Python 或将 PYTHON 设置为解释器完整路径。日常使用扩展不需要 Python。');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('用法：node scripts/package.mjs [--check]');
  const plan = await createPlan();
  if (args.includes('--check')) {
    for (const archive of plan.archives) console.log(`CHECK ${archive.name}: ${archive.entries.length} files`);
    console.log('打包输入检查通过；未生成 ZIP。');
    return;
  }
  const python = pythonCommand();
  await new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefix, path.join(ROOT, 'scripts/package.py'), ROOT], { shell: false, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'], cwd: ROOT });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ZIP 打包失败（退出码 ${code}）。`)));
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(plan));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
