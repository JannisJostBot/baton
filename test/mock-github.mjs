// Minimal mock of the GitHub REST endpoints the Pages board uses, backed by a real
// local git repo. Used by test/pages.test.py. Usage: node mock-github.mjs <repo> <port>
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [repo, port = '5051'] = process.argv.slice(2);
const TOKEN = 'good-token';
const git = (args, opt = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...opt });
const tryGit = (args, opt) => { try { return git(args, opt); } catch { return null; } };
const stats = { requests: 0, writes: 0, conflicts: 0 };

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, Accept',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  'access-control-expose-headers': 'ETag',
};
function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...cors, 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d ? JSON.parse(d) : {})); });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  stats.requests++;
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (req.headers.authorization && !authed) return send(res, 401, { message: 'Bad credentials' });
  let m;
  try {
    if (p === '/_stats') return send(res, 200, stats);
    if (p === '/user') return authed ? send(res, 200, { login: 'jannis-web' }) : send(res, 401, { message: 'Requires authentication' });
    if ((m = /^\/raw\/[^/]+\/[^/]+\/([0-9a-f]+)\/(.+)$/.exec(p))) {
      const t = tryGit(['show', `${m[1]}:${m[2]}`]);
      return t === null ? send(res, 404, '404: Not Found') : send(res, 200, t);
    }
    if (!(m = /^\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(p))) return send(res, 404, { message: 'Not Found' });
    const rest = m[1];
    if (req.method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = tryGit(['rev-parse', '--verify', '-q', `refs/heads/${m[1]}`]);
      if (!sha) return send(res, 404, { message: 'Not Found' });
      const etag = `"${sha.trim()}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...cors, etag }); return res.end(); }
      return send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: sha.trim(), type: 'commit' } }, { etag });
    }
    if (req.method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const tree = git(['rev-parse', `${m[1]}^{tree}`]).trim();
      return send(res, 200, { sha: m[1], tree: { sha: tree } });
    }
    if (req.method === 'GET' && (m = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      const tree = git(['ls-tree', '-r', m[1]]).split('\n').filter(Boolean).map((l) => {
        const [meta, file] = l.split('\t'); const [mode, type, sha] = meta.split(' ');
        return { path: file, mode, type, sha };
      });
      return send(res, 200, { sha: m[1], tree });
    }
    if (req.method === 'GET' && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const t = tryGit(['show', `${url.searchParams.get('ref')}:${m[1]}`]);
      return t === null ? send(res, 404, { message: 'Not Found' }) : send(res, 200, t);
    }
    if (!authed) return send(res, 404, { message: 'Not Found' }); // GitHub hides write endpoints from anonymous users
    if (req.method === 'POST' && rest === '/git/trees') {
      const b = await readBody(req);
      const idx = path.join(os.tmpdir(), `idx-${process.pid}-${Date.now()}-${Math.random()}`);
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      git(['read-tree', b.base_tree], { env });
      for (const e of b.tree) {
        if (e.sha === null) git(['update-index', '--force-remove', e.path], { env });
        else {
          const sha = git(['hash-object', '-w', '--stdin'], { input: e.content }).trim();
          git(['update-index', '--add', '--cacheinfo', `${e.mode},${sha},${e.path}`], { env });
        }
      }
      const sha = git(['write-tree'], { env }).trim();
      fs.rmSync(idx, { force: true });
      return send(res, 201, { sha });
    }
    if (req.method === 'POST' && rest === '/git/commits') {
      const b = await readBody(req);
      const args = ['commit-tree', b.tree, ...b.parents.flatMap((x) => ['-p', x]), '-m', b.message];
      const sha = git(args, { env: { ...process.env, GIT_AUTHOR_NAME: 'web', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'web', GIT_COMMITTER_EMAIL: 'w@x' } }).trim();
      return send(res, 201, { sha });
    }
    if (req.method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const b = await readBody(req);
      const cur = git(['rev-parse', `refs/heads/${m[1]}`]).trim();
      if (!b.force && tryGit(['merge-base', '--is-ancestor', cur, b.sha]) === null) {
        stats.conflicts++;
        return send(res, 422, { message: 'Update is not a fast forward' });
      }
      git(['update-ref', `refs/heads/${m[1]}`, b.sha, cur]);
      stats.writes++;
      return send(res, 200, { object: { sha: b.sha } });
    }
    send(res, 404, { message: 'Not Found' });
  } catch (e) {
    send(res, 500, { message: e.message });
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`mock github on ${port}`));
