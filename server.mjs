#!/usr/bin/env node
// Mac Storage Cleaner: a local-only web UI that shows where disk space goes
// and clears known-safe caches and build output on click.
//
//   node server.mjs            (or double-click "Storage Cleaner.command")
//
// Env: PORT (default 7788), TOKEN, LOG_DIR (where actions.log goes), PROJECT_ROOTS (comma list of folders to scan for
// node_modules/.next/etc; default ~/Documents,~/Projects,~/Developer,~/code).

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDev } from './dev.mjs';

const HOME = os.homedir();
const PORT = Number(process.env.PORT || 7788);
const TOKEN = process.env.TOKEN || crypto.randomBytes(16).toString('hex');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || HERE;
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS ||
  ['Documents', 'Projects', 'Developer', 'code', 'dev', 'src'].map((d) => path.join(HOME, d)).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const h = (...p) => path.join(HOME, ...p);

// ---------- helpers ----------

function run(cmd, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// du exits non-zero on unreadable subfolders but still prints a usable total.
async function sizeBytes(p) {
  if (!existsSync(p)) return 0;
  const { stdout } = await run('du', ['-sk', p]);
  const kb = parseInt(stdout.trim().split('\t')[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function rmForce(p) {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch (e) {
    // Go's module cache and similar make files read-only; unlock and retry.
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      await run('chmod', ['-R', 'u+w', p]);
      await fs.rm(p, { recursive: true, force: true });
    } else throw e;
  }
}

async function clearContents(dir) {
  if (!existsSync(dir)) return null;
  const skipped = [];
  for (const name of await fs.readdir(dir)) {
    try { await rmForce(path.join(dir, name)); } catch { skipped.push(name); }
  }
  // macOS protects a few entries (and some are in use); skip those, keep going.
  return skipped.length ? `Skipped ${skipped.length} protected or in-use item(s): ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}` : null;
}

async function moveToTrash(p) {
  const base = path.basename(p);
  let dest = path.join(HOME, '.Trash', base);
  if (existsSync(dest)) dest = path.join(HOME, '.Trash', `${base} ${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    await fs.rename(p, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Other volume: ask Finder, which handles per-volume trash.
    const r = await run('osascript', ['-e', `tell application "Finder" to delete (POSIX file ${JSON.stringify(p)})`]);
    if (r.code) throw new Error(r.stderr || 'Finder could not move it to Trash');
  }
}

async function diskInfo() {
  const target = existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
  const { stdout } = await run('df', ['-k', target]);
  const cols = stdout.trim().split('\n').pop().split(/\s+/);
  const total = +cols[1] * 1024, used = +cols[2] * 1024, free = +cols[3] * 1024;
  return { total, used, free };
}

async function hasCmd(c) { return (await run('/bin/sh', ['-c', `command -v ${c}`])).code === 0; }

// ---------- catalog of clearable things ----------
// Every clear action the server will run is defined here or registered by a
// scan below. The UI only ever sends an id, never a path or a command.

const dirItem = (id, group, name, risk, note, paths, { contents = false } = {}) => ({
  id, group, name, risk, note, paths,
  async measure() { return (await Promise.all(paths.map(sizeBytes))).reduce((a, b) => a + b, 0); },
  async clear() {
    const notes = [];
    for (const p of paths) { const n = contents ? await clearContents(p) : await rmForce(p); if (n) notes.push(n); }
    return notes.join(' ') || null;
  },
});

const vscodeLike = (app) => ['Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache', 'logs']
  .map((d) => h('Library/Application Support', app, d));

const CATALOG = [
  dirItem('lib-caches', 'System & apps', 'App caches (~/Library/Caches)', 'safe',
    'Every app rebuilds its cache as needed. Quit big apps first for the best result.', [h('Library/Caches')], { contents: true }),
  dirItem('lib-logs', 'System & apps', 'App logs (~/Library/Logs)', 'safe',
    'Old diagnostic logs. Nothing depends on them.', [h('Library/Logs')], { contents: true }),
  dirItem('trash', 'System & apps', 'Trash', 'caution',
    'Permanently deletes what is in the Trash. Cannot be undone.', [h('.Trash')], { contents: true }),

  dirItem('bun', 'Package managers', 'Bun package cache', 'safe',
    'Bun re-downloads packages on the next install.', [h('.bun/install/cache')]),
  dirItem('npm', 'Package managers', 'npm cache', 'safe',
    'npm re-downloads packages on the next install.', [h('.npm/_cacache')]),
  dirItem('pnpm', 'Package managers', 'pnpm store', 'safe',
    'pnpm re-downloads packages on the next install. Existing node_modules keep working.', [h('Library/pnpm/store')]),
  dirItem('yarn', 'Package managers', 'Yarn Berry cache', 'safe',
    'Yarn re-downloads packages on the next install.', [h('.yarn/berry/cache')]),
  dirItem('go', 'Package managers', 'Go module cache', 'safe',
    'Go re-downloads modules on the next build.', [h('go/pkg/mod')]),
  dirItem('uv', 'Package managers', 'uv / pip caches (~/.cache)', 'safe',
    'Python tools re-download what they need.', [h('.cache/uv'), h('.cache/pip')]),
  dirItem('gradle', 'Package managers', 'Gradle caches', 'safe',
    'Android/Gradle builds re-download dependencies once.', [h('.gradle/caches')]),
  dirItem('pub', 'Package managers', 'Flutter/Dart pub cache', 'caution',
    'Flutter projects need "flutter pub get" again.', [h('.pub-cache')]),

  dirItem('vscode', 'Editors', 'VS Code caches', 'safe',
    'Quit VS Code first. Extensions and settings are kept.', vscodeLike('Code')),
  dirItem('vscode-ws', 'Editors', 'VS Code workspace storage', 'caution',
    'Quit VS Code first. Per-project state (open tabs, some extension data) resets.', [h('Library/Application Support/Code/User/workspaceStorage')]),
  dirItem('cursor', 'Editors', 'Cursor caches', 'safe',
    'Quit Cursor first. Extensions and settings are kept.', vscodeLike('Cursor')),

  dirItem('xcode-dd', 'Xcode & simulators', 'Xcode DerivedData', 'safe',
    'Xcode rebuilds it on the next build.', [h('Library/Developer/Xcode/DerivedData')]),
  dirItem('xcode-ds', 'Xcode & simulators', 'iOS DeviceSupport files', 'safe',
    'Re-created the next time you plug in a device.', [h('Library/Developer/Xcode/iOS DeviceSupport')]),
  dirItem('sim', 'Xcode & simulators', 'iOS Simulator devices', 'caution',
    'All simulator devices and their app data are removed. Create new ones in Xcode.', [h('Library/Developer/CoreSimulator/Devices')]),
  dirItem('xcode-arch', 'Xcode & simulators', 'Xcode Archives', 'caution',
    'Old app builds you exported. Needed only to re-upload or symbolicate old releases.', [h('Library/Developer/Xcode/Archives')]),
];

// Docker: sizes come from `docker system df`, clearing goes through docker itself.
async function dockerItems() {
  if (!(await hasCmd('docker'))) return [];
  const r = await run('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 30_000 });
  if (r.code) return [{ id: 'docker-off', group: 'Docker', name: 'Docker', risk: 'info', size: 0,
    note: 'Docker is installed but not running. Start Docker Desktop and rescan to see its usage.', disabled: true }];
  const rows = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.Type, j]; }));
  const bytes = (s) => {
    const m = String(s || '0').match(/([\d.]+)\s*([kKMGT]?B)/);
    if (!m) return 0;
    return +m[1] * ({ B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]] || 1);
  };
  const mk = (id, name, risk, note, row, args) => ({
    id, group: 'Docker', name, risk, note, size: bytes(row?.Reclaimable), total: bytes(row?.Size),
    async clear() { const x = await run('docker', args); if (x.code) throw new Error(x.stderr || 'docker failed'); },
  });
  return [
    mk('docker-build', 'Docker build cache', 'safe', 'Next image build is slower once. Images and containers are untouched.',
      rows['Build Cache'], ['builder', 'prune', '-a', '-f']),
    mk('docker-images', 'Docker images not used by any container', 'caution', 'They are pulled or rebuilt again when needed.',
      rows['Images'], ['image', 'prune', '-a', '-f']),
    mk('docker-containers', 'Stopped Docker containers', 'caution', 'Stopped containers and their writable data are removed.',
      rows['Containers'], ['container', 'prune', '-f']),
    mk('docker-volumes', 'Docker volumes not used by any container', 'danger', 'Can contain database data. Only clear if you are sure.',
      rows['Local Volumes'], ['volume', 'prune', '-a', '-f']),
  ];
}

// ---------- registry (ids the UI is allowed to act on) ----------

const registry = new Map(); // id -> item with clear()

async function scanCleanables() {
  const measured = await pool(CATALOG, 6, async (it) => ({ ...it, size: await it.measure() }));
  const docker = await dockerItems();
  const all = [...docker, ...measured].filter((it) => it.size > 0 || it.disabled);
  for (const it of all) if (it.clear) registry.set(it.id, it);
  return all.map(({ id, group, name, risk, note, size, paths, disabled }) =>
    ({ id, group, name, risk, note, size, disabled: !!disabled, paths: (paths || []).map(tilde) }));
}

const BUILD_DIRS = {
  node_modules: ['safe', 'Run your install command again if you reopen this project.'],
  '.next': ['safe', 'Next.js rebuilds it on the next dev/build.'],
  '.turbo': ['safe', 'Turborepo cache; rebuilt on the next run.'],
  '.nuxt': ['safe', 'Rebuilt on the next dev/build.'],
  '.svelte-kit': ['safe', 'Rebuilt on the next dev/build.'],
  '.parcel-cache': ['safe', 'Rebuilt on the next build.'],
  '.dart_tool': ['safe', 'Run "flutter pub get" again.'],
  Pods: ['safe', 'Run "pod install" again.'],
  '.venv': ['caution', 'Python virtualenv; recreate it and reinstall requirements.'],
  venv: ['caution', 'Python virtualenv; recreate it and reinstall requirements.'],
  target: ['caution', 'Rust/Java build output. Check it is not a source folder.'],
  dist: ['caution', 'Build output. Check it is not committed source.'],
  build: ['caution', 'Build output. Check it is not committed source.'],
};

async function projectRootOf(dir) {
  let d = dir;
  while (d.startsWith(HOME) && d !== HOME) {
    if (existsSync(path.join(d, '.git'))) return d;
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
  const roots = PROJECT_ROOTS.filter(existsSync);
  const names = Object.keys(BUILD_DIRS);
  const found = [];
  for (const root of roots) {
    const expr = names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
    const r = await run('find', [root,
      '(', '-name', '.git', '-o', '-name', 'Library', '-o', '-name', '.Trash', ')', '-prune', '-o',
      '-type', 'd', '(', ...expr, ')', '-print', '-prune']);
    found.push(...r.stdout.split('\n').filter(Boolean));
  }
  const rows = await pool([...new Set(found)], 8, async (p) => ({ p, size: await sizeBytes(p) }));
  const big = rows.filter((r) => r.size >= 20 * 1024 * 1024);
  const activity = new Map();
  const out = await pool(big, 6, async ({ p, size }) => {
    const proj = await projectRootOf(p);
    if (!activity.has(proj)) activity.set(proj, lastActivity(proj));
    const kind = path.basename(p);
    const [risk, note] = BUILD_DIRS[kind];
    const id = 'proj:' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
    registry.set(id, { id, async clear() { await rmForce(p); } });
    return { id, kind, risk, note, size, path: tilde(p), project: tilde(proj), projectName: path.basename(proj), last: await activity.get(proj) };
  });
  return { roots: roots.map(tilde), items: out.sort((a, b) => b.size - a.size) };
}

async function scanLargeFiles(minMB = 500) {
  const r = await run('find', [HOME, '(', '-path', h('Library'), '-o', '-path', h('.Trash'), '-o', '-name', 'node_modules', '-o', '-name', '.git', ')',
    '-prune', '-o', '-type', 'f', '-size', `+${minMB}M`, '-print']);
  const files = r.stdout.split('\n').filter(Boolean);
  const out = await pool(files, 8, async (p) => {
    try {
      const st = await fs.stat(p);
      return { path: tilde(p), size: st.size, modified: st.mtime.toISOString(), accessed: st.atime.toISOString() };
    } catch { return null; }
  });
  return out.filter(Boolean).sort((a, b) => b.size - a.size);
}

// ---------- ~/Library intelligence ----------
// Measures the big folders inside ~/Library, recognises what they are, and says
// whether they can be cleared. Anything it does not recognise is info only (no
// clear action): use Explore folders to look inside. Same rule as the rest of
// the server: the UI sends an id, never a path.

const LIB = h('Library');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHROMIUM_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'GraphiteDawnCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'GPUPersistentCache', 'CachedData', 'CachedExtensionVSIXs'];
const BROWSERS = /^(Google|Arc|Firefox|BraveSoftware|Microsoft Edge|Vivaldi|Chromium)$/;
const PROC_ALIAS = { Code: /Visual Studio Code/i, Google: /Google Chrome/i, 'Docker Desktop': /Docker\.app|com\.docker/ };
const OVERLAP = { Code: 'VS Code caches', Cursor: 'Cursor caches' }; // already in the Clean up tab

// Exact folders we know. clear: 'self' deletes the folder, 'contents' empties it.
const LIB_RULES = {
  'Application Support/Claude/vm_bundles': { name: 'Claude sandbox VM image', risk: 'caution', clear: 'self', needsQuit: true,
    proc: /Claude\.app/, note: "Disk image for Claude's sandbox. It downloads again the next time Claude needs it. Quit Claude first." },
  'Application Support/Code/WebStorage': { name: 'VS Code web storage', risk: 'caution', clear: 'contents', needsQuit: true,
    proc: /Visual Studio Code/i, note: 'Extension and webview local storage. Rebuilt, but extension UI state resets. Quit VS Code first.' },
  'Containers/com.docker.docker': { name: 'Docker Desktop data', risk: 'danger', clear: 'data', needsQuit: true,
    proc: /Docker\.app|com\.docker/, note: 'All images, containers and volumes. Volumes can hold databases.' },
};

async function psOut() { return (await run('ps', ['-axo', 'comm='])).stdout; }

async function dockerNote() {
  const base = 'Everything Docker stores locally is deleted and cannot be undone. The Docker rows in Clean up are the safer route.';
  if (!(await hasCmd('docker'))) return base;
  const r = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 15_000 });
  if (r.code) return `${base} Start Docker Desktop and rescan to see which volumes would be lost.`;
  const vols = r.stdout.split('\n').filter(Boolean);
  return vols.length ? `${base} Volumes that would be lost: ${vols.join(', ')}.` : `${base} No volumes right now.`;
}

async function scanLibrary() {
  const ps = await psOut();
  const items = [];
  const mk = ({ rel, area, name, risk, note, size, proc, needsQuit, clear, paths, overlap }) => {
    const running = !!proc && proc.test(ps);
    const id = 'lib:' + crypto.createHash('sha1').update(rel + '|' + name).digest('hex').slice(0, 12);
    const abs = paths || [path.join(LIB, rel)];
    if (clear) registry.set(id, { id, async clear() {
      if (needsQuit && proc && proc.test(await psOut())) throw new Error(`Quit ${name} first.`);
      for (const p of abs) {
        if (clear === 'contents') await clearContents(p);
        else if (clear === 'data') await rmForce(path.join(p, 'Data'));
        else await rmForce(p);
      }
    } });
    items.push({ id, area, name, risk, note, size, running, canClear: !!clear, overlap: overlap || null, paths: abs.map(tilde) });
  };
  const fromRule = async (rel, area, size) => {
    const r = LIB_RULES[rel];
    mk({ rel, area, size, ...r, note: rel.endsWith('com.docker.docker') ? `${r.note} ${await dockerNote()}` : r.note });
  };

  // Top-level overview (also gives us the biggest areas to drill into).
  const top = (await fs.readdir(LIB).catch(() => [])).filter((n) => !n.startsWith('.'));
  const areas = (await pool(top, 8, async (n) => ({ name: n, size: await sizeBytes(path.join(LIB, n)) })))
    .filter((a) => a.size >= 50 * 1024 * 1024).sort((a, b) => b.size - a.size);

  const children = async (area, min) => {
    const names = (await fs.readdir(path.join(LIB, area)).catch(() => [])).filter((n) => !n.startsWith('.'));
    return (await pool(names, 8, async (n) => ({ name: n, rel: `${area}/${n}`, size: await sizeBytes(path.join(LIB, area, n)) })))
      .filter((c) => c.size >= min);
  };
  const MB = 1024 * 1024;

  for (const c of await children('Application Support', 50 * MB)) {
    if (LIB_RULES[c.rel]) { await fromRule(c.rel, 'Application Support', c.size); continue; }
    const proc = PROC_ALIAS[c.name] || new RegExp(`/${reEsc(c.name)}\\.app/`, 'i');
    let rest = c.size;
    for (const key of Object.keys(LIB_RULES).filter((k) => k.startsWith(c.rel + '/'))) {
      const size = await sizeBytes(path.join(LIB, key));
      rest -= size;
      if (size >= 50 * MB) await fromRule(key, 'Application Support', size);
    }
    const cachePaths = CHROMIUM_CACHES.map((d) => path.join(LIB, c.rel, d)).filter(existsSync);
    const cacheSize = (await Promise.all(cachePaths.map(sizeBytes))).reduce((a, b) => a + b, 0);
    if (cacheSize >= 20 * MB) {
      rest -= cacheSize;
      mk({ rel: c.rel + '#cache', area: 'Application Support', name: `${c.name} web caches`, risk: 'safe', size: cacheSize, proc, clear: 'self', paths: cachePaths,
        overlap: OVERLAP[c.name], note: 'Chromium/Electron caches. The app rebuilds them. Quit it first for the best result.' });
    }
    if (rest >= 50 * MB) {
      mk({ rel: c.rel, area: 'Application Support', name: c.name, risk: 'info', size: rest, proc,
        note: BROWSERS.test(c.name) ? 'Browser profile: bookmarks, passwords, extensions and history live here. Clear its cache from the browser settings.'
          : `Settings and data for ${c.name}${cacheSize >= 20 * MB ? ' (without the caches above)' : ''}. Not recognised as clearable. Use Explore folders to look inside.` });
    }
  }

  for (const area of ['Containers', 'Group Containers']) {
    for (const c of await children(area, 50 * MB)) {
      if (LIB_RULES[c.rel]) { await fromRule(c.rel, area, c.size); continue; }
      mk({ rel: c.rel, area, name: c.name, risk: 'info', size: c.size,
        note: 'App sandbox data (documents, databases). Remove it from inside the app, or by uninstalling the app.' });
    }
  }

  for (const c of await children('Caches', 10 * MB)) {
    mk({ rel: c.rel, area: 'Caches', name: c.name, risk: 'safe', size: c.size, clear: 'self', overlap: 'App caches',
      note: 'Rebuilt by the app as needed.' });
  }

  items.sort((a, b) => b.size - a.size);
  return { total: areas.reduce((a, b) => a + b.size, 0), areas, items };
}

// ---------- explorer ----------

const exploreCache = new Map();

async function explore(dir, fresh) {
  if (!fresh && exploreCache.has(dir)) return exploreCache.get(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => { throw new Error(`Cannot read ${tilde(dir)} (${e.code})`); });
  const children = await pool(entries, 8, async (e) => {
    const p = path.join(dir, e.name);
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return { name: e.name, path: p, size: 0, type: 'link' };
      if (st.isDirectory()) return { name: e.name, path: p, size: await sizeBytes(p), type: 'dir' };
      return { name: e.name, path: p, size: st.blocks * 512, type: 'file' };
    } catch { return { name: e.name, path: p, size: 0, type: 'unknown' }; }
  });
  const res = { path: dir, display: tilde(dir), parent: dir === '/' ? null : path.dirname(dir),
    trashable: canTrash(dir) || null,
    children: children.sort((a, b) => b.size - a.size).map((c) => ({ ...c, trashable: canTrash(c.path) })) };
  exploreCache.set(dir, res);
  return res;
}

// Moving to Trash is allowed for anything under the home folder except the
// home folder itself and its standard top-level folders.
const PROTECTED = new Set(['', 'Library', 'Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Applications', 'Public', '.Trash', 'Library/Application Support', 'Library/Containers', 'Library/Group Containers',
  'Library/Preferences', 'Library/Keychains', 'Library/Mobile Documents', '.ssh', '.gnupg', '.config']);
function canTrash(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(HOME + path.sep)) return false;
  return !PROTECTED.has(path.relative(HOME, abs));
}

function tilde(p) { return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p; }
function untilde(p) { return p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p; }

// ---------- developer tools (dev.mjs) ----------

const dev = createDev({ run, tilde, untilde, roots: PROJECT_ROOTS, home: HOME });
// Dev servers started from here die with us (the menu bar app sends SIGTERM on quit).
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { dev.stopAll(); process.exit(0); });

// ---------- http ----------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS-rebinding and cross-site requests: only our own host + token.
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Open the link printed in the terminal.', 'text/plain');
      return send(res, 200, await fs.readFile(path.join(HERE, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });

    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/disk') return send(res, 200, await diskInfo());
    if (route === 'GET /api/cleanables') return send(res, 200, await scanCleanables());
    if (route === 'GET /api/projects') return send(res, 200, await scanProjects());
    if (route === 'GET /api/library') return send(res, 200, await scanLibrary());
    if (route === 'GET /api/large') return send(res, 200, await scanLargeFiles(+url.searchParams.get('min') || 500));
    if (route === 'GET /api/explore') {
      const dir = path.resolve(untilde(url.searchParams.get('path') || HOME));
      return send(res, 200, await explore(dir, url.searchParams.get('fresh') === '1'));
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    // Audit trail: every action that changes files is logged with a timestamp.
    if (req.method === 'POST' && !['POST /api/reveal', 'POST /api/dev/open', 'POST /api/dev/forget'].includes(route)) {
      const line = `${new Date().toISOString()} ${route} ${JSON.stringify(body)}\n`;
      process.stdout.write(line);
      await fs.appendFile(path.join(LOG_DIR, 'actions.log'), line).catch(() => {});
    }
    if (url.pathname.startsWith('/api/dev/')) {
      const out = await dev.handle(route, url, body);
      if (out !== undefined) return send(res, 200, out);
    }
    if (route === 'POST /api/clear') {
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      const before = (await diskInfo()).free;
      const results = [];
      for (const id of ids) {
        const it = registry.get(id);
        if (!it) { results.push({ id, ok: false, error: 'Unknown item. Rescan and try again.' }); continue; }
        try { const note = await it.clear(); registry.delete(id); results.push({ id, ok: true, note }); }
        catch (e) { results.push({ id, ok: false, error: e.message }); }
      }
      exploreCache.clear();
      const disk = await diskInfo();
      return send(res, 200, { results, freed: Math.max(0, disk.free - before), disk });
    }
    if (route === 'POST /api/trash') {
      const p = path.resolve(untilde(String(body.path || '')));
      if (!canTrash(p) || !existsSync(p)) return send(res, 400, { error: 'This location cannot be moved to Trash from here.' });
      const before = (await diskInfo()).free;
      await moveToTrash(p);
      exploreCache.clear();
      const disk = await diskInfo();
      return send(res, 200, { ok: true, freed: Math.max(0, disk.free - before), disk });
    }
    if (route === 'POST /api/reveal') {
      const p = path.resolve(untilde(String(body.path || '')));
      if (!existsSync(p)) return send(res, 400, { error: 'Not found' });
      await run('open', ['-R', p]);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`\n  Mac Storage Cleaner is running.\n  Open: ${link}\n  Press Ctrl+C to stop.\n`);
  if (!process.env.NO_OPEN) run('open', [link]);
});
