#!/usr/bin/env node
// Storage Cleaner for Windows: a local-only web UI that frees memory, clears
// known-safe caches and build output, manages startup apps and applies a few
// reversible performance settings.
//
//   node windows\server.mjs        (or double-click "Storage Cleaner.cmd")
//
// Env: PORT (default 7799, 0 = random), TOKEN, LOG_DIR (default %LOCALAPPDATA%\Storage Cleaner),
//      PROJECT_ROOTS (comma list of folders to scan for node_modules etc.), NO_OPEN=1, APP_PROFILE.
//
// Everything Windows-specific that Node cannot do on its own lives in helper.cs,
// compiled on first run with the C# compiler that ships with Windows.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('This is the Windows version. On macOS run: node server.mjs from the project folder.');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const ENV = process.env;
const LOCAL = ENV.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = ENV.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const WINDIR = ENV.SystemRoot || 'C:\\Windows';
const PROGRAMDATA = ENV.ProgramData || 'C:\\ProgramData';
const SYSDRIVE = (ENV.SystemDrive || 'C:').toUpperCase();
const DATA_DIR = ENV.LOG_DIR || path.join(LOCAL, 'Storage Cleaner');
const APP_PROFILE = ENV.APP_PROFILE || path.join(DATA_DIR, 'window');
let PORT = Number(ENV.PORT ?? 7799);
const TOKEN = ENV.TOKEN || crypto.randomBytes(16).toString('hex');

const L = (...p) => path.join(LOCAL, ...p);
const R = (...p) => path.join(ROAMING, ...p);
const W = (...p) => path.join(WINDIR, ...p);
const PD = (...p) => path.join(PROGRAMDATA, ...p);
const H = (...p) => path.join(HOME, ...p);
const MB = 1024 * 1024, GB = 1024 * MB;

// ---------- process helpers ----------

function run(cmd, args, { timeout = 120_000, input, verbatim = false } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 512 * MB, timeout, windowsHide: true, windowsVerbatimArguments: verbatim },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (input !== undefined) child.stdin.end(input);
  });
}

function ps(script, { timeout = 60_000 } = {}) {
  const enc = Buffer.from(`$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeout });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- native helper ----------

let HELPER = null;

async function buildHelper() {
  const src = path.join(HERE, 'helper.cs');
  const hash = crypto.createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 10);
  const out = path.join(DATA_DIR, 'bin', `helper-${hash}.exe`);
  if (existsSync(out)) return (HELPER = out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const csc = ['Framework64', 'Framework'].map((f) => W('Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!csc) throw new Error('The .NET Framework 4 C# compiler (csc.exe) was not found. It ships with Windows 10 and 11.');
  const r = await run(csc, ['-nologo', '-optimize', `-out:${out}`, '-r:System.Web.Extensions.dll', '-r:System.Management.dll', src]);
  if (r.code || !existsSync(out)) throw new Error(`Could not build the helper:\n${r.stdout}${r.stderr}`);
  // Remove helpers built from older versions of helper.cs.
  for (const f of await fs.readdir(path.dirname(out)).catch(() => [])) {
    if (f.startsWith('helper-') && f !== path.basename(out)) fs.rm(path.join(path.dirname(out), f), { force: true }).catch(() => {});
  }
  return (HELPER = out);
}

async function helper(cmd, input, { timeout = 600_000 } = {}) {
  const r = await run(HELPER, [cmd], { timeout, input: input === undefined ? '' : JSON.stringify(input) });
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new Error(`helper ${cmd} failed: ${(r.stderr || r.stdout).slice(0, 300) || 'no output'}`); }
  if (data && !Array.isArray(data) && data.error) throw new Error(data.error);
  return data;
}

async function sizesOf(paths) {
  if (!paths.length) return new Map();
  const rows = await helper('sizes', { paths });
  return new Map(rows.map((r) => [r.path, r.bytes]));
}

// ---------- system facts (gathered once) ----------

let IS_ADMIN = false;
let FOLDERS = {};
let SYSTEM_MEDIA = null; // 'SSD' | 'HDD' | 'Unspecified' | null

async function detectMedia() {
  const letter = SYSDRIVE[0];
  const r = await ps(`$n=(Get-Partition -DriveLetter ${letter} | Get-Disk).Number; (Get-PhysicalDisk | Where-Object DeviceId -eq "$n").MediaType`, { timeout: 30_000 });
  const m = r.stdout.trim();
  SYSTEM_MEDIA = /SSD|HDD|SCM/.test(m) ? m : 'Unspecified';
}

// ---------- file helpers ----------

async function rmForce(p) {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 2 });
}

// Empties a folder, skipping whatever Windows keeps locked. Returns a note or null.
async function clearContents(dir, filter) {
  if (!existsSync(dir)) return null;
  let names;
  try { names = await fs.readdir(dir); } catch (e) { throw new Error(e.code === 'EPERM' || e.code === 'EACCES' ? 'Access denied. Run as administrator.' : e.message); }
  if (filter) names = names.filter(filter);
  const skipped = [];
  await pool(names, 8, async (name) => { try { await rmForce(path.join(dir, name)); } catch { skipped.push(name); } });
  return skipped.length ? `Skipped ${skipped.length} item(s) in use by Windows or an open app.` : null;
}

function tilde(p) {
  if (!p) return p;
  const low = p.toLowerCase(), home = HOME.toLowerCase();
  return low === home ? '~' : low.startsWith(home + '\\') ? '~' + p.slice(HOME.length) : p;
}
function untilde(p) { return p === '~' ? HOME : p.startsWith('~\\') || p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p; }
const inside = (p, dir) => p.toLowerCase().startsWith(dir.toLowerCase().replace(/\\$/, '') + '\\');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function diskInfo() {
  const drives = await helper('drives');
  const sys = drives.find((d) => d.name.toUpperCase() === SYSDRIVE) || drives[0] || { total: 0, free: 0 };
  return { total: sys.total, free: sys.free, used: sys.total - sys.free, drive: SYSDRIVE, media: SYSTEM_MEDIA, drives };
}

// ---------- running apps ----------

// Processes whose name is in `names`, ignoring our own Edge app window.
async function runningOf(names) {
  const rows = await helper('cmdlines', { names });
  const prof = APP_PROFILE.toLowerCase();
  // A process that exits mid-query reports no command line; skip it.
  return new Set(rows.filter((r) => r.cmd && !r.cmd.toLowerCase().includes(prof)).map((r) => r.name.toLowerCase()));
}

// ---------- catalog of clearable things ----------
// Every clear action the server runs is defined here or registered by a scan.
// The UI only ever sends an id, never a path or a command.

const dirItem = (id, group, name, risk, note, paths, opt = {}) => ({ id, group, name, risk, note, paths, contents: true, ...opt });

const CATALOG = [
  dirItem('temp', 'Windows', 'Temporary files', 'safe',
    'Files apps leave behind in your Temp folder. Anything still in use is skipped.', [L('Temp')], { boost: true }),
  dirItem('win-temp', 'Windows', 'Windows temporary files', 'safe',
    'System-wide temp folder. Anything still in use is skipped.', [W('Temp')], { admin: true, boost: true }),
  dirItem('thumbs', 'Windows', 'Thumbnail & icon cache', 'safe',
    'Explorer rebuilds thumbnails as you browse. Files Explorer has open are skipped.', [L('Microsoft', 'Windows', 'Explorer')],
    { filter: (n) => /^(thumbcache|iconcache)_.*\.db$/i.test(n) }),
  dirItem('crash', 'Windows', 'Crash dumps', 'safe',
    'Memory dumps written when apps crashed. Only useful for debugging those crashes.', [L('CrashDumps')], { boost: true }),
  dirItem('crash-sys', 'Windows', 'System crash dumps', 'safe',
    'Memory dumps from blue screens. Only useful for diagnosing them.', [W('Minidump'), W('LiveKernelReports')], { admin: true, boost: true }),
  dirItem('wer', 'Windows', 'Error reports', 'safe',
    'Windows Error Reporting files that were already sent or queued.', [L('Microsoft', 'Windows', 'WER', 'ReportArchive'), L('Microsoft', 'Windows', 'WER', 'ReportQueue')], { boost: true }),
  dirItem('wer-sys', 'Windows', 'System error reports', 'safe',
    'System-wide Windows Error Reporting files.', [PD('Microsoft', 'Windows', 'WER', 'ReportArchive'), PD('Microsoft', 'Windows', 'WER', 'ReportQueue')], { admin: true, boost: true }),
  dirItem('wu', 'Windows', 'Windows Update downloads', 'safe',
    'Installer files for updates already installed. Windows downloads anything it still needs.', [W('SoftwareDistribution', 'Download')], { admin: true, boost: true }),
  dirItem('do', 'Windows', 'Delivery Optimization cache', 'safe',
    'Update pieces Windows keeps to share with other PCs.', [W('ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache')],
    { admin: true, boost: true, async clear() { const r = await ps('Delete-DeliveryOptimizationCache -Force'); if (r.code) return clearContents(this.paths[0]); return null; } }),
  dirItem('shader', 'Windows', 'Graphics shader caches', 'safe',
    'DirectX, NVIDIA, AMD and Intel shader caches. Games rebuild them; the first launch afterwards may stutter briefly.',
    [L('D3DSCache'), L('NVIDIA', 'DXCache'), L('NVIDIA', 'GLCache'), L('AMD', 'DxCache'), L('AMD', 'DxcCache'), L('AMD', 'GLCache'), L('Intel', 'ShaderCache')]),

  dirItem('npm', 'Developer caches', 'npm cache', 'safe', 'npm re-downloads packages on the next install.', [L('npm-cache', '_cacache')]),
  dirItem('pnpm', 'Developer caches', 'pnpm store', 'safe', 'pnpm re-downloads packages on the next install. Existing node_modules keep working.', [L('pnpm', 'store')]),
  dirItem('yarn', 'Developer caches', 'Yarn cache', 'safe', 'Yarn re-downloads packages on the next install.', [L('Yarn', 'Cache'), L('Yarn', 'Berry', 'cache')]),
  dirItem('bun', 'Developer caches', 'Bun package cache', 'safe', 'Bun re-downloads packages on the next install.', [H('.bun', 'install', 'cache')]),
  dirItem('pip', 'Developer caches', 'pip / uv caches', 'safe', 'Python tools re-download what they need.', [L('pip', 'Cache'), L('uv', 'cache')]),
  dirItem('gradle', 'Developer caches', 'Gradle caches', 'safe', 'Android/Gradle builds re-download dependencies once.', [H('.gradle', 'caches')]),
  dirItem('nuget', 'Developer caches', 'NuGet HTTP cache', 'safe', '.NET restores re-download packages when needed.', [L('NuGet', 'v3-cache'), L('NuGet', 'plugins-cache')]),
  dirItem('go', 'Developer caches', 'Go build & module cache', 'safe', 'Go re-downloads modules and rebuilds on the next build.', [L('go-build'), H('go', 'pkg', 'mod')]),
  dirItem('cargo', 'Developer caches', 'Cargo registry cache', 'safe', 'Rust crates are re-downloaded on the next build.', [H('.cargo', 'registry', 'cache')]),
  dirItem('electron', 'Developer caches', 'Electron download cache', 'safe', 'Electron builds re-download it once.', [L('electron', 'Cache'), L('electron-builder', 'Cache')]),
  dirItem('playwright', 'Developer caches', 'Playwright browsers', 'caution', 'Run "npx playwright install" again before running tests.', [L('ms-playwright')]),
  dirItem('pub', 'Developer caches', 'Flutter/Dart pub cache', 'caution', 'Flutter projects need "flutter pub get" again.', [L('Pub', 'Cache')]),
  dirItem('vscode-ws', 'Developer caches', 'VS Code workspace storage', 'caution',
    'Per-project state (open tabs, some extension data) resets. Quit VS Code first.', [R('Code', 'User', 'workspaceStorage')], { procs: ['Code'] }),
];

// Chromium-based browsers: only cache folders, never profiles, passwords or history.
const CHROMIUM_CACHE = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker\\ScriptCache'];
const CHROMIUM_ROOT_CACHE = ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache'];
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', dir: L('Google', 'Chrome', 'User Data'), proc: 'chrome' },
  { id: 'edge', name: 'Microsoft Edge', dir: L('Microsoft', 'Edge', 'User Data'), proc: 'msedge' },
  { id: 'brave', name: 'Brave', dir: L('BraveSoftware', 'Brave-Browser', 'User Data'), proc: 'brave' },
  { id: 'vivaldi', name: 'Vivaldi', dir: L('Vivaldi', 'User Data'), proc: 'vivaldi' },
  { id: 'opera', name: 'Opera', dir: L('Opera Software', 'Opera Stable'), proc: 'opera', flat: true },
];

async function browserItems() {
  const out = [];
  for (const b of BROWSERS) {
    if (!existsSync(b.dir)) continue;
    let profiles = [b.dir];
    if (!b.flat) {
      const names = await fs.readdir(b.dir).catch(() => []);
      profiles = names.filter((n) => existsSync(path.join(b.dir, n, 'Preferences'))).map((n) => path.join(b.dir, n));
    }
    const paths = [...profiles.flatMap((p) => CHROMIUM_CACHE.map((c) => path.join(p, c))), ...CHROMIUM_ROOT_CACHE.map((c) => path.join(b.dir, c))].filter(existsSync);
    if (paths.length) out.push(dirItem(`browser-${b.id}`, 'Browsers', `${b.name} cache`, 'safe',
      `Cached web pages and images for ${profiles.length} profile${profiles.length === 1 ? '' : 's'}. Logins, history, bookmarks and passwords are kept. Close ${b.name} first.`,
      paths, { procs: [b.proc], contents: false }));
  }
  const ff = L('Mozilla', 'Firefox', 'Profiles');
  if (existsSync(ff)) {
    const profs = (await fs.readdir(ff).catch(() => [])).map((n) => path.join(ff, n));
    const paths = profs.flatMap((p) => [path.join(p, 'cache2'), path.join(p, 'startupCache')]).filter(existsSync);
    if (paths.length) out.push(dirItem('browser-firefox', 'Browsers', 'Firefox cache', 'safe',
      'Cached web pages and images. Logins, history and bookmarks are kept. Close Firefox first.', paths, { procs: ['firefox'], contents: false }));
  }
  return out;
}

// Electron apps in AppData\Roaming (Discord, Slack, VS Code, Teams, Claude, …) keep
// the same Chromium caches. Find them instead of hard-coding a list.
const APP_CACHE = [...CHROMIUM_CACHE, 'CachedData', 'CachedExtensionVSIXs', 'logs'];
const APP_PROC = { Code: 'Code', Cursor: 'Cursor', discord: 'Discord', Slack: 'slack', Claude: 'claude', 'Microsoft\\Teams': 'Teams', Notion: 'Notion', Postman: 'Postman' };

async function appCacheItems() {
  const out = [];
  const tops = (await fs.readdir(ROAMING, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  const candidates = [...tops, 'Microsoft\\Teams'];
  for (const name of candidates) {
    if (['Microsoft', 'Mozilla', 'Opera Software'].includes(name)) continue;
    const paths = APP_CACHE.map((c) => R(name, c)).filter(existsSync);
    if (!paths.length) continue;
    const proc = APP_PROC[name] || name.replace(/\s+/g, '');
    out.push(dirItem(`app-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'App caches', `${name.split('\\').pop()} cache`, 'safe',
      `Chromium/Electron caches. ${name.split('\\').pop()} rebuilds them. Settings and sign-ins are kept. Quit it first.`, paths, { procs: [proc], contents: false, min: 20 * MB }));
  }
  if (existsSync(L('Spotify', 'Data'))) out.push(dirItem('app-spotify', 'App caches', 'Spotify offline cache', 'safe',
    'Songs Spotify cached while streaming. Downloaded playlists may need downloading again. Quit Spotify first.', [L('Spotify', 'Data')], { procs: ['Spotify'] }));
  return out;
}

// Docker: sizes come from `docker system df`, clearing goes through docker itself.
async function hasCmd(c) { return (await run('where.exe', [c], { timeout: 10_000 })).code === 0; }

async function dockerItems() {
  if (!(await hasCmd('docker'))) return [];
  const r = await run('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 30_000 });
  if (r.code) return [{ id: 'docker-off', group: 'Docker', name: 'Docker', risk: 'info', size: 0,
    note: 'Docker is installed but not running. Start Docker Desktop and rescan to see its usage.', disabled: true }];
  const rows = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.Type, j]; }));
  const bytes = (s) => {
    const m = String(s || '0').match(/([\d.]+)\s*([kKMGT]?B)/);
    return m ? +m[1] * ({ B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]] || 1) : 0;
  };
  const mk = (id, name, risk, note, row, args) => ({
    id, group: 'Docker', name, risk, note, size: bytes(row?.Reclaimable),
    async clear() { const x = await run('docker', args); if (x.code) throw new Error(x.stderr || 'docker failed'); return 'Docker frees the space inside its virtual disk. Run "wsl --shutdown" and compact the disk to return it to Windows.'; },
  });
  return [
    mk('docker-build', 'Docker build cache', 'safe', 'Next image build is slower once. Images and containers are untouched.', rows['Build Cache'], ['builder', 'prune', '-a', '-f']),
    mk('docker-images', 'Docker images not used by any container', 'caution', 'They are pulled or rebuilt again when needed.', rows['Images'], ['image', 'prune', '-a', '-f']),
    mk('docker-containers', 'Stopped Docker containers', 'caution', 'Stopped containers and their writable data are removed.', rows['Containers'], ['container', 'prune', '-f']),
    mk('docker-volumes', 'Docker volumes not used by any container', 'danger', 'Can contain database data. Only clear if you are sure.', rows['Local Volumes'], ['volume', 'prune', '-a', '-f']),
  ];
}

// ---------- registry (ids the UI is allowed to act on) ----------

const registry = new Map();

function makeClear(it) {
  return async () => {
    if (it.admin && !IS_ADMIN) throw new Error('Run as administrator to clear this.');
    if (it.procs?.length) {
      const open = await runningOf(it.procs);
      if (open.size) throw new Error(`Quit ${[...open].join(', ')} first.`);
    }
    if (it.clear) return it.clear();
    const notes = [];
    for (const p of it.paths) {
      const n = it.contents ? await clearContents(p, it.filter) : await clearContents(p);
      if (n) notes.push(n);
    }
    return notes.length ? notes[0] : null;
  };
}

async function scanCleanables() {
  const items = [...CATALOG, ...(await browserItems()), ...(await appCacheItems())];
  const allPaths = [...new Set(items.flatMap((it) => it.filter ? [] : it.paths))];
  const [sizes, recycle, docker, running] = await Promise.all([
    sizesOf(allPaths),
    helper('recycle').catch(() => ({ size: 0, items: 0 })),
    dockerItems().catch(() => []),
    runningOf([...new Set(items.flatMap((it) => it.procs || []))]).catch(() => new Set()),
  ]);
  // Thumbnail cache: sum only the matching files.
  const thumbs = items.find((i) => i.id === 'thumbs');
  let thumbSize = 0;
  for (const n of await fs.readdir(thumbs.paths[0]).catch(() => [])) {
    if (thumbs.filter(n)) thumbSize += (await fs.stat(path.join(thumbs.paths[0], n)).catch(() => ({ size: 0 }))).size;
  }

  const out = [];
  for (const it of items) {
    const size = it.id === 'thumbs' ? thumbSize : it.paths.reduce((a, p) => a + (sizes.get(p) || 0), 0);
    const locked = it.admin && !IS_ADMIN;
    if (!locked && size < (it.min || 1)) continue;
    if (locked && !it.paths.some(existsSync)) continue;
    const runningNow = (it.procs || []).filter((p) => running.has(p.toLowerCase()));
    registry.set(it.id, { ...it, run: makeClear(it) });
    out.push({ id: it.id, group: it.group, name: it.name, risk: it.risk, note: it.note, size: locked && !size ? null : size,
      admin: !!it.admin, locked, boost: !!it.boost, running: runningNow, paths: it.filter ? [tilde(it.paths[0]) + '\\thumbcache_*.db'] : it.paths.map(tilde) });
  }
  if (recycle.size > 0) {
    registry.set('recycle', { id: 'recycle', run: async () => { await helper('recycle-empty'); return null; } });
    out.push({ id: 'recycle', group: 'Windows', name: 'Recycle Bin', risk: 'caution', size: recycle.size, paths: [],
      note: `Permanently deletes the ${recycle.items} item${recycle.items === 1 ? '' : 's'} in the Recycle Bin on every drive. Cannot be undone.` });
  }
  for (const d of docker) {
    if (d.clear) registry.set(d.id, { ...d, run: () => d.clear() });
    if (d.size > 0 || d.disabled) out.push({ id: d.id, group: d.group, name: d.name, risk: d.risk, note: d.note, size: d.size, disabled: !!d.disabled, paths: [] });
  }
  return out;
}

async function clearIds(ids) {
  const before = (await diskInfo()).free;
  const results = [];
  for (const id of ids) {
    const it = registry.get(id);
    if (!it) { results.push({ id, ok: false, error: 'Unknown item. Rescan and try again.' }); continue; }
    try { const note = await it.run(); registry.delete(id); results.push({ id, ok: true, note }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  exploreCache.clear();
  const disk = await diskInfo();
  return { results, freed: Math.max(0, disk.free - before), disk };
}

// ---------- projects (build output) ----------

const BUILD_DIRS = {
  node_modules: ['safe', 'Run your install command again if you reopen this project.'],
  '.next': ['safe', 'Next.js rebuilds it on the next dev/build.'],
  '.turbo': ['safe', 'Turborepo cache; rebuilt on the next run.'],
  '.nuxt': ['safe', 'Rebuilt on the next dev/build.'],
  '.svelte-kit': ['safe', 'Rebuilt on the next dev/build.'],
  '.angular': ['safe', 'Angular CLI cache; rebuilt on the next build.'],
  '.parcel-cache': ['safe', 'Rebuilt on the next build.'],
  '.open-next': ['safe', 'OpenNext build output; rebuilt on the next build.'],
  '.vercel': ['caution', 'Vercel build output and project link. Run "vercel link" again if needed.'],
  '.dart_tool': ['safe', 'Run "flutter pub get" again.'],
  '.gradle': ['safe', 'Project Gradle cache; rebuilt on the next build.'],
  '.venv': ['caution', 'Python virtualenv; recreate it and reinstall requirements.'],
  venv: ['caution', 'Python virtualenv; recreate it and reinstall requirements.'],
  target: ['caution', 'Rust/Java build output. Check it is not a source folder.'],
  obj: ['caution', '.NET intermediate build output. Check it is not a source folder.'],
  dist: ['caution', 'Build output. Check it is not committed source.'],
  build: ['caution', 'Build output. Check it is not committed source.'],
};

function projectRoots() {
  if (ENV.PROJECT_ROOTS) return ENV.PROJECT_ROOTS.split(',').map((s) => s.trim()).filter(Boolean);
  const list = [FOLDERS.Documents, FOLDERS.Desktop, H('source', 'repos'), H('Projects'), H('code'), H('dev'), H('src'), H('Documents')];
  const out = [];
  for (const p of list.filter((p) => p && existsSync(p))) if (!out.some((o) => samePath(o, p) || inside(p, o))) out.push(p);
  return out;
}

function projectRootOf(dir, roots) {
  let d = dir;
  while (roots.some((r) => inside(d, r))) {
    if (existsSync(path.join(d, '.git')) || existsSync(path.join(d, 'package.json')) && !path.dirname(d).endsWith('node_modules')) {
      // Prefer the outermost git root (monorepo) if there is one.
      let g = d, best = existsSync(path.join(d, '.git')) ? d : null;
      while (roots.some((r) => inside(g, r))) { if (existsSync(path.join(g, '.git'))) best = g; g = path.dirname(g); }
      return best || d;
    }
    d = path.dirname(d);
  }
  return path.dirname(dir);
}

async function lastActivity(root) {
  const g = await run('git', ['-C', root, 'log', '-1', '--format=%cI'], { timeout: 10_000 });
  if (!g.code && g.stdout.trim()) return g.stdout.trim();
  try { return (await fs.stat(root)).mtime.toISOString(); } catch { return null; }
}

async function scanProjects() {
  const roots = projectRoots();
  const found = await helper('find-dirs', { roots, names: Object.keys(BUILD_DIRS), prune: ['.git', 'AppData', '$Recycle.Bin', 'OneDrive - Personal'] });
  const sizes = await sizesOf(found);
  const big = found.filter((p) => (sizes.get(p) || 0) >= 20 * MB);
  const activity = new Map();
  const out = await pool(big, 6, async (p) => {
    const proj = projectRootOf(p, roots);
    if (!activity.has(proj)) activity.set(proj, lastActivity(proj));
    const kind = Object.keys(BUILD_DIRS).find((k) => k.toLowerCase() === path.basename(p).toLowerCase());
    const [risk, note] = BUILD_DIRS[kind];
    const id = 'proj:' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
    registry.set(id, { id, run: async () => { await rmForce(p); return null; } });
    const onedrive = FOLDERS.OneDrive && inside(p, FOLDERS.OneDrive);
    return { id, kind, risk, note: onedrive ? `${note} This folder is inside OneDrive, which also syncs it.` : note,
      size: sizes.get(p), path: tilde(p), project: tilde(proj), projectName: path.basename(proj), last: await activity.get(proj), onedrive };
  });
  return { roots: roots.map(tilde), items: out.sort((a, b) => b.size - a.size) };
}

// ---------- large files & explorer ----------

async function scanLargeFiles(minMB = 500) {
  const files = await helper('large', { roots: [HOME], min: minMB * MB, skip: ['node_modules', '.git', '$Recycle.Bin'] });
  return files.map((f) => ({ ...f, path: tilde(f.path), trashable: canTrash(f.path), appdata: inside(f.path, H('AppData')) }))
    .sort((a, b) => b.size - a.size);
}

const exploreCache = new Map();

async function explore(dir, fresh) {
  const key = dir.toLowerCase();
  if (!fresh && exploreCache.has(key)) return exploreCache.get(key);
  const children = await helper('explore', { path: dir });
  const parent = path.dirname(dir);
  const res = {
    path: dir, display: tilde(dir), parent: samePath(parent, dir) ? null : parent,
    children: children.sort((a, b) => b.size - a.size).map((c) => ({ ...c, trashable: canTrash(c.path) })),
  };
  exploreCache.set(key, res);
  return res;
}

// Moving to the Recycle Bin is allowed for anything in the home folder except
// the folder itself, its standard folders, AppData (app data, WSL and Docker
// disks live there) and credentials.
const PROTECTED_REL = ['', 'AppData', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive', 'Favorites',
  'Contacts', 'Links', 'Saved Games', 'Searches', '3D Objects', '.ssh', '.gnupg', '.config', '.aws', '.azure', '.kube', '.docker'];
function canTrash(p) {
  const abs = path.resolve(p);
  if (!inside(abs, HOME)) return false;
  if (inside(abs, H('AppData'))) return false;
  const rel = path.relative(HOME, abs).toLowerCase();
  if (PROTECTED_REL.some((r) => r.toLowerCase() === rel)) return false;
  if (Object.values(FOLDERS).some((f) => f && samePath(f, abs))) return false;
  return true;
}

// ---------- memory ----------

const CRITICAL = new Set(['system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm',
  'fontdrvhost', 'memory compression', 'secure system', 'msmpeng', 'mpdefendercoreservice', 'nissrv', 'securityhealthservice',
  'securityhealthsystray', 'sgrmbroker', 'audiodg', 'sihost', 'ctfmon', 'explorer', 'startmenuexperiencehost', 'shellexperiencehost',
  'searchhost', 'textinputhost', 'taskhostw', 'conhost', 'dllhost', 'wudfhost', 'lsm', 'smartscreen', 'applicationframehost',
  'runtimebroker', 'spoolsv', 'wlanext', 'idle', 'interrupts', 'vmmem', 'vmmemwsl', 'vmcompute', 'csrss', 'userinit', 'logonui']);

const memRegistry = new Map(); // group id -> pids

async function memory() {
  const [mem, procs] = await Promise.all([helper('mem'), helper('procs')]);
  const self = new Set([process.pid, process.ppid]);
  const groups = new Map();
  for (const p of procs) {
    const key = p.name.toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, name: p.name, title: null, company: null, path: null, count: 0, ws: 0, priv: 0, cpu: 0, pids: [], services: 0 }));
    g.count++; g.ws += p.ws; g.priv += p.priv; g.cpu += p.cpu; g.pids.push(p.pid);
    if (p.session === 0) g.services++;
    if (!g.title && p.desc) g.title = p.desc;
    if (!g.company && p.company) g.company = p.company;
    if (!g.path && p.path) g.path = p.path;
    if (self.has(p.pid)) g.self = true;
  }
  memRegistry.clear();
  const list = [...groups.values()].sort((a, b) => b.ws - a.ws).map((g) => {
    const id = 'g:' + g.key;
    const critical = CRITICAL.has(g.key);
    const service = g.services === g.count;
    const canEnd = !critical && !service && !g.self;
    if (canEnd) memRegistry.set(id, g.pids);
    return { id, name: g.name, title: g.title, company: g.company, path: g.path, count: g.count, ws: g.ws, priv: g.priv,
      cpu: Math.round(g.cpu * 10) / 10, critical, service, self: !!g.self, canEnd };
  });
  return { mem, groups: list.slice(0, 60), totalProcs: procs.length, isAdmin: IS_ADMIN };
}

async function optimizeMemory(deep) {
  const before = (await helper('mem')).available;
  const trim = await helper('trim');
  let purge = null;
  if (deep && IS_ADMIN) purge = await helper('purge').catch((e) => ({ error: e.message }));
  const mem = await helper('mem');
  return { freed: Math.max(0, mem.available - before), trimmed: trim.trimmed, purged: !!purge?.ok, purgeError: purge?.error || null, mem };
}

async function endGroup(id) {
  const pids = memRegistry.get(id);
  if (!pids) throw new Error('This app cannot be ended from here. Refresh and try again.');
  const before = (await helper('mem')).available;
  let ended = 0, failed = 0;
  for (const pid of pids) { try { process.kill(pid); ended++; } catch { failed++; } }
  memRegistry.delete(id);
  await new Promise((r) => setTimeout(r, 900));
  const mem = await helper('mem');
  return { ended, failed, freed: Math.max(0, mem.available - before), mem };
}

// ---------- startup apps ----------

async function startupApps() {
  const [items, procs] = await Promise.all([helper('startup'), helper('procs')]);
  const byPath = new Map();
  for (const p of procs) if (p.path) { const k = p.path.toLowerCase(); byPath.set(k, (byPath.get(k) || 0) + p.ws); }
  return items.map((it) => {
    const ws = it.exe ? byPath.get(it.exe.toLowerCase()) || 0 : 0;
    const impact = ws >= 150 * MB ? 'high' : ws >= 50 * MB ? 'medium' : ws > 0 ? 'low' : null;
    const needsAdmin = it.scope === 'machine' && !IS_ADMIN;
    return { ...it, title: it.desc || it.name, ws, impact, needsAdmin, missing: it.exe ? !it.exists : false };
  }).sort((a, b) => (b.enabled - a.enabled) || (b.ws - a.ws) || a.title.localeCompare(b.title));
}

// ---------- performance settings ----------

const TWEAKS = {
  power: { name: 'Best performance power mode', risk: 'safe', recommended: true,
    note: 'Windows favours speed over battery life (Settings › System › Power › Power mode). Uses more battery on a laptop.' },
  animations: { name: 'Turn off animations', risk: 'safe', recommended: true,
    note: 'Windows and menus open instantly instead of fading and sliding (Settings › Accessibility › Visual effects).' },
  transparency: { name: 'Turn off transparency effects', risk: 'safe', recommended: true,
    note: 'Removes the blur behind the taskbar, Start and Settings. Saves GPU and memory on older laptops.' },
  bgapps: { name: 'Stop Store apps running in the background', risk: 'caution', recommended: false,
    note: 'Store apps stop running when you are not using them. Their notifications may arrive late.' },
  tips: { name: 'Turn off Windows tips & suggestions', risk: 'safe', recommended: true,
    note: 'No more suggested apps, tips and “finish setting up” prompts in Start, Settings and notifications.' },
  storagesense: { name: 'Storage Sense', risk: 'safe', recommended: true,
    note: 'Windows deletes temporary files and old Recycle Bin items automatically when space runs low.' },
  hibernate: { name: 'Turn off hibernation', risk: 'caution', recommended: false, admin: true,
    note: 'Deletes hiberfil.sys from the system drive. Also turns off Fast Startup and the Hibernate option.' },
};

async function tweaks() {
  const rows = await helper('tweaks');
  return rows.filter((r) => TWEAKS[r.id]).map((r) => {
    const t = TWEAKS[r.id];
    let note = t.note;
    if (r.id === 'hibernate' && r.size) note = `Frees ${fmt(r.size)}. ${note}`;
    return { ...r, ...t, note, locked: !!t.admin && !IS_ADMIN };
  }).sort((a, b) => Object.keys(TWEAKS).indexOf(a.id) - Object.keys(TWEAKS).indexOf(b.id));
}

const SETTINGS_URIS = new Set(['ms-settings:storagesense', 'ms-settings:startupapps', 'ms-settings:powersleep', 'ms-settings:windowsupdate',
  'ms-settings:appsfeatures', 'ms-settings:easeofaccess-visualeffects', 'ms-settings:privacy-backgroundapps', 'ms-settings:about']);

const ACTIONS = {
  async 'restart-explorer'() {
    await run('taskkill.exe', ['/f', '/im', 'explorer.exe'], { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const t = await run('tasklist.exe', ['/fi', 'imagename eq explorer.exe', '/nh'], { timeout: 15_000 });
    if (!/explorer\.exe/i.test(t.stdout)) spawn(W('explorer.exe'), [], { detached: true, stdio: 'ignore' }).unref();
    return 'Windows Explorer restarted.';
  },
  async 'optimize-drive'() {
    if (!IS_ADMIN) throw new Error('Run as administrator to optimize drives.');
    const r = await run(W('System32', 'defrag.exe'), [SYSDRIVE, '/O', '/U'], { timeout: 60 * 60_000 });
    if (r.code) throw new Error((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ') || 'defrag failed');
    return SYSTEM_MEDIA === 'HDD' ? `Drive ${SYSDRIVE} defragmented.` : `Drive ${SYSDRIVE} optimized (TRIM sent to the SSD).`;
  },
};

// ---------- overview & health ----------

let cpuPrev = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = cpuPrev[i] || c;
    const t = (k) => c.times[k] - p.times[k];
    const sum = t('user') + t('nice') + t('sys') + t('idle') + t('irq');
    idle += t('idle'); total += sum;
  });
  cpuPrev = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function fmt(b) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

async function overview() {
  const [disk, memInfo, startup, tw] = await Promise.all([diskInfo(), memory(), startupApps().catch(() => []), tweaks().catch(() => [])]);
  const { mem, groups } = memInfo;
  const advice = [];
  const add = (level, title, detail, go, weight) => advice.push({ level, title, detail, go, weight });

  const loadPct = mem.load;
  const hogs = groups.filter((g) => g.canEnd).slice(0, 3);
  const hogText = hogs.map((g) => `${g.title || g.name} (${fmt(g.ws)})`).join(', ');
  if (loadPct >= 85) add('bad', `Memory is ${loadPct}% full`, `Windows is swapping to disk, which makes everything slow. Biggest apps now: ${hogText}.`, 'memory', 25);
  else if (loadPct >= 70) add('warn', `Memory is ${loadPct}% used`, `Close apps you are not using. Biggest now: ${hogText}.`, 'memory', 12);
  else add('good', `Memory is ${loadPct}% used`, 'Plenty of room for your apps.', 'memory', 0);

  if (mem.commit / mem.commitLimit > 0.85) add('bad', 'Virtual memory is almost exhausted', `${fmt(mem.commit)} of ${fmt(mem.commitLimit)} committed. Apps may crash or freeze. Close some apps or restart.`, 'memory', 15);

  if (mem.total <= 8.6 * GB) add(loadPct >= 70 ? 'warn' : 'info', `${Math.round(mem.total / GB)} GB of RAM`,
    'This is tight for Chrome plus developer tools. Upgrading to 16 GB is the single biggest change for smoothness if your laptop allows it.', null, loadPct >= 70 ? 5 : 0);

  const freePct = disk.total ? disk.free / disk.total : 1;
  if (freePct < 0.1) add('bad', `Drive ${disk.drive} is almost full`, `Only ${fmt(disk.free)} free. Windows slows down and updates fail below 10%.`, 'storage', 20);
  else if (freePct < 0.2) add('warn', `Drive ${disk.drive} is getting full`, `${fmt(disk.free)} free. Keep at least 20% free for updates and the page file.`, 'storage', 8);
  else add('good', `Drive ${disk.drive} has ${fmt(disk.free)} free`, 'Enough space for updates and virtual memory.', 'storage', 0);

  if (disk.media === 'HDD') add('bad', 'Windows is on a hard disk', 'A hard disk is the most common reason Windows feels slow. Moving Windows to an SSD makes boot and app launch several times faster.', null, 20);
  else if (disk.media === 'SSD') add('good', `Windows is on an SSD`, 'Fast storage for Windows and your apps.', null, 0);

  const days = os.uptime() / 86400;
  if (days >= 3) add('warn', `Not restarted for ${Math.floor(days)} days`, 'Restarting clears leaked memory, finishes updates and resets drivers. “Shut down” does not count when Fast Startup is on.', null, Math.min(15, Math.floor(days) * 2));

  const enabledStartup = startup.filter((s) => s.enabled);
  const heavyStartup = enabledStartup.filter((s) => s.impact === 'high' || s.impact === 'medium');
  if (enabledStartup.length > 6 || heavyStartup.length) add(heavyStartup.length ? 'warn' : 'info', `${enabledStartup.length} apps start with Windows`,
    heavyStartup.length ? `${heavyStartup.map((s) => s.title).slice(0, 4).join(', ')} use a lot of memory. Turn off the ones you don't need at sign-in.` : 'Turn off the ones you do not need at sign-in.', 'startup', heavyStartup.length * 4);

  const recTweaks = tw.filter((t) => t.recommended && !t.on && t.available && !t.locked);
  if (recTweaks.length) add('info', `${recTweaks.length} recommended setting${recTweaks.length === 1 ? '' : 's'} not applied`, recTweaks.map((t) => t.name).join(' · '), 'performance', recTweaks.length * 2);

  const score = Math.max(5, 100 - advice.reduce((a, b) => a + (b.weight || 0), 0));
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  advice.sort((a, b) => order[a.level] - order[b.level] || b.weight - a.weight);

  return {
    score, advice, disk, mem, isAdmin: IS_ADMIN,
    system: { cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, uptime: os.uptime(), os: os.version(), release: os.release(), host: os.hostname() },
    startup: { enabled: enabledStartup.length, total: startup.length },
    topApps: groups.slice(0, 5),
  };
}

// One-click boost: free RAM, then clear the temp/crash/update files that are
// always safe to remove. Nothing that costs a re-download or a rebuild.
async function boost() {
  const ram = await optimizeMemory(true);
  const list = await scanCleanables();
  const ids = list.filter((i) => i.boost && !i.locked && i.size > 0).map((i) => i.id);
  const disk = await clearIds(ids);
  return { ram, disk, cleared: list.filter((i) => ids.includes(i.id)).map((i) => i.name) };
}

// ---------- elevation ----------

async function elevate() {
  const tray = path.join(HERE, 'tray.ps1');
  const args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${tray}" -Open`;
  const r = await ps(`try { Start-Process -FilePath powershell.exe -ArgumentList '${args.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -ErrorAction Stop; 'ok' } catch { 'cancelled' }`);
  if (!r.stdout.includes('ok')) throw new Error('Administrator permission was not granted.');
  // Hand over to the elevated copy; the tray exits when it sees code 42.
  setTimeout(() => process.exit(42), 600);
  return { ok: true };
}

// ---------- http ----------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

async function log(route, body) {
  const line = `${new Date().toISOString()} ${route} ${JSON.stringify(body)}\n`;
  process.stdout.write(line);
  await fs.appendFile(path.join(DATA_DIR, 'actions.log'), line).catch(() => {});
}

const READ_ONLY_POSTS = new Set(['POST /api/reveal', 'POST /api/open']);

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS rebinding and cross-site requests: only our own host + token.
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Open Storage Cleaner from its tray icon or the link printed in the terminal.', 'text/plain');
      return send(res, 200, await fs.readFile(path.join(HERE, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });

    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/live') {
      const total = os.totalmem(), free = os.freemem();
      return send(res, 200, { cpu: cpuPercent(), mem: { total, available: free, load: Math.round((1 - free / total) * 100) } });
    }
    if (route === 'GET /api/overview') return send(res, 200, await overview());
    if (route === 'GET /api/disk') return send(res, 200, await diskInfo());
    if (route === 'GET /api/memory') return send(res, 200, await memory());
    if (route === 'GET /api/cleanables') return send(res, 200, await scanCleanables());
    if (route === 'GET /api/projects') return send(res, 200, await scanProjects());
    if (route === 'GET /api/large') return send(res, 200, await scanLargeFiles(+url.searchParams.get('min') || 500));
    if (route === 'GET /api/explore') {
      const dir = path.resolve(untilde(url.searchParams.get('path') || HOME));
      return send(res, 200, await explore(dir, url.searchParams.get('fresh') === '1'));
    }
    if (route === 'GET /api/startup') return send(res, 200, await startupApps());
    if (route === 'GET /api/tweaks') return send(res, 200, await tweaks());

    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.method === 'POST' && !READ_ONLY_POSTS.has(route)) await log(route, body);

    if (route === 'POST /api/clear') return send(res, 200, await clearIds(Array.isArray(body.ids) ? body.ids : [body.id]));
    if (route === 'POST /api/memory/optimize') return send(res, 200, await optimizeMemory(!!body.deep));
    if (route === 'POST /api/memory/end') return send(res, 200, await endGroup(String(body.id)));
    if (route === 'POST /api/boost') return send(res, 200, await boost());
    if (route === 'POST /api/startup') {
      await helper('startup-set', { id: String(body.id), enabled: !!body.enabled });
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/tweaks') {
      if (!TWEAKS[body.id]) return send(res, 400, { error: 'Unknown setting.' });
      await helper('tweak-set', { id: body.id, on: !!body.on });
      return send(res, 200, { ok: true, tweaks: await tweaks() });
    }
    if (route === 'POST /api/action') {
      const fn = ACTIONS[body.id];
      if (!fn) return send(res, 400, { error: 'Unknown action.' });
      return send(res, 200, { ok: true, message: await fn() });
    }
    if (route === 'POST /api/elevate') return send(res, 200, await elevate());
    if (route === 'POST /api/trash') {
      const p = path.resolve(untilde(String(body.path || '')));
      if (!canTrash(p) || !existsSync(p)) return send(res, 400, { error: 'This location cannot be moved to the Recycle Bin from here.' });
      const before = (await diskInfo()).free;
      await helper('trash', { path: p });
      exploreCache.clear();
      const disk = await diskInfo();
      return send(res, 200, { ok: true, freed: Math.max(0, disk.free - before), disk });
    }
    if (route === 'POST /api/reveal') {
      const p = path.resolve(untilde(String(body.path || '')));
      if (!existsSync(p)) return send(res, 400, { error: 'Not found' });
      await run('explorer.exe', [`/select,"${p}"`], { verbatim: true });
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/open') {
      const t = String(body.target || '');
      if (SETTINGS_URIS.has(t)) await run('explorer.exe', [t]);
      else if (t === 'taskmgr') spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore' }).unref();
      else if (t === 'logs') await run('explorer.exe', [DATA_DIR]);
      else return send(res, 400, { error: 'Not allowed' });
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// ---------- start ----------

await fs.mkdir(DATA_DIR, { recursive: true });
try {
  await buildHelper();
} catch (e) {
  console.error(e.message);
  process.exit(3);
}
IS_ADMIN = (await helper('admin')).admin;
FOLDERS = await helper('folders').catch(() => ({}));
detectMedia().catch(() => {});

server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`\n  Storage Cleaner for Windows is running${IS_ADMIN ? ' as administrator' : ''}.\n  Open: ${link}\n  Press Ctrl+C to stop.\n`);
  console.log(`READY ${PORT}`);
  if (!ENV.NO_OPEN) run('rundll32.exe', ['url.dll,FileProtocolHandler', link]);
});
