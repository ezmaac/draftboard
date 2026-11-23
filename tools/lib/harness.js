// Starts the real server (server.js) as a child process against its own SQLite file and
// gives you an HTTP client with a cookie jar. Used by the test suite (test/) and the seed
// script (tools/seed.js). No dependencies beyond Node 22.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

class ApiError extends Error {
  constructor(method, url, status, data) {
    super(`${method} ${url} → ${status}: ${data?.error || JSON.stringify(data)}`);
    this.status = status; this.data = data;
  }
}

/** One logged-in browser: remembers its session cookie between requests. */
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.user = null; }

  /** Raw request: resolves to { status, data } whatever the status code. */
  async req(method, url, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await fetch(this.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const m = /^sid=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `sid=${m[1]}` : '';
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }

  /** Request that must succeed: returns the JSON body, throws ApiError otherwise. */
  async ok(method, url, body) {
    const { status, data } = await this.req(method, url, body);
    if (status >= 400) throw new ApiError(method, url, status, data);
    return data;
  }
  get(url) { return this.ok('GET', url); }
  post(url, body = {}) { return this.ok('POST', url, body); }
  put(url, body = {}) { return this.ok('PUT', url, body); }
  del(url) { return this.ok('DELETE', url); }

  async register(username, { password = 'password1', display_name, email, invite_code } = {}) {
    const r = await this.post('/api/register', { username, password, display_name: display_name || username, email, invite_code: invite_code ?? this.inviteCode });
    this.user = r.user;
    return r.user;
  }
  async login(username, password = 'password1') {
    const r = await this.post('/api/login', { username, password });
    this.user = r.user;
    return r.user;
  }

  /**
   * Open a Server-Sent Events stream (as the board does) and collect its text.
   * Returns { waitFor(regex, ms), close() }.
   */
  async events(key) {
    const ctrl = new AbortController();
    const r = await fetch(`${this.base}/api/events/${key}`, { headers: { cookie: this.cookie }, signal: ctrl.signal });
    if (r.status !== 200) throw new ApiError('GET', `/api/events/${key}`, r.status, await r.text());
    let buf = '';
    const waiters = [];
    const check = () => { for (const w of [...waiters]) { const m = w.re.exec(buf); if (m) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); } } };
    (async () => {
      const dec = new TextDecoder();
      try { for await (const chunk of r.body) { buf += dec.decode(chunk, { stream: true }); check(); } } catch { /* aborted */ }
    })();
    return {
      text: () => buf,
      clear: () => { buf = ''; },
      waitFor: (re, ms = 3000) => new Promise((resolve, reject) => {
        const w = { re, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`No ${re} on event stream ${key} within ${ms}ms. Got:\n${buf}`)); }, ms) };
        waiters.push(w); check();
      }),
      close: () => ctrl.abort(),
    };
  }
}

/**
 * Start server.js. Options:
 *   dbFile — SQLite file to use (default: a fresh temp file, deleted on stop)
 *   env    — extra environment variables
 *   quiet  — don't echo server output (it is always captured in log())
 */
async function startServer({ dbFile, env = {}, quiet = true } = {}) {
  const tmpDir = dbFile ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'draftboard-test-'));
  const file = dbFile ? path.resolve(dbFile) : path.join(tmpDir, 'test.db');
  const port = await freePort();
  const inviteCode = env.INVITE_CODE ?? process.env.INVITE_CODE ?? 'goleafsgo';
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, SMTP_URL: '', LOGO_URL: '', APP_URL: `http://localhost:${port}`, ...env, PORT: String(port), DB_FILE: file, INVITE_CODE: inviteCode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const onData = d => { log += d; if (!quiet) process.stdout.write(d); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exited = false;
  const exitP = new Promise(resolve => child.on('exit', code => { exited = true; resolve(code); }));

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (exited) throw new Error(`Server exited during start-up:\n${log}`);
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (i > 100) { child.kill(); throw new Error(`Server did not start within 10s:\n${log}`); }
    await new Promise(r => setTimeout(r, 100));
  }

  return {
    url, port, dbFile: file, inviteCode,
    log: () => log,
    client() { const c = new Client(url); c.inviteCode = inviteCode; return c; },
    async stop() {
      if (!exited) { child.kill(); await exitP; }
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, Client, ApiError, ROOT };
