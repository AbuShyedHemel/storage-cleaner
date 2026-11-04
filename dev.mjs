// Developer tools for Storage Cleaner: listening ports, one-click dev servers,
// and git status across your projects. Same rules as server.mjs: actions only
// touch things a scan found (a listening pid, a scanned package.json, a repo),
// never an arbitrary path or command from the page.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RUN_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'storybook', 'watch', 'develop'];
const SKIP_DIRS = ['node_modules', '.Trash', 'Library', '.next', 'dist', 'build', 'vendor', '.venv', 'venv', 'Pods', 'DerivedData', '.turbo', '.cache'];
const LOG_LINES = 400;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*/;
const EDITORS = ['Cursor', 'Visual Studio Code', 'Zed'];
const TERMINALS = ['Ghostty', 'iTerm', 'Warp', 'Terminal'];

const id = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const appExists = (name) => name === 'Terminal' || existsSync(`/Applications/${name}.app`);

export function createDev({ run, tilde, untilde, roots, home }) {
  const procs = new Map();   // dev servers started from here, by id
  let projects = new Map();  // last scan, by id
  let repos = new Map();     // last scan, by id
  const editor = EDITORS.find(appExists) || null;
  const terminal = TERMINALS.find(appExists);

  // Child processes get the tools a login shell would have, and none of our own settings.
  const childEnv = () => {
    const env = { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' };
    for (const k of ['PORT', 'TOKEN', 'NO_OPEN', 'LOG_DIR']) delete env[k];
    env.PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.bun/bin'),
      path.join(home, 'Library/pnpm'), path.join(home, '.volta/bin'), env.PATH].join(':');
    return env;
  };

  // ---------- discovery ----------

  // One walk per root finds both repos and package.json files.
  async function discover() {
    const found = { pkgs: [], repos: [] };
    for (const root of roots.filter(existsSync)) {
      const prune = SKIP_DIRS.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
      const r = await run('find', [root, '-maxdepth', '6', '(', ...prune, ')', '-prune', '-o',
        '-name', '.git', '-print', '-prune', '-o', '-type', 'f', '-name', 'package.json', '-print'], { timeout: 60_000 });
      for (const p of r.stdout.split('\n').filter(Boolean)) {
        if (path.basename(p) === '.git') found.repos.push(path.dirname(p));
        else found.pkgs.push(p);
      }
    }
    return found;
  }

  async function packageManager(dir) {
    for (let d = dir; d.startsWith(home) && d !== home; d = path.dirname(d)) {
      if (existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
      if (existsSync(path.join(d, 'bun.lockb')) || existsSync(path.join(d, 'bun.lock'))) return 'bun';
      if (existsSync(path.join(d, 'yarn.lock'))) return 'yarn';
      if (existsSync(path.join(d, 'package-lock.json'))) return 'npm';
    }
    return 'npm';
  }

  async function scanProjects() {
    const { pkgs, repos: repoDirs } = await discover();
    const next = new Map();
    for (const file of pkgs) {
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
      const scripts = RUN_SCRIPTS.filter((s) => pkg.scripts?.[s]);
      if (!scripts.length) continue;
      const dir = path.dirname(file);
      const repo = repoDirs.filter((r) => dir === r || dir.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
      const sub = repo && dir !== repo ? path.relative(repo, dir) : '';
      const pid = id(dir);
      next.set(pid, {
        id: pid, dir, path: tilde(dir), name: repo ? path.basename(repo) : pkg.name || path.basename(dir), sub,
        scripts: Object.fromEntries(scripts.map((s) => [s, pkg.scripts[s]])), pm: await packageManager(dir),
        mtime: (await fs.stat(file)).mtimeMs,
      });
    }
    projects = next;
    return { editor, terminal, items: [...next.values()].map(({ dir, ...p }) => p).sort((a, b) => a.name.localeCompare(b.name) || a.sub.localeCompare(b.sub)) };
  }

  // ---------- dev servers ----------

  function procView(p) {
    return { id: p.id, project: p.project, script: p.script, pid: p.pid, status: p.status, code: p.code,
      started: p.started, url: p.url, log: p.lines.slice(-200) };
  }

  function startServer(projectId, script) {
    const proj = projects.get(projectId);
    if (!proj) throw new Error('Unknown project. Rescan and try again.');
    if (!proj.scripts[script]) throw new Error(`No "${script}" script in this project.`);
    const key = id(proj.dir + ':' + script);
    const old = procs.get(key);
    if (old?.status === 'running') return procView(old);
    const child = spawn(proj.pm, ['run', script], { cwd: proj.dir, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = { id: key, project: projectId, script, pid: child.pid, status: 'running', code: null, started: Date.now(), url: null, lines: [], child };
    const onData = (buf) => {
      for (const line of String(buf).replace(ANSI, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        p.lines.push(line);
        if (!p.url) { const m = line.match(URL_RE); if (m) p.url = m[0].replace('0.0.0.0', 'localhost').replace(/[),.]+$/, ''); }
      }
      if (p.lines.length > LOG_LINES) p.lines.splice(0, p.lines.length - LOG_LINES);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { p.lines.push(`Could not start: ${e.message}`); p.status = 'exited'; p.code = -1; });
    child.on('exit', (code, sig) => { p.status = 'exited'; p.code = code ?? sig; p.lines.push(`— exited (${code ?? sig}) —`); });
    procs.set(key, p);
    return procView(p);
  }

  // Dev servers spawn their own children (next, vite…), so stop the whole process group.
  function killGroup(pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch {} }, 4000);
  }

  function stopServer(procId) {
    const p = procs.get(procId);
    if (!p) throw new Error('Unknown server.');
    if (p.status === 'running') { p.lines.push('— stopping… —'); killGroup(p.pid); }
    return procView(p);
  }

  function stopAll() { for (const p of procs.values()) if (p.status === 'running') { try { process.kill(-p.pid, 'SIGTERM'); } catch {} } }

  // ---------- ports ----------

  async function listPorts() {
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 15_000 });
    const byPid = new Map();
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      const t = line[0], v = line.slice(1);
      if (t === 'p') { cur = byPid.get(+v) || { pid: +v, command: '', ports: new Set(), local: true }; byPid.set(+v, cur); }
      else if (t === 'c' && cur) cur.command = v;
      else if (t === 'n' && cur) {
        const port = +v.slice(v.lastIndexOf(':') + 1);
        if (port) cur.ports.add(port);
        if (!/^(127\.0\.0\.1|\[::1\]|localhost)/.test(v)) cur.local = false;
      }
    }
    const pids = [...byPid.keys()];
    if (!pids.length) return [];
    const [ps, cwd] = await Promise.all([
      run('ps', ['-o', 'pid=,ppid=,rss=,etime=,command=', '-p', pids.join(',')]),
      run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']),
    ]);
    const cwds = new Map(); let cp = 0;
    for (const line of cwd.stdout.split('\n')) { if (line[0] === 'p') cp = +line.slice(1); else if (line[0] === 'n') cwds.set(cp, line.slice(1)); }
    const info = new Map();
    for (const line of ps.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) info.set(+m[1], { ppid: +m[2], rss: +m[3] * 1024, uptime: m[4], cmdline: m[5] });
    }
    const managed = [...procs.values()].filter((p) => p.status === 'running');
    const projList = [...projects.values()];
    return [...byPid.values()].filter((p) => p.pid !== process.pid).map((p) => {
      const i = info.get(p.pid) || {};
      const dir = cwds.get(p.pid) || '';
      const proj = projList.filter((x) => dir === x.dir || dir.startsWith(x.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
      const isDev = dir.startsWith(home + '/') && dir !== home;
      return {
        pid: p.pid, command: p.command, ports: [...p.ports].sort((a, b) => a - b), local: p.local,
        rss: i.rss || 0, uptime: i.uptime || '', cmdline: (i.cmdline || '').replaceAll(home, '~').slice(0, 300),
        cwd: dir ? tilde(dir) : '', project: proj ? proj.name + (proj.sub ? ' › ' + proj.sub : '') : null,
        group: isDev ? 'dev' : 'other', managed: managed.some((m) => m.pid === p.pid || m.pid === i.ppid),
        self: /Storage Cleaner\.app\/Contents\/Resources\/server\.mjs/.test(i.cmdline || ''),
      };
    }).sort((a, b) => (a.group === b.group ? a.ports[0] - b.ports[0] : a.group === 'dev' ? -1 : 1));
  }

  async function stopPort(pid, force) {
    const live = await listPorts();
    const target = live.find((p) => p.pid === pid);
    if (!target) throw new Error('That process is no longer listening. Refresh and try again.');
    if (target.self) throw new Error('That is Storage Cleaner itself. Use Quit instead.');
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    await new Promise((r) => setTimeout(r, 1200));
    try { process.kill(pid, 0); return { ok: true, stillRunning: true }; } catch { return { ok: true, stillRunning: false }; }
  }

  // ---------- git ----------

  async function repoStatus(dir) {
    const [st, last, stash] = await Promise.all([
      run('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], { timeout: 20_000 }),
      run('git', ['-C', dir, 'log', '-1', '--format=%cI%x09%s'], { timeout: 10_000 }),
      run('git', ['-C', dir, 'stash', 'list'], { timeout: 10_000 }),
    ]);
    if (st.code !== 0) return null;
    let branch = '', upstream = null, ahead = 0, behind = 0, staged = 0, changed = 0, untracked = 0, conflicts = 0;
    for (const line of st.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14);
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const [a, b] = line.slice(12).split(' '); ahead = +a; behind = -b; }
      else if (line[0] === '1' || line[0] === '2') { const xy = line.slice(2, 4); if (xy[0] !== '.') staged++; if (xy[1] !== '.') changed++; }
      else if (line[0] === 'u') conflicts++;
      else if (line[0] === '?') untracked++;
    }
    const [when, subject] = last.stdout.trim().split('\t');
    const rid = id(dir);
    const dirty = staged + changed + untracked + conflicts;
    return { id: rid, dir, path: tilde(dir), name: path.basename(dir), branch, upstream, ahead, behind, staged, changed, untracked, conflicts,
      stashes: stash.stdout.split('\n').filter(Boolean).length, last: when || null, subject: subject || '',
      attention: dirty > 0 || ahead > 0 || behind > 0 || (!upstream && branch !== '(detached)') };
  }

  async function scanRepos() {
    const { repos: dirs } = await discover();
    const out = [];
    const queue = [...dirs];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) { const s = await repoStatus(queue.shift()); if (s) out.push(s); } }));
    repos = new Map(out.map((r) => [r.id, r]));
    return { editor, terminal, items: out.map(({ dir, ...r }) => r).sort((a, b) => b.attention - a.attention || (b.last || '').localeCompare(a.last || '')) };
  }

  async function fetchAll() {
    const queue = [...repos.values()].filter((r) => r.upstream);
    const failed = [];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const r = queue.shift();
        const res = await new Promise((resolve) => {
          const c = spawn('git', ['-C', r.dir, 'fetch', '--all', '--prune', '--quiet'], { env, stdio: 'ignore' });
          const t = setTimeout(() => c.kill('SIGKILL'), 30_000);
          c.on('exit', (code) => { clearTimeout(t); resolve(code); });
          c.on('error', () => { clearTimeout(t); resolve(1); });
        });
        if (res !== 0) failed.push(r.name);
      }
    }));
    return { failed, ...(await scanRepos()) };
  }

  // ---------- open in… ----------

  // Only folders a scan found, or a localhost URL.
  async function open({ kind, target, app }) {
    if (kind === 'url') {
      if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+(\/[^\s]*)?$/.test(target)) throw new Error('Only local URLs can be opened.');
      return run('open', [target]);
    }
    const dir = path.resolve(untilde(String(target || '')));
    const known = [...projects.values(), ...repos.values()].some((x) => x.dir === dir);
    if (!known) throw new Error('Unknown folder. Rescan and try again.');
    if (app === 'editor' && editor) return run('open', ['-a', editor, dir]);
    if (app === 'terminal') return run('open', ['-a', terminal, dir]);
    return run('open', [dir]);
  }

  // ---------- routes ----------

  async function handle(route, url, body) {
    switch (route) {
      case 'GET /api/dev/ports': return listPorts();
      case 'POST /api/dev/ports/stop': return stopPort(Number(body.pid), !!body.force);
      case 'GET /api/dev/projects': return scanProjects();
      case 'GET /api/dev/procs': return [...procs.values()].map(procView);
      case 'POST /api/dev/start': return startServer(String(body.project), String(body.script));
      case 'POST /api/dev/stop': return stopServer(String(body.id));
      case 'POST /api/dev/forget': { const p = procs.get(String(body.id)); if (p?.status !== 'running') procs.delete(String(body.id)); return { ok: true }; }
      case 'GET /api/dev/git': return scanRepos();
      case 'POST /api/dev/git/fetch': return fetchAll();
      case 'POST /api/dev/open': await open(body); return { ok: true };
      default: return undefined;
    }
  }

  return { handle, stopAll };
}
