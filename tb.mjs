#!/usr/bin/env node
// tb.mjs (baton) — a git-native task board for AI agents and humans.
// https://github.com/JannisJostBot/baton
//
// * Zero dependencies: needs only Node 18+ and git.
// * Board data lives on its own git branch (default: `taskboard`), written with
//   git plumbing. It never touches your working tree, index or code commits,
//   so agents can update tasks while their code is still uncommitted.
// * All worktrees of a repo share the board instantly (refs are shared).
// * `tb sync` merges/pushes the board branch so cloud sessions and other
//   machines see the same state. Merges are per task and never conflict.
// * `tb ui` opens a local Kanban board in your browser.
//
// Run `node tb.mjs help` for commands.

import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const BRANCH = process.env.TB_BRANCH || 'taskboard';
const REF = `refs/heads/${BRANCH}`;
const REMOTE = process.env.TB_REMOTE || 'origin';
const TRACK = `refs/remotes/${REMOTE}/${BRANCH}`;
const STATUSES = ['todo', 'in_progress', 'review', 'blocked', 'done'];
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done' };
const STATUS_ALIAS = {
  'in-progress': 'in_progress', inprogress: 'in_progress', progress: 'in_progress', wip: 'in_progress',
  doing: 'in_progress', started: 'in_progress', open: 'todo', backlog: 'todo', new: 'todo',
  closed: 'done', finished: 'done', complete: 'done', completed: 'done', blocker: 'blocked',
};
const PRIORITIES = ['high', 'normal', 'low'];
const SCRIPT = fileURLToPath(import.meta.url);

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ───────────────────────────── git plumbing ─────────────────────────────

let gitEnv = null;

function git(args, { input, cwd, allowFail = false, buffer = false } = {}) {
  const r = spawnSync('git', args, {
    input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
    cwd, env: gitEnv || process.env, encoding: buffer ? undefined : 'utf8',
    maxBuffer: 1 << 30, windowsHide: true,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') fail('git was not found in PATH');
    throw r.error;
  }
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')}: ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

function setupGit() {
  if (git(['rev-parse', '--git-dir'], { allowFail: true }) === null) fail('not inside a git repository');
  gitEnv = { ...process.env };
  // commit-tree needs an identity; fall back to a neutral one if none is configured.
  const name = (git(['config', 'user.name'], { allowFail: true }) || '').trim();
  const email = (git(['config', 'user.email'], { allowFail: true }) || '').trim();
  if (!process.env.GIT_AUTHOR_NAME && !name) gitEnv.GIT_AUTHOR_NAME = gitEnv.GIT_COMMITTER_NAME = 'taskboard';
  if (!process.env.GIT_AUTHOR_EMAIL && !email) gitEnv.GIT_AUTHOR_EMAIL = gitEnv.GIT_COMMITTER_EMAIL = 'taskboard@localhost';
}

let zeroCache;
function ZERO() {
  if (!zeroCache) {
    const fmt = (git(['rev-parse', '--show-object-format'], { allowFail: true }) || 'sha1').trim();
    zeroCache = '0'.repeat(fmt === 'sha256' ? 64 : 40);
  }
  return zeroCache;
}

const revParse = (ref) => (git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true }) || '').trim() || null;

/** Current board commit. Adopts the remote-tracking branch on fresh clones. */
function headCommit() {
  const c = revParse(REF);
  if (c) return c;
  const rc = revParse(TRACK);
  if (rc) { git(['update-ref', REF, rc, ZERO()], { allowFail: true }); return revParse(REF) || rc; }
  return null;
}

function catBlobs(shas) {
  const out = {};
  if (!shas.length) return out;
  const buf = git(['cat-file', '--batch'], { input: shas.join('\n') + '\n', buffer: true });
  let pos = 0;
  for (let i = 0; i < shas.length; i++) {
    const nl = buf.indexOf(10, pos);
    const [sha, , size] = buf.toString('utf8', pos, nl).split(' ');
    const start = nl + 1, end = start + Number(size);
    out[sha] = buf.toString('utf8', start, end);
    pos = end + 1;
  }
  return out;
}

const hashBlob = (content) => git(['hash-object', '-w', '--stdin'], { input: content }).trim();
const mktree = (lines) => git(['mktree'], { input: lines.length ? lines.join('\n') + '\n' : '' }).trim();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ───────────────────────────── board storage ─────────────────────────────

const ser = (obj) => JSON.stringify(obj, null, 2) + '\n';

function readBoard(commit) {
  const st = { commit, config: { prefix: 'TB', deleted: [] }, tasks: new Map() };
  if (!commit) return st;
  const items = git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab).split(' ')[2], path: line.slice(tab + 1) };
  });
  const blobs = catBlobs(items.map((i) => i.sha));
  for (const it of items) {
    const raw = blobs[it.sha];
    try {
      if (it.path === 'config.json') Object.assign(st.config, JSON.parse(raw));
      else if (it.path.startsWith('tasks/') && it.path.endsWith('.json')) {
        const data = JSON.parse(raw);
        st.tasks.set(data.id, { data, raw, sha: it.sha });
      }
    } catch { process.stderr.write(`tb: warning: could not parse ${it.path}\n`); }
  }
  return st;
}

function writeBoard(st, parents, message) {
  const taskLines = [];
  for (const [id, t] of st.tasks) {
    const s = ser(t.data);
    const sha = s === t.raw && t.sha ? t.sha : hashBlob(s);
    taskLines.push(`100644 blob ${sha}\t${id}.json`);
  }
  const root = mktree([
    `100644 blob ${hashBlob(ser(st.config))}\tconfig.json`,
    `100644 blob ${hashBlob(renderBoardMd(st))}\tBOARD.md`,
    `040000 tree ${mktree(taskLines)}\ttasks`,
  ]);
  const args = ['commit-tree', root];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  return git(args).trim();
}

/** Read-modify-write with compare-and-swap on the ref; safe for parallel agents. */
function mutate(fn) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const old = headCommit();
    const st = readBoard(old);
    const { msg, out } = fn(st);
    const commit = writeBoard(st, old ? [old] : [], msg);
    if (git(['update-ref', '-m', 'tb', REF, commit, old || ZERO()], { allowFail: true }) !== null) {
      if (/^(1|true|yes)$/i.test(process.env.TB_AUTOSYNC || '')) {
        try { sync({ quiet: true }); } catch (e) { process.stderr.write(`tb: autosync failed: ${e.message}\n`); }
      }
      return out;
    }
    sleep(15 + Math.random() * 120);
  }
  fail('could not update the board (too much contention), try again');
}

// ───────────────────────────── task helpers ─────────────────────────────

const now = () => new Date().toISOString();
const rid = (n) => crypto.randomBytes(n).toString('hex');

function normId(st, id) {
  if (id === undefined || id === null || id === '') fail('missing task ID');
  const s = String(id).trim().toUpperCase().replace(/^#/, '');
  return /^\d+$/.test(s) ? `${st.config.prefix}-${s}` : s;
}

function getTask(st, id) {
  const t = st.tasks.get(normId(st, id));
  if (!t) fail(`no task ${id}`);
  return t.data;
}

function nextNum(st) {
  let max = 0;
  const re = new RegExp(`^${st.config.prefix}-(\\d+)$`);
  for (const id of st.tasks.keys()) { const m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

function newKey(list) {
  const used = new Set((list || []).map((x) => x.k));
  let k; do k = rid(2); while (used.has(k));
  return k;
}

function addLog(task, by, type, msg, extra = {}) {
  task.log = task.log || [];
  const entry = { k: newKey(task.log), t: now(), by, type, msg, ...extra };
  task.log.push(entry);
  task.updated = entry.t;
  return entry;
}

function normStatus(s) {
  const v = String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
  const r = STATUS_ALIAS[v] || v;
  if (!STATUSES.includes(r)) fail(`unknown status "${s}" (use: ${STATUSES.join(', ')})`);
  return r;
}

function normPriority(p) {
  if (p === undefined || p === null || p === '') return 'normal';
  const v = String(p).toLowerCase();
  const map = { h: 'high', hi: 'high', '1': 'high', n: 'normal', med: 'normal', medium: 'normal', '2': 'normal', l: 'low', lo: 'low', '3': 'low' };
  const r = map[v] || v;
  if (!PRIORITIES.includes(r)) fail(`unknown priority "${p}" (use: high, normal, low)`);
  return r;
}

const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;\n]/)).map((s) => String(s).trim()).filter(Boolean);
const splitLabels = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const openIssues = (t) => (t.log || []).filter((e) => e.type === 'issue' && !e.resolved);
const stepCount = (t) => ({ done: (t.steps || []).filter((s) => s.done).length, total: (t.steps || []).length });

function currentBranch() {
  const b = (git(['branch', '--show-current'], { allowFail: true }) || '').trim();
  if (b) return b;
  const h = (git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) || '').trim();
  return h ? `detached@${h}` : null;
}
const topLevel = () => (git(['rev-parse', '--show-toplevel'], { allowFail: true }) || '').trim() || process.cwd();
const defaultAgent = () => process.env.TB_AGENT || currentBranch() || 'agent';

// ───────────────────────────── operations (shared by CLI + UI) ─────────────────────────────

const ops = {
  add(o, by) {
    const title = String(o.title || '').trim();
    if (!title) fail('a task needs a title');
    return mutate((st) => {
      const id = `${st.config.prefix}-${nextNum(st)}`;
      const t = {
        id, uid: rid(6), title, status: o.status ? normStatus(o.status) : 'todo',
        priority: normPriority(o.priority), labels: splitLabels(o.labels),
        parent: o.parent ? normId(st, o.parent) : null,
        description: String(o.description || '').trim(),
        assignee: null, branch: null, worktree: null, summary: null,
        created: now(), updated: now(), steps: [], log: [],
      };
      for (const text of splitList(o.steps)) t.steps.push({ k: newKey(t.steps), text, done: false });
      addLog(t, by, 'created', 'created');
      st.tasks.set(id, { data: t });
      return { msg: `add ${id}: ${title}`, out: id };
    });
  },

  start(id, by, o = {}) {
    return mutate((st) => {
      const t = getTask(st, id);
      const prev = t.status;
      const warn = prev === 'in_progress' && t.assignee && t.assignee !== by ? `note: ${t.id} was in progress by ${t.assignee}` : null;
      t.status = 'in_progress';
      t.assignee = by;
      t.branch = o.branch !== undefined ? o.branch : currentBranch();
      t.worktree = o.worktree !== undefined ? o.worktree : topLevel();
      addLog(t, by, 'status', `started (${prev} → in_progress)${t.branch ? ` on ${t.branch}` : ''}`);
      return { msg: `start ${t.id}`, out: { id: t.id, warn } };
    });
  },

  move(id, status, by, note) {
    const s = normStatus(status);
    return mutate((st) => {
      const t = getTask(st, id);
      const prev = t.status;
      t.status = s;
      addLog(t, by, 'status', `${prev} → ${s}${note ? `: ${note}` : ''}`);
      return { msg: `move ${t.id} ${s}`, out: t.id };
    });
  },

  done(id, summary, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      t.status = 'done';
      if (summary) t.summary = summary;
      addLog(t, by, 'done', summary || 'done');
      return { msg: `done ${t.id}`, out: t.id };
    });
  },

  log(id, type, msg, by) {
    if (!String(msg || '').trim()) fail('empty message');
    const ty = ['progress', 'note', 'issue'].includes(type) ? type : 'progress';
    return mutate((st) => {
      const t = getTask(st, id);
      const e = addLog(t, by, ty, String(msg).trim());
      return { msg: `${ty} ${t.id}`, out: { id: t.id, k: e.k } };
    });
  },

  resolve(id, k, msg, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      const key = String(k || '').replace(/^#/, '');
      const e = (t.log || []).find((x) => x.k === key && x.type === 'issue');
      if (!e) fail(`no issue #${key} on ${t.id}`);
      e.resolved = { t: now(), by, msg: msg || null };
      t.updated = e.resolved.t;
      return { msg: `resolve ${t.id}#${key}`, out: t.id };
    });
  },

  addSteps(id, texts, by) {
    const list = splitList(texts);
    if (!list.length) fail('no steps given');
    return mutate((st) => {
      const t = getTask(st, id);
      t.steps = t.steps || [];
      const keys = list.map((text) => { const k = newKey(t.steps); t.steps.push({ k, text, done: false }); return k; });
      t.updated = now();
      return { msg: `steps ${t.id}`, out: { id: t.id, keys } };
    });
  },

  tick(id, keys, done, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      const ks = keys.map((k) => String(k).replace(/^#/, ''));
      for (const k of ks) {
        // accept a key or a 1-based step number
        const s = (t.steps || []).find((x) => x.k === k) || (/^\d+$/.test(k) && k.length < 4 ? t.steps[Number(k) - 1] : null);
        if (!s) fail(`no step ${k} on ${t.id}`);
        s.done = done;
      }
      t.updated = now();
      return { msg: `tick ${t.id}`, out: stepCount(t) };
    });
  },

  removeStep(id, k, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      const before = (t.steps || []).length;
      t.steps = (t.steps || []).filter((s) => s.k !== k);
      if (t.steps.length === before) fail(`no step ${k}`);
      t.updated = now();
      return { msg: `unstep ${t.id}`, out: t.id };
    });
  },

  edit(id, f, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      const changed = [];
      if (f.title !== undefined && String(f.title).trim() && f.title !== t.title) { t.title = String(f.title).trim(); changed.push('title'); }
      if (f.description !== undefined && f.description !== t.description) { t.description = String(f.description); changed.push('description'); }
      if (f.priority !== undefined) { const p = normPriority(f.priority); if (p !== t.priority) { t.priority = p; changed.push('priority'); } }
      if (f.labels !== undefined) { t.labels = splitLabels(f.labels); changed.push('labels'); }
      if (f.parent !== undefined) { t.parent = f.parent ? normId(st, f.parent) : null; changed.push('parent'); }
      if (f.assignee !== undefined) { t.assignee = f.assignee || null; changed.push('assignee'); }
      if (f.status !== undefined) {
        const s = normStatus(f.status);
        if (s !== t.status) { addLog(t, by, 'status', `${t.status} → ${s}`); t.status = s; }
      }
      t.updated = now();
      return { msg: `edit ${t.id}${changed.length ? ` (${changed.join(', ')})` : ''}`, out: t.id };
    });
  },

  rm(id, by) {
    return mutate((st) => {
      const t = getTask(st, id);
      st.tasks.delete(t.id);
      st.config.deleted = [...new Set([...(st.config.deleted || []), t.uid])];
      return { msg: `rm ${t.id}: ${t.title}`, out: t.id };
    });
  },
};

// ───────────────────────────── sync / merge ─────────────────────────────

function unionBy(primary = [], secondary = [], combine) {
  const map = new Map();
  for (const x of primary) map.set(x.k, x);
  for (const y of secondary) map.set(y.k, map.has(y.k) ? combine(map.get(y.k), y) : y);
  return [...map.values()];
}

function mergeTask(a, b) {
  const newer = (a.updated || '') >= (b.updated || '') ? a : b;
  const older = newer === a ? b : a;
  const m = { ...older, ...newer };
  m.log = unionBy(newer.log, older.log, (x, y) => ({ ...x, resolved: x.resolved || y.resolved }))
    .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  m.steps = unionBy(newer.steps, older.steps, (x, y) => ({ ...x, done: x.done || y.done }));
  return m;
}

function mergeBoards(L, R) {
  const deleted = new Set([...(L.config.deleted || []), ...(R.config.deleted || [])]);
  const config = { ...L.config, ...R.config, deleted: [...deleted] };
  const out = { commit: null, config, tasks: new Map() };
  const byUid = new Map();
  for (const [id, t] of R.tasks) {
    if (deleted.has(t.data.uid)) continue;
    out.tasks.set(id, t);
    byUid.set(t.data.uid, id);
  }
  const renamed = [];
  const pending = [];
  for (const [, t] of L.tasks) {
    if (deleted.has(t.data.uid)) continue;
    const rid2 = byUid.get(t.data.uid);
    if (rid2) out.tasks.set(rid2, { ...out.tasks.get(rid2), data: mergeTask(t.data, out.tasks.get(rid2).data) });
    else pending.push(t);
  }
  for (const t of pending) {
    let id = t.data.id;
    if (out.tasks.has(id)) {
      // Two disconnected clones created the same ID: renumber the local one.
      const newId = `${config.prefix}-${nextNum(out)}`;
      renamed.push([id, newId]);
      const data = { ...t.data, id: newId };
      addLog(data, 'tb', 'note', `renumbered from ${id} during sync (ID collision)`);
      out.tasks.set(newId, { data });
    } else out.tasks.set(id, t);
  }
  return { st: out, renamed };
}

function hasRemote() {
  return (git(['remote'], { allowFail: true }) || '').split(/\r?\n/).includes(REMOTE);
}

function sync({ quiet = false } = {}) {
  if (!hasRemote()) fail(`no git remote "${REMOTE}" (set TB_REMOTE to use another)`);
  const say = (m) => { if (!quiet) console.log(m); };
  for (let attempt = 0; attempt < 5; attempt++) {
    const ls = git(['ls-remote', '--heads', REMOTE, BRANCH], { allowFail: true });
    if (ls === null) fail(`could not reach remote "${REMOTE}"`);
    let remote = null;
    if (ls.trim()) {
      if (git(['fetch', '-q', REMOTE, `+${REF}:${TRACK}`], { allowFail: true }) === null) fail('fetch failed');
      remote = revParse(TRACK);
    }
    const local = revParse(REF);
    if (!remote && !local) { say('nothing to sync (empty board)'); return 'empty'; }
    if (local === remote) { say('board is up to date'); return 'uptodate'; }
    if (!local) { git(['update-ref', REF, remote, ZERO()]); say('pulled board from remote'); return 'pulled'; }
    if (remote && git(['merge-base', '--is-ancestor', local, remote], { allowFail: true }) !== null) {
      if (git(['update-ref', REF, remote, local], { allowFail: true }) === null) continue;
      say('pulled remote changes'); return 'pulled';
    }
    let toPush = local;
    let renamed = [];
    if (remote && git(['merge-base', '--is-ancestor', remote, local], { allowFail: true }) === null) {
      const merged = mergeBoards(readBoard(local), readBoard(remote));
      renamed = merged.renamed;
      const c = writeBoard(merged.st, [local, remote], 'sync: merge remote board');
      if (git(['update-ref', REF, c, local], { allowFail: true }) === null) continue;
      toPush = c;
    }
    if (git(['push', '-q', REMOTE, `${toPush}:${REF}`], { allowFail: true }) === null) {
      if (attempt < 4) { sleep(200 + Math.random() * 500); continue; }
      fail('push failed (no permission for this branch? try TB_BRANCH=<allowed-branch>)');
    }
    git(['update-ref', TRACK, toPush], { allowFail: true });
    for (const [a, b] of renamed) say(`renumbered ${a} → ${b} (ID collision)`);
    say(remote ? 'merged and pushed board' : 'pushed board');
    return 'pushed';
  }
  fail('sync kept racing with another writer, try again');
}

// ───────────────────────────── text output ─────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const priRank = { high: 0, normal: 1, low: 2 };
const idNum = (id) => Number(String(id).split('-').pop()) || 0;

function sortTasks(list, status) {
  if (status === 'todo') return list.sort((a, b) => priRank[a.priority] - priRank[b.priority] || idNum(a.id) - idNum(b.id));
  return list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function renderBoardMd(st) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  let md = '# Task board\n\n_Generated by tb.mjs — change it with `node tb.mjs` or `node tb.mjs ui`, not by hand._\n';
  const all = [...st.tasks.values()].map((t) => t.data);
  for (const s of STATUSES) {
    const list = sortTasks(all.filter((t) => t.status === s), s);
    if (!list.length) continue;
    md += `\n## ${STATUS_LABEL[s]} (${list.length})\n\n| ID | Title | Who | Steps | Issues | Updated |\n|---|---|---|---|---|---|\n`;
    for (const t of list) {
      const sc = stepCount(t);
      md += `| ${t.id} | ${cell(t.title)}${t.priority === 'high' ? ' **(high)**' : ''} | ${cell(t.assignee)} | ${sc.total ? `${sc.done}/${sc.total}` : ''} | ${openIssues(t).length || ''} | ${(t.updated || '').slice(0, 10)} |\n`;
    }
  }
  return md;
}

function printShow(t) {
  const sc = stepCount(t);
  const L = [];
  L.push(`${t.id}  ${t.title}`);
  L.push(`status: ${t.status} · priority: ${t.priority}${t.labels?.length ? ` · labels: ${t.labels.join(', ')}` : ''}${t.parent ? ` · parent: ${t.parent}` : ''}`);
  if (t.assignee || t.branch) L.push(`assignee: ${t.assignee || '-'} · branch: ${t.branch || '-'}${t.worktree ? ` · worktree: ${t.worktree}` : ''}`);
  L.push(`created ${fmtTime(t.created)} · updated ${fmtTime(t.updated)} (${ago(t.updated)})`);
  if (t.summary) L.push(`summary: ${t.summary}`);
  if (t.description) { L.push('', 'Description:'); for (const l of t.description.split('\n')) L.push(`  ${l}`); }
  if (sc.total) {
    L.push('', `Steps (${sc.done}/${sc.total}):`);
    for (const s of t.steps) L.push(`  [${s.done ? 'x' : ' '}] ${s.k}  ${s.text}`);
  }
  const oi = openIssues(t);
  if (oi.length) {
    L.push('', 'Open issues:');
    for (const e of oi) L.push(`  ! #${e.k}  ${e.msg}  (${e.by}, ${fmtTime(e.t)})`);
  }
  const log = (t.log || []).filter((e) => e.type !== 'created');
  if (log.length) {
    L.push('', 'Log:');
    for (const e of log) {
      const res = e.type === 'issue' && e.resolved ? `  [resolved by ${e.resolved.by}${e.resolved.msg ? `: ${e.resolved.msg}` : ''}]` : '';
      L.push(`  ${fmtTime(e.t)}  ${e.type.padEnd(8)} ${e.by}: ${e.msg}${e.type === 'issue' ? ` (#${e.k})` : ''}${res}`);
    }
  }
  console.log(L.join('\n'));
}

function printList(st, flags) {
  const all = [...st.tasks.values()].map((t) => t.data);
  const wanted = flags.status ? [normStatus(flags.status)] : STATUSES;
  let any = false;
  for (const s of wanted) {
    let list = sortTasks(all.filter((t) => t.status === s), s);
    if (!list.length) continue;
    const hidden = s === 'done' && !flags.all && !flags.status ? Math.max(0, list.length - 5) : 0;
    if (hidden) list = list.slice(0, 5);
    any = true;
    console.log(`${STATUS_LABEL[s]} (${list.length + hidden})`);
    for (const t of list) {
      const sc = stepCount(t);
      const bits = [t.priority !== 'normal' ? t.priority : '', t.assignee ? `@${t.assignee}` : '', sc.total ? `${sc.done}/${sc.total}` : '', openIssues(t).length ? `${openIssues(t).length} issue(s)` : ''].filter(Boolean);
      console.log(`  ${t.id.padEnd(7)} ${t.title}${bits.length ? `  [${bits.join(' · ')}]` : ''}`);
    }
    if (hidden) console.log(`  … ${hidden} older (use --all)`);
  }
  if (!any) console.log('No tasks yet. Add one: ' + cmdName() + ' add "Title"');
}

function printContext(st) {
  const all = [...st.tasks.values()].map((t) => t.data);
  const by = (s) => sortTasks(all.filter((t) => t.status === s), s);
  const counts = STATUSES.map((s) => `${by(s).length} ${s}`).join(', ');
  const C = cmdName();
  const L = [`TASK BOARD ${st.config.prefix} (git branch '${BRANCH}', not in working tree) — ${all.length} tasks: ${counts}`];
  const detail = (t) => {
    const sc = stepCount(t);
    L.push(`  ${t.id} ${t.priority === 'high' ? '[high] ' : ''}${t.title}`);
    const meta = [t.assignee && `by ${t.assignee}`, t.branch && t.branch !== t.assignee && `branch ${t.branch}`, sc.total && `steps ${sc.done}/${sc.total}`, `updated ${ago(t.updated)}`].filter(Boolean);
    L.push(`     ${meta.join(' · ')}`);
    for (const e of openIssues(t)) L.push(`     ! issue #${e.k}: ${trunc(e.msg, 160)}`);
    const next = (t.steps || []).filter((s) => !s.done).slice(0, 3);
    if (next.length) L.push(`     next: ${next.map((s) => `${s.text} (${s.k})`).join('; ')}`);
    const last = [...(t.log || [])].reverse().find((e) => e.type === 'progress' || e.type === 'note');
    if (last) L.push(`     last: ${trunc(last.msg, 200)}`);
  };
  for (const s of ['in_progress', 'review', 'blocked']) {
    const list = by(s);
    if (!list.length) continue;
    L.push('', STATUS_LABEL[s].toUpperCase());
    list.forEach(detail);
  }
  const todo = by('todo');
  if (todo.length) {
    L.push('', 'TO DO');
    for (const t of todo.slice(0, 20)) L.push(`  ${t.id} ${t.priority !== 'normal' ? `[${t.priority}] ` : ''}${t.title}`);
    if (todo.length > 20) L.push(`  … ${todo.length - 20} more (${C} list -s todo)`);
  }
  const done = by('done');
  if (done.length) {
    L.push('', 'RECENTLY DONE');
    for (const t of done.slice(0, 5)) L.push(`  ${t.id} ${t.title}${t.summary ? ` — ${trunc(t.summary, 140)}` : ''}`);
  }
  if (!all.length) L.push('', `Board is empty. Create a task: ${C} add "Title" -d "details" --steps "a; b"`);
  L.push('', `Details: ${C} show <ID> · Workflow: see the task board section in CLAUDE.md`);
  console.log(L.join('\n'));
}

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, name + e))));
}

/** How to invoke tb in this repo: `node tb.mjs` if the file is in the repo, `tb` if installed globally. */
function cmdName() {
  const rel = path.relative(topLevel(), SCRIPT);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `node ${rel.split(path.sep).join('/')}`;
  return onPath('tb') ? 'tb' : `node ${SCRIPT.split(path.sep).join('/')}`;
}

// ───────────────────────────── init / CLAUDE.md ─────────────────────────────

function agentInstructions() {
  const C = cmdName();
  return `<!-- taskboard:start -->
## Task board (tb)

This repo tracks work on a task board stored on the git branch \`${BRANCH}\`. It is **not** part of the working tree, so you never commit it with code, and updating it never touches uncommitted work. Use it so that parallel sessions and future sessions know what is going on without re-reading the code.

**At the start of every session**, before exploring the code, run:

    ${C} context

Trust what it says about finished and in-progress work instead of re-discovering it.

**Workflow**
1. Find the task that matches your assignment (\`${C} show <ID>\`), or create one:
   \`${C} add "Short title" -d "what and why" --steps "step one; step two"\`
2. Claim it: \`${C} start <ID>\`
3. After each meaningful step, record progress, and tick steps off:
   \`${C} log <ID> "what you did, what is left, files touched"\`
   \`${C} tick <ID> <step-key>\` · add steps: \`${C} steps <ID> "new step"\`
4. Problems, open questions, decisions the human must make:
   \`${C} issue <ID> "description"\` · when settled: \`${C} resolve <ID> <issue-key> "how"\`
5. Finished and tested: \`${C} move <ID> review\` (the human checks it), or \`${C} done <ID> "summary"\` if no review is needed. If you cannot continue: \`${C} move <ID> blocked\` plus an issue.

**Rules**
- Write log entries so a fresh agent could continue from \`${C} show <ID>\` alone: decisions, file names, the next step.
- Keep tasks small; split big work into several tasks (\`--parent <ID>\`).
- Never mark a task done that is untested or only partly done.
- In cloud/remote sessions (fresh clone each time), run \`${C} sync\` at the start and after each update, so other sessions see your changes.
- Run \`${C} help\` for all commands. Task IDs can be written as \`${'TB'}-4\` or just \`4\`.
<!-- taskboard:end -->
`;
}

function upsertBlock(file, block) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = /<!-- taskboard:start -->[\s\S]*?<!-- taskboard:end -->\n?/;
  if (re.test(text)) text = text.replace(re, block);
  else text = (text.trim() ? text.replace(/\s*$/, '\n\n') : '') + block;
  fs.writeFileSync(file, text);
}

function cmdInit(flags) {
  const top = topLevel();
  let created = false;
  if (!headCommit()) {
    if (hasRemote()) { try { sync({ quiet: true }); } catch { /* offline is fine */ } }
  }
  if (!headCommit()) {
    const prefix = String(flags.prefix || 'TB').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TB';
    const st = { commit: null, config: { prefix, deleted: [], version: 1 }, tasks: new Map() };
    const c = writeBoard(st, [], 'init task board');
    git(['update-ref', REF, c, ZERO()]);
    created = true;
  }
  const files = [path.join(top, 'CLAUDE.md')];
  if (fs.existsSync(path.join(top, 'AGENTS.md'))) files.push(path.join(top, 'AGENTS.md'));
  const block = agentInstructions().replace(/\bTB-4\b/, `${readBoard(headCommit()).config.prefix}-4`);
  for (const f of files) upsertBlock(f, block);
  const C = cmdName();
  console.log(`${created ? 'Created' : 'Found'} task board on branch '${BRANCH}'.`);
  console.log(`Agent instructions written to ${files.map((f) => path.relative(top, f)).join(' and ')}.`);
  console.log(`\nNext:\n  ${C} add "My first task"\n  ${C} ui            # open the board in your browser`);
  if (hasRemote()) console.log(`  ${C} sync          # share the board via '${REMOTE}' (needed for cloud sessions)`);
  console.log(`\n${cmdName().startsWith('node ') ? `Commit ${path.relative(top, SCRIPT)} and CLAUDE.md` : 'Commit CLAUDE.md (and install tb wherever agents run)'} so every agent session has them.`);
}

// ───────────────────────────── web UI ─────────────────────────────

function worktreeInfo() {
  const out = git(['worktree', 'list', '--porcelain'], { allowFail: true }) || '';
  const list = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const m = /^worktree (.+)$/m.exec(block);
    if (!m) continue;
    const wpath = m[1].trim();
    const b = /^branch refs\/heads\/(.+)$/m.exec(block);
    const st = fs.existsSync(wpath) ? git(['-C', wpath, 'status', '--porcelain'], { allowFail: true }) : null;
    list.push({ path: wpath, branch: b ? b[1].trim() : null, dirty: st === null ? null : st.split('\n').filter(Boolean).length });
  }
  return list;
}

function uiHtml() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const a = src.lastIndexOf('/*__UI__'), b = src.lastIndexOf('__UI__*/');
  return src.slice(a + 8, b);
}

function cmdUi(flags) {
  const human = flags.by || process.env.TB_HUMAN || (git(['config', 'user.name'], { allowFail: true }) || '').trim() || 'human';
  const host = flags.host || '127.0.0.1';
  let port = Number(flags.port || process.env.TB_PORT || 4477);
  const html = uiHtml();
  let wtCache = { t: 0, data: [] };
  const okHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h || '') || host !== '127.0.0.1';

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', reject);
  });

  const doOp = (b) => {
    const by = human;
    switch (b.op) {
      case 'add': return ops.add(b, by);
      case 'edit': return ops.edit(b.id, b.fields || {}, by);
      case 'move': return ops.move(b.id, b.status, by);
      case 'log': return ops.log(b.id, b.type, b.msg, by);
      case 'resolve': return ops.resolve(b.id, b.k, b.msg, by);
      case 'steps': return ops.addSteps(b.id, b.text, by);
      case 'tick': return ops.tick(b.id, [b.k], !!b.done, by);
      case 'unstep': return ops.removeStep(b.id, b.k, by);
      case 'rm': return ops.rm(b.id, by);
      case 'sync': return sync({ quiet: true });
      default: fail(`unknown op ${b.op}`);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!okHost(req.headers.host)) return send(res, 403, { ok: false, error: 'bad host' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/head') return send(res, 200, { commit: headCommit() });
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const st = readBoard(headCommit());
        return send(res, 200, {
          commit: st.commit, prefix: st.config.prefix, branch: BRANCH, repo: path.basename(topLevel()),
          remote: hasRemote() ? REMOTE : null, me: human, tasks: [...st.tasks.values()].map((t) => t.data),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/worktrees') {
        if (Date.now() - wtCache.t > 4000) wtCache = { t: Date.now(), data: worktreeInfo() };
        return send(res, 200, wtCache.data);
      }
      if (req.method === 'POST' && url.pathname === '/api/op') {
        if (req.headers['x-tb'] !== '1') return send(res, 403, { ok: false, error: 'missing header' });
        const body = JSON.parse((await readBody(req)) || '{}');
        return send(res, 200, { ok: true, result: doOp(body) });
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !flags.port) { port++; server.listen(port, host); }
    else { console.error(`tb: ${e.message}`); process.exit(1); }
  });
  server.on('listening', () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`Task board running at ${url}  (Ctrl+C to stop)`);
    if (!flags['no-open']) openBrowser(url);
  });
  server.listen(port, host);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); } catch { /* ignore */ }
}

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const pos = [], flags = {};
  const BOOL = new Set(['json', 'all', 'no-open', 'undo', 'help', 'quiet', 'version']);
  const SHORT = { d: 'desc', p: 'priority', l: 'labels', s: 'status', b: 'by', t: 'title', h: 'help', m: 'msg' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let v = eq > 0 ? a.slice(eq + 1) : undefined;
      if (v === undefined) v = BOOL.has(k) ? true : argv[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      flags[k] = v;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const k = SHORT[a[1]] || a[1];
      flags[k] = BOOL.has(k) ? true : argv[++i];
      if (flags[k] === undefined) fail(`${a} needs a value`);
    } else pos.push(a);
  }
  if (flags.description !== undefined && flags.desc === undefined) flags.desc = flags.description;
  return { pos, flags };
}

function help() {
  const C = cmdName();
  console.log(`tb ${VERSION} — git-native task board for AI agents and humans

Setup
  ${C} init [--prefix TB]          create the board + agent instructions in CLAUDE.md
  ${C} ui [--port 4477] [--no-open] open the Kanban board in your browser

Reading
  ${C} context                      compact briefing for a new agent session
  ${C} list [-s status] [--all]     list tasks
  ${C} show <ID> [--json]           full task with steps, issues and log

Working on tasks
  ${C} add "title" [-d desc] [-p high|normal|low] [-l a,b] [--steps "x; y"] [--parent ID]
  ${C} start <ID>                   claim it: in_progress, records agent + branch + worktree
  ${C} log <ID> "message"           progress entry      (note <ID> "…" for plain notes)
  ${C} issue <ID> "message"         record a problem/question
  ${C} resolve <ID> <key> ["how"]   close an issue
  ${C} steps <ID> "step" ["step"…]  add checklist steps
  ${C} tick <ID> <key|n>… [--undo]  mark steps done (or not)
  ${C} move <ID> <status>           ${STATUSES.join(' | ')}
  ${C} done <ID> ["summary"]        finish
  ${C} edit <ID> [-t title] [-d desc] [-p prio] [-l labels] [--parent ID]
  ${C} rm <ID>                      delete

Sharing
  ${C} sync                         merge + push the board branch (for cloud sessions / other machines)

Options & environment
  --by NAME / TB_AGENT   who is acting (default: current git branch)
  TB_BRANCH              board branch name (default: taskboard)
  TB_REMOTE              remote for sync (default: origin)
  TB_AUTOSYNC=1          sync automatically after every change`);
}

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = (pos.shift() || 'help').toLowerCase();
  if (cmd === 'help' || flags.help) return help();
  if (cmd === 'version' || flags.version) return console.log(VERSION);
  setupGit();
  const by = flags.by || defaultAgent();
  const needBoard = () => { if (!headCommit()) fail(`no task board yet, run: ${cmdName()} init`); };
  const msgArg = () => pos.slice(1).join(' ') || flags.msg;

  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'ui': case 'board': case 'gui': needBoard(); return cmdUi(flags);
    case 'context': case 'ctx': case 'brief': needBoard(); return printContext(readBoard(headCommit()));
    case 'list': case 'ls': needBoard(); return printList(readBoard(headCommit()), flags);
    case 'show': case 'view': {
      needBoard();
      const st = readBoard(headCommit());
      const t = getTask(st, pos[0]);
      return flags.json ? console.log(JSON.stringify(t, null, 2)) : printShow(t);
    }
    case 'add': case 'new': case 'create': {
      needBoard();
      const id = ops.add({ title: pos.join(' ') || flags.title, description: flags.desc, priority: flags.priority, labels: flags.labels, steps: flags.steps, parent: flags.parent, status: flags.status }, by);
      const t = getTask(readBoard(headCommit()), id);
      console.log(`created ${id}: ${t.title}`);
      t.steps.forEach((s) => console.log(`  step ${s.k}  ${s.text}`));
      return;
    }
    case 'start': case 'claim': {
      needBoard();
      const r = ops.start(pos[0], by);
      if (r.warn) console.log(r.warn);
      console.log(`${r.id} is now in progress (${by})\n`);
      return printShow(getTask(readBoard(headCommit()), r.id));
    }
    case 'log': case 'progress': case 'note': case 'issue': {
      needBoard();
      const type = cmd === 'log' ? 'progress' : cmd;
      const r = ops.log(pos[0], type, msgArg(), by);
      return console.log(type === 'issue' ? `issue #${r.k} added to ${r.id}` : `logged on ${r.id}`);
    }
    case 'resolve': {
      needBoard();
      const id = ops.resolve(pos[0], pos[1], pos.slice(2).join(' ') || flags.msg, by);
      return console.log(`resolved #${String(pos[1]).replace(/^#/, '')} on ${id}`);
    }
    case 'steps': case 'step': {
      needBoard();
      const r = ops.addSteps(pos[0], pos.slice(1).flatMap(splitList), by);
      return console.log(`added ${r.keys.length} step(s) to ${r.id}: ${r.keys.join(', ')}`);
    }
    case 'tick': case 'check': case 'untick': {
      needBoard();
      if (pos.length < 2) fail('usage: tick <ID> <step-key>…');
      const r = ops.tick(pos[0], pos.slice(1), !(flags.undo || cmd === 'untick'), by);
      return console.log(`steps ${r.done}/${r.total} done`);
    }
    case 'move': case 'mv': case 'status': {
      needBoard();
      if (!pos[1]) fail('usage: move <ID> <status>');
      const id = ops.move(pos[0], pos[1], by, pos.slice(2).join(' ') || flags.msg);
      return console.log(`${id} → ${normStatus(pos[1])}`);
    }
    case 'review': case 'block': case 'todo': {
      needBoard();
      const s = { review: 'review', block: 'blocked', todo: 'todo' }[cmd];
      const id = ops.move(pos[0], s, by, pos.slice(1).join(' ') || flags.msg);
      return console.log(`${id} → ${s}`);
    }
    case 'done': case 'close': case 'finish': {
      needBoard();
      const id = ops.done(pos[0], pos.slice(1).join(' ') || flags.msg, by);
      return console.log(`${id} → done`);
    }
    case 'edit': case 'update': {
      needBoard();
      const f = {};
      if (flags.title !== undefined) f.title = flags.title;
      if (flags.desc !== undefined) f.description = flags.desc;
      if (flags.priority !== undefined) f.priority = flags.priority;
      if (flags.labels !== undefined) f.labels = flags.labels;
      if (flags.parent !== undefined) f.parent = flags.parent;
      if (flags.status !== undefined) f.status = flags.status;
      if (flags.assignee !== undefined) f.assignee = flags.assignee;
      if (!Object.keys(f).length) fail('nothing to edit (use -t, -d, -p, -l, --parent, -s)');
      return console.log(`updated ${ops.edit(pos[0], f, by)}`);
    }
    case 'rm': case 'delete': needBoard(); return console.log(`deleted ${ops.rm(pos[0], by)}`);
    case 'sync': case 'push': case 'pull': needBoard(); sync(); return;
    default: fail(`unknown command "${cmd}" (run: ${cmdName()} help)`);
  }
}

try { main(); } catch (e) {
  console.error(`tb: ${e instanceof UserError ? e.message : e.stack || e.message}`);
  process.exit(1);
}

// The web UI lives below, inside a comment, so this stays a single file.
/*__UI__<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Task board</title>
<style>
:root{--bg:#f5f5f2;--panel:#fff;--card:#fff;--ink:#1c1c1a;--muted:#6d6d67;--faint:#9b9b94;--line:#e3e2dd;--accent:#3b5bdb;
--todo:#868e96;--in_progress:#3b5bdb;--review:#9c36b5;--blocked:#e03131;--done:#2f9e44;--warn:#d9480f;--shadow:0 1px 2px rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1b;--card:#222220;--ink:#ebeae5;--muted:#a3a29b;--faint:#74736d;--line:#30302d;--accent:#748ffc;
--todo:#adb5bd;--in_progress:#748ffc;--review:#da77f2;--blocked:#ff6b6b;--done:#69db7c;--warn:#ffa94d;--shadow:none}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
input,textarea,select,button{font:inherit;color:inherit}
button{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:6px 12px;cursor:pointer}
button:hover{border-color:var(--faint)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.ghost{border-color:transparent;background:transparent;color:var(--muted)}button.ghost:hover{color:var(--ink)}
button.danger{color:var(--blocked)}
header{display:flex;align-items:center;gap:18px;padding:11px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
h1{font-size:15px;margin:0;font-weight:650;white-space:nowrap}h1 span{color:var(--muted);font-weight:450}
.stats{display:flex;gap:14px;color:var(--muted);font-size:12.5px;white-space:nowrap}.stats b{color:var(--ink);font-weight:600}
.spacer{flex:1}
.search{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 10px;width:220px}
.conn{width:8px;height:8px;border-radius:50%;background:var(--done)}.conn.off{background:var(--blocked)}
.board{display:grid;grid-template-columns:repeat(5,minmax(230px,1fr));gap:14px;padding:16px 20px 40px;align-items:start;overflow-x:auto}
.col{border-radius:10px;min-height:120px;display:flex;flex-direction:column;gap:8px;padding:4px;transition:background .1s}
.col.over{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.colhead{display:flex;align-items:center;gap:8px;padding:2px 6px 4px;font-weight:600;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}.count{color:var(--faint);font-weight:500}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px 12px;box-shadow:var(--shadow);cursor:pointer;display:flex;flex-direction:column;gap:6px}
.card:hover{border-color:var(--faint)}.card.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.card.dragging{opacity:.4}
.top{display:flex;gap:7px;align-items:center;font-size:11.5px;color:var(--faint)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.pri{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.03em}.pri.high{color:var(--blocked)}.pri.low{color:var(--faint)}
.ttl{font-weight:550;word-break:break-word}
.bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden}.bar i{display:block;height:100%;background:var(--done)}
.meta{display:flex;flex-wrap:wrap;gap:5px;font-size:11.5px;color:var(--muted)}
.chip{border:1px solid var(--line);border-radius:999px;padding:0 7px;line-height:18px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip.issue{color:var(--blocked);border-color:color-mix(in srgb,var(--blocked) 45%,transparent)}
.chip.dirty{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.last{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.newtask{width:100%;border:1px dashed var(--line);background:transparent;border-radius:9px;padding:8px 12px}
.newtask:focus{outline:none;border-color:var(--accent);background:var(--card)}
.more{font-size:12px;color:var(--faint);text-align:center;padding:4px;cursor:pointer}
.empty{font-size:12px;color:var(--faint);padding:10px 6px}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(540px,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:-10px 0 40px rgba(0,0,0,.12);transform:translateX(105%);transition:transform .18s ease;z-index:10;overflow-y:auto;padding:16px 22px 60px}
.drawer.open{transform:none}
.dhead{display:flex;align-items:center;gap:8px;color:var(--muted)}
.tinput{width:100%;font-size:19px;font-weight:650;border:1px solid transparent;border-radius:7px;padding:4px 6px;margin:6px -6px 4px;background:transparent}
.tinput:hover,.tinput:focus{border-color:var(--line);outline:none}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
select,.inp{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:5px 8px}
.inp{flex:1;min-width:120px}
.kv{display:grid;grid-template-columns:90px 1fr;gap:3px 10px;font-size:12.5px;margin:12px 0;color:var(--muted)}.kv b{font-weight:500;color:var(--ink);word-break:break-all}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:22px 0 8px;font-weight:650}
textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;min-height:70px}
textarea:focus,.inp:focus,select:focus{outline:none;border-color:var(--accent)}
.step{display:flex;gap:8px;align-items:flex-start;padding:3px 0}.step input{margin-top:3px}.step span{flex:1}.step span.mono{flex:none}.step.done span{color:var(--faint);text-decoration:line-through}
.step .x{visibility:hidden;padding:0 6px}.step:hover .x{visibility:visible}
.iss{border:1px solid color-mix(in srgb,var(--blocked) 40%,transparent);background:color-mix(in srgb,var(--blocked) 7%,transparent);border-radius:8px;padding:8px 10px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start}
.iss div{flex:1}
.entry{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:8px 0;border-top:1px solid var(--line);font-size:13px}
.entry .when{color:var(--faint);font-size:11.5px;grid-column:2}
.pill{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:5px;background:var(--bg);color:var(--muted);height:fit-content;margin-top:1px}
.pill.progress{color:var(--in_progress)}.pill.issue{color:var(--blocked)}.pill.done{color:var(--done)}.pill.status{color:var(--review)}
.msg{white-space:pre-wrap;word-break:break-word}.resolved{color:var(--faint);text-decoration:line-through}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 14px;border-radius:8px;font-size:13px;z-index:20;display:none}
.hint{color:var(--faint);font-size:12px}
</style></head><body>
<header>
  <h1 id="h1">Task board</h1>
  <div class="stats" id="stats"></div>
  <div class="spacer"></div>
  <input class="search" id="q" placeholder="Filter…  ( / )">
  <button id="sync" style="display:none">Sync</button>
  <span class="conn" id="conn" title="connected"></span>
</header>
<main class="board" id="board"></main>
<aside class="drawer" id="drawer"></aside>
<div class="toast" id="toast"></div>
<script>
const STATUSES=['todo','in_progress','review','blocked','done'];
const LABEL={todo:'To do',in_progress:'In progress',review:'Review',blocked:'Blocked',done:'Done'};
const S={board:null,head:null,wts:[],open:null,q:'',showAllDone:false};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=iso=>{if(!iso)return'';const s=(Date.now()-new Date(iso))/1e3;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'};
const when=iso=>new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const pr={high:0,normal:1,low:2};const num=id=>+String(id).split('-').pop()||0;
function toast(m){const t=$('#toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',3500)}
async function op(body){
  document.activeElement&&document.activeElement.blur&&document.activeElement.blur();
  try{const r=await fetch('/api/op',{method:'POST',headers:{'content-type':'application/json','x-tb':'1'},body:JSON.stringify(body)});
  const j=await r.json();if(!j.ok)toast(j.error);await refresh(true);return j.result}catch(e){toast('Request failed: '+e.message)}
}
async function refresh(force){
  try{const h=await(await fetch('/api/head')).json();
    if(force||h.commit!==S.head){S.board=await(await fetch('/api/board')).json();S.head=S.board.commit;render()}
    $('#conn').className='conn';$('#conn').title='connected'}
  catch(e){$('#conn').className='conn off';$('#conn').title='server not reachable'}
}
async function loadWts(){try{S.wts=await(await fetch('/api/worktrees')).json();renderBoard()}catch{}}
function dirtyFor(t){if(t.status==='done')return 0;const w=S.wts.find(w=>(t.worktree&&w.path===t.worktree)||(t.branch&&w.branch===t.branch));return w&&w.dirty?w.dirty:0}
const openIssues=t=>(t.log||[]).filter(e=>e.type==='issue'&&!e.resolved);
function matches(t){if(!S.q)return true;const q=S.q.toLowerCase();return[t.id,t.title,t.assignee,t.branch,(t.labels||[]).join(' '),t.description].join(' ').toLowerCase().includes(q)}
function sorted(list,s){return s==='todo'?list.sort((a,b)=>pr[a.priority]-pr[b.priority]||num(a.id)-num(b.id)):list.sort((a,b)=>(b.updated||'').localeCompare(a.updated||''))}
function render(){renderHeader();renderBoard();renderDrawer()}
function renderHeader(){
  const b=S.board;$('#h1').innerHTML=esc(b.repo)+' <span>· '+esc(b.prefix)+'</span>';document.title=b.repo+' · Task board';
  const c=s=>b.tasks.filter(t=>t.status===s).length;const iss=b.tasks.reduce((n,t)=>n+openIssues(t).length,0);
  $('#stats').innerHTML=['in_progress','review','blocked','todo','done'].map(s=>'<span><b>'+c(s)+'</b> '+LABEL[s].toLowerCase()+'</span>').join('')+(iss?'<span style="color:var(--blocked)"><b style="color:inherit">'+iss+'</b> open issue'+(iss>1?'s':'')+'</span>':'');
  $('#sync').style.display=b.remote?'':'none';
}
function card(t){
  const st=t.steps||[],dn=st.filter(s=>s.done).length,oi=openIssues(t).length,dirty=dirtyFor(t);
  const last=[...(t.log||[])].reverse().find(e=>e.type==='progress'||e.type==='note'||e.type==='done');
  const chips=[];
  if(t.assignee&&t.status!=='todo')chips.push('<span class="chip" title="assignee">'+esc(t.assignee)+'</span>');
  if(oi)chips.push('<span class="chip issue">'+oi+' issue'+(oi>1?'s':'')+'</span>');
  if(dirty)chips.push('<span class="chip dirty" title="uncommitted files in '+esc(t.worktree||t.branch)+'">'+dirty+' uncommitted</span>');
  (t.labels||[]).forEach(l=>chips.push('<span class="chip">#'+esc(l)+'</span>'));
  return '<div class="card'+(S.open===t.id?' sel':'')+'" draggable="true" data-id="'+esc(t.id)+'">'+
    '<div class="top"><span class="mono">'+esc(t.id)+'</span>'+(t.priority!=='normal'?'<span class="pri '+t.priority+'">'+t.priority+'</span>':'')+'<span class="spacer"></span><span>'+ago(t.updated)+'</span></div>'+
    '<div class="ttl">'+esc(t.title)+'</div>'+
    (st.length?'<div class="bar" title="'+dn+'/'+st.length+' steps"><i style="width:'+(100*dn/st.length)+'%"></i></div>':'')+
    (last&&t.status!=='todo'?'<div class="last">'+esc(last.msg)+'</div>':'')+
    (chips.length?'<div class="meta">'+chips.join('')+'</div>':'')+'</div>';
}
function renderBoard(){
  if(!S.board)return;const el=$('#board');
  el.innerHTML=STATUSES.map(s=>{
    let list=sorted(S.board.tasks.filter(t=>t.status===s&&matches(t)),s);let more='';
    if(s==='done'&&!S.showAllDone&&list.length>15){more='<div class="more" data-more>Show '+(list.length-15)+' older</div>';list=list.slice(0,15)}
    return '<section class="col" data-status="'+s+'"><div class="colhead"><span class="dot" style="background:var(--'+s+')"></span>'+LABEL[s]+' <span class="count">'+S.board.tasks.filter(t=>t.status===s).length+'</span></div>'+
      (s==='todo'?'<input class="newtask" id="newtask" placeholder="+ New task  ( n )">':'')+
      (list.length?list.map(card).join(''):(s==='todo'?'':'<div class="empty">Nothing here</div>'))+more+'</section>';
  }).join('');
}
function renderDrawer(force){
  const d=$('#drawer');const t=S.open&&S.board&&S.board.tasks.find(x=>x.id===S.open);
  if(!t){d.classList.remove('open');d.dataset.id='';return}
  if(!force&&d.dataset.id===t.id&&d.contains(document.activeElement)&&document.activeElement!==document.body)return;
  d.dataset.id=t.id;d.classList.add('open');
  const st=t.steps||[],dn=st.filter(s=>s.done).length,oi=openIssues(t),dirty=dirtyFor(t);
  const opt=(arr,cur,lab)=>arr.map(v=>'<option value="'+v+'"'+(v===cur?' selected':'')+'>'+(lab?lab[v]:v)+'</option>').join('');
  const log=[...(t.log||[])].filter(e=>e.type!=='created').reverse();
  d.innerHTML=
   '<div class="dhead"><span class="dot" style="background:var(--'+t.status+')"></span><span class="mono">'+esc(t.id)+'</span><span class="spacer" style="flex:1"></span><button class="ghost" data-a="close" title="Esc">✕</button></div>'+
   '<input class="tinput" data-a="title" value="'+esc(t.title)+'">'+
   '<div class="row"><select data-a="status">'+opt(STATUSES,t.status,LABEL)+'</select><select data-a="priority">'+opt(['high','normal','low'],t.priority)+'</select>'+
   '<input class="inp" data-a="labels" placeholder="labels, comma separated" value="'+esc((t.labels||[]).join(', '))+'"></div>'+
   '<div class="kv">'+
     (t.assignee?'<span>Assignee</span><b>'+esc(t.assignee)+'</b>':'')+
     (t.branch?'<span>Branch</span><b>'+esc(t.branch)+'</b>':'')+
     (t.worktree?'<span>Worktree</span><b>'+esc(t.worktree)+(dirty?' <span style="color:var(--warn)">· '+dirty+' uncommitted file'+(dirty>1?'s':'')+'</span>':'')+'</b>':'')+
     (t.parent?'<span>Parent</span><b>'+esc(t.parent)+'</b>':'')+
     '<span>Created</span><b>'+when(t.created)+'</b><span>Updated</span><b>'+when(t.updated)+' ('+ago(t.updated)+')</b>'+
     (t.summary?'<span>Summary</span><b>'+esc(t.summary)+'</b>':'')+
   '</div>'+
   '<h3>Description</h3><textarea data-a="desc" rows="4" placeholder="What and why…">'+esc(t.description)+'</textarea>'+
   '<h3>Steps '+(st.length?dn+'/'+st.length:'')+'</h3>'+
   st.map(s=>'<label class="step'+(s.done?' done':'')+'"><input type="checkbox" data-a="tick" data-k="'+s.k+'"'+(s.done?' checked':'')+'><span>'+esc(s.text)+'</span><span class="mono hint">'+s.k+'</span><button class="ghost x" data-a="unstep" data-k="'+s.k+'">✕</button></label>').join('')+
   '<div class="row"><input class="inp" data-a="addstep" placeholder="Add a step and press Enter"></div>'+
   (oi.length?'<h3 style="color:var(--blocked)">Open issues</h3>'+oi.map(e=>'<div class="iss"><div><div class="msg">'+esc(e.msg)+'</div><div class="hint">#'+e.k+' · '+esc(e.by)+' · '+ago(e.t)+'</div></div><button data-a="resolve" data-k="'+e.k+'">Resolve</button></div>').join(''):'')+
   '<h3>Activity</h3>'+
   '<textarea data-a="composer" rows="2" placeholder="Write a note, progress update or issue…  (Ctrl+Enter)"></textarea>'+
   '<div class="row"><select id="ctype"><option value="note">Note</option><option value="progress">Progress</option><option value="issue">Issue</option></select><button class="primary" data-a="post">Add</button><span class="spacer" style="flex:1"></span><button class="ghost danger" data-a="rm">Delete task</button></div>'+
   (log.length?log.map(e=>'<div class="entry"><span class="pill '+e.type+'">'+e.type+'</span><div class="msg'+(e.type==='issue'&&e.resolved?' resolved':'')+'">'+esc(e.msg)+'</div>'+
     (e.type==='issue'&&e.resolved?'<div class="when" style="grid-column:2">resolved by '+esc(e.resolved.by)+(e.resolved.msg?': '+esc(e.resolved.msg):'')+'</div>':'')+
     '<div class="when">'+esc(e.by)+' · '+when(e.t)+'</div></div>').join(''):'<div class="hint">No activity yet.</div>');
}
function openTask(id){S.open=id;renderBoard();renderDrawer(true)}
// board events
$('#board').addEventListener('click',e=>{const c=e.target.closest('.card');if(c)return openTask(c.dataset.id);if(e.target.closest('[data-more]')){S.showAllDone=true;renderBoard()}});
$('#board').addEventListener('keydown',async e=>{if(e.target.id==='newtask'&&e.key==='Enter'&&e.target.value.trim()){const id=await op({op:'add',title:e.target.value.trim()});if(id)openTask(id)}if(e.key==='Escape')e.target.blur()});
let dragId=null;
$('#board').addEventListener('dragstart',e=>{const c=e.target.closest('.card');if(!c)return;dragId=c.dataset.id;c.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',dragId)});
$('#board').addEventListener('dragend',e=>{document.querySelectorAll('.dragging,.over').forEach(x=>x.classList.remove('dragging','over'))});
$('#board').addEventListener('dragover',e=>{const col=e.target.closest('.col');if(!col||!dragId)return;e.preventDefault();document.querySelectorAll('.col.over').forEach(x=>x!==col&&x.classList.remove('over'));col.classList.add('over')});
$('#board').addEventListener('drop',e=>{const col=e.target.closest('.col');if(!col||!dragId)return;e.preventDefault();const t=S.board.tasks.find(x=>x.id===dragId);const s=col.dataset.status;dragId=null;if(t&&t.status!==s){t.status=s;renderBoard();op({op:'move',id:t.id,status:s})}});
// drawer events
const D=$('#drawer');
D.addEventListener('click',e=>{const a=e.target.closest('[data-a]');if(!a)return;const id=S.open,k=a.dataset.k;
  switch(a.dataset.a){
    case'close':S.open=null;render();break;
    case'unstep':e.preventDefault();op({op:'unstep',id,k});break;
    case'resolve':{const m=prompt('How was it resolved? (optional)');if(m!==null)op({op:'resolve',id,k,msg:m});break}
    case'post':post();break;
    case'rm':if(confirm('Delete '+id+'? This cannot be undone.')){op({op:'rm',id});S.open=null}break;
  }});
D.addEventListener('change',e=>{const a=e.target.dataset.a,id=S.open,v=e.target.value;
  if(a==='title')op({op:'edit',id,fields:{title:v}});
  if(a==='status')op({op:'move',id,status:v});
  if(a==='priority')op({op:'edit',id,fields:{priority:v}});
  if(a==='labels')op({op:'edit',id,fields:{labels:v}});
  if(a==='desc')op({op:'edit',id,fields:{description:v}});
  if(a==='tick')op({op:'tick',id,k:e.target.dataset.k,done:e.target.checked});
});
D.addEventListener('keydown',e=>{const a=e.target.dataset.a;
  if(a==='addstep'&&e.key==='Enter'&&e.target.value.trim()){op({op:'steps',id:S.open,text:e.target.value.trim()})}
  if(a==='title'&&e.key==='Enter')e.target.blur();
  if(a==='composer'&&e.key==='Enter'&&(e.ctrlKey||e.metaKey))post();
});
function post(){const ta=D.querySelector('[data-a=composer]');const m=ta.value.trim();if(!m)return;op({op:'log',id:S.open,type:$('#ctype').value,msg:m})}
// global
$('#q').addEventListener('input',e=>{S.q=e.target.value;renderBoard()});
$('#sync').addEventListener('click',async()=>{$('#sync').textContent='Syncing…';const r=await op({op:'sync'});$('#sync').textContent='Sync';if(r)toast('Sync: '+r)});
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
  if(e.key==='Escape'&&S.open){S.open=null;render()}
  if(e.key==='/'){e.preventDefault();$('#q').focus()}
  if(e.key==='n'){e.preventDefault();const n=$('#newtask');n&&n.focus()}});
setInterval(refresh,1500);setInterval(loadWts,6000);setInterval(()=>{if(S.board)renderBoard()},60000);
refresh(true).then(loadWts);
</script></body></html>
__UI__*/
