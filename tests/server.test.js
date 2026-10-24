const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3987;
const PASSWORD = 'test-password-not-default';
const BASE = `http://127.0.0.1:${PORT}`;

const SESSIONS_FILE = path.join(os.tmpdir(), `ytdl-test-sessions-${process.pid}.json`);

// Empty-string env vars would fall back to .env, so these tests set explicit values.
function runServer(env) {
  return spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SESSIONS_FILE, ...env }
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
}

function stopServer(proc) {
  return new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); });
}

describe('server startup safety', () => {
  test('refuses the publicly known default password', () => {
    const r = spawnSync('node', ['server.js'], {
      cwd: ROOT, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, APP_PASSWORD: 'download123', PORT: String(PORT) }
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /default/i);
  });
});

describe('server API', () => {
  let proc;
  let token;

  before(async () => {
    try { fs.unlinkSync(SESSIONS_FILE); } catch (e) { }
    proc = runServer({ APP_PASSWORD: PASSWORD });
    await waitForServer();
    const res = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD })
    });
    token = (await res.json()).token;
  });

  after(async () => {
    if (proc) await stopServer(proc);
    try { fs.unlinkSync(SESSIONS_FILE); } catch (e) { }
  });

  test('session token is not accepted as a query parameter on API routes', async () => {
    const r = await fetch(`${BASE}/api/info?url=https://example.com/v&token=${token}`);
    assert.strictEqual(r.status, 401);
  });

  test('file route rejects forged or expired signed links', async () => {
    const future = Date.now() + 60000;
    const forged = await fetch(`${BASE}/api/file/x.mp4?exp=${future}&sig=${'0'.repeat(64)}`);
    assert.strictEqual(forged.status, 401);
    const expired = await fetch(`${BASE}/api/file/x.mp4?exp=1&sig=${'a'.repeat(64)}`);
    assert.strictEqual(expired.status, 401);
  });

  test('sessions survive a restart, and only token hashes are stored', async () => {
    const saved = fs.readFileSync(SESSIONS_FILE, 'utf8');
    assert.ok(!saved.includes(token), 'raw token must not be written to disk');
    await stopServer(proc);
    proc = runServer({ APP_PASSWORD: PASSWORD });
    await waitForServer();
    const r = await fetch(`${BASE}/api/auth/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
    });
    assert.strictEqual(r.status, 200);
  });

  test('changing the password invalidates saved sessions', async () => {
    await stopServer(proc);
    proc = runServer({ APP_PASSWORD: PASSWORD + '-rotated' });
    await waitForServer();
    const r = await fetch(`${BASE}/api/auth/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
    });
    assert.strictEqual(r.status, 401);
    // Restore the original password for the remaining tests.
    await stopServer(proc);
    proc = runServer({ APP_PASSWORD: PASSWORD });
    await waitForServer();
    const res = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD })
    });
    token = (await res.json()).token;
  });

  test('download and info endpoints require auth', async () => {
    assert.strictEqual((await fetch(`${BASE}/api/info?url=https://example.com/v`)).status, 401);
    const r = await fetch(`${BASE}/api/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await fetch(`${BASE}/api/file/x.mp4`)).status, 401);
  });

  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:22/',
    'http://localhost/',
    'http://[::1]/',
    'http://10.0.0.5/x',
    'file:///etc/passwd',
    '--exec id',
    'not a url'
  ]) {
    test(`rejects unsafe URL: ${bad}`, async () => {
      const r = await fetch(`${BASE}/api/info?url=${encodeURIComponent(bad)}`, { headers: { 'x-access-token': token } });
      assert.strictEqual(r.status, 400);
    });
  }

  test('malformed JSON gets a plain 400 without a stack trace', async () => {
    const r = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '0x%5B%5D=DTAB'
    });
    assert.strictEqual(r.status, 400);
    const text = await r.text();
    assert.ok(!/node_modules|at JSON\.parse|SyntaxError/.test(text), text);
  });

  test('file route blocks traversal and hidden entries', async () => {
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '.jobs', '.uploads_temp']) {
      const r = await fetch(`${BASE}/api/file/${name}`, { headers: { 'x-access-token': token } });
      assert.ok([400, 404].includes(r.status), `${name} -> ${r.status}`);
    }
  });
});
