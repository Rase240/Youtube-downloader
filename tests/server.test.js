const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3987;
const PASSWORD = 'test-password-not-default';
const BASE = `http://127.0.0.1:${PORT}`;

// Empty-string env vars would fall back to .env, so these tests set explicit values.
function runServer(env) {
  return spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ...env } });
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
    proc = runServer({ APP_PASSWORD: PASSWORD });
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${BASE}/api/health`); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    const res = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD })
    });
    token = (await res.json()).token;
  });

  after(() => { if (proc) proc.kill(); });

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

  test('file route blocks traversal and hidden entries', async () => {
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '.jobs', '.uploads_temp']) {
      const r = await fetch(`${BASE}/api/file/${name}`, { headers: { 'x-access-token': token } });
      assert.ok([400, 404].includes(r.status), `${name} -> ${r.status}`);
    }
  });
});
