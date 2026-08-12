/**
 * Origin gate + stdio↔WS round trip.
 *
 * The gate is the one thing this fork adds to the transport, so it is the one
 * thing worth testing at the wire level: the server is spawned as a real child
 * process and driven with a real WebSocket client, exactly as Chrome would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'index.js');
const repoRoot = join(here, '..', '..');

// The real Chrome Web Store ID, assigned at item creation. Its public key is
// pinned in extension/manifest.json, so the unpacked build and the store build
// derive the same ID — the test below proves that rather than trusting it.
const PUBLISHED_EXTENSION_ID = 'ibkmogfbmahilhjcafoahjifiiinmnlf';
const OUR_ORIGIN = `chrome-extension://${PUBLISHED_EXTENSION_ID}`;
const STORE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // stands in for a CWS-assigned ID

/** Spawn the MCP server and resolve once it reports the port it bound. */
// Bind outside 9876-9895 so a real extension running in a real Chrome cannot
// connect to the server under test and steal the session from the fake client.
let nextTestPort = 19876;
function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { SARTEL_BROWSER_MCP_BASE_PORT: String((nextTestPort += 20)), ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');

  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never listened:\n${stderr}`)), 10000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const m = stderr.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('error', reject);
  });

  return { child, ready, stderr: () => stderr };
}

/** Try one handshake. Resolves 'open' or the rejection status code. */
function handshake(port, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('handshake timed out'));
    }, 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ outcome: 'open', ws });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ outcome: 'rejected', status: res.statusCode });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ outcome: 'error', error: err.message });
    });
  });
}

// The single check that keeps a published server able to talk to a published
// extension. Chrome derives an extension's ID from the manifest's public key; the
// server allowlists an ID. If those two ever drift apart, every store user's
// extension is refused by its own server, and nothing else in this suite notices —
// the fake client in the other tests uses whatever origin it is handed.
//
// So: derive the ID the way Chrome does and compare, rather than grepping for a
// string that could be stale in either file.
test('the pinned manifest key derives the ID the server allowlists', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string');
  assert.ok(manifest.key.length > 300, 'manifest must pin the public key');

  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
  const derived = [...digest.slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');

  assert.equal(derived, PUBLISHED_EXTENSION_ID, 'manifest key must derive the published ID');
  const source = readFileSync(serverPath, 'utf8');
  assert.ok(source.includes(PUBLISHED_EXTENSION_ID), 'server must allowlist the published ID');
});

// The store rejects the whole upload over this, and it costs a full round trip to
// find out: items.insert returned PKG_MANIFEST_SUMMARY_TOO_LONG at 145 characters,
// after building, authenticating and uploading. Cheaper to fail here.
test('manifest description fits the Chrome Web Store limit', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(
    manifest.description.length <= 132,
    `description is ${manifest.description.length} chars; the store caps it at 132`,
  );
});

test('origin gate', async (t) => {
  const server = startServer();
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  await t.test('accepts our extension origin', async () => {
    const r = await handshake(port, OUR_ORIGIN);
    assert.equal(r.outcome, 'open');
    r.ws.close();
  });

  await t.test('rejects a web page origin with 403', async () => {
    const r = await handshake(port, 'https://evil.example');
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.status, 403);
  });

  await t.test('rejects a handshake with no Origin header', async () => {
    const r = await handshake(port, null);
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.status, 403);
  });

  await t.test('rejects another extension origin', async () => {
    const r = await handshake(port, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.status, 403);
  });
});

test('SARTEL_BROWSER_MCP_ALLOWED_ORIGIN adds exactly one extra origin', async (t) => {
  const server = startServer({ SARTEL_BROWSER_MCP_ALLOWED_ORIGIN: 'http://localhost:5173' });
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  const allowed = await handshake(port, 'http://localhost:5173');
  assert.equal(allowed.outcome, 'open');
  allowed.ws.close();

  const stillOurs = await handshake(port, OUR_ORIGIN);
  assert.equal(stillOurs.outcome, 'open');
  stillOurs.ws.close();

  const denied = await handshake(port, 'http://localhost:5174');
  assert.equal(denied.outcome, 'rejected');
  assert.equal(denied.status, 403);
});

test('SARTEL_BROWSER_MCP_EXTENSION_ID replaces the extension the gate accepts', async (t) => {
  const server = startServer({ SARTEL_BROWSER_MCP_EXTENSION_ID: STORE_ID });
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  const store = await handshake(port, `chrome-extension://${STORE_ID}`);
  assert.equal(store.outcome, 'open', 'the injected store ID is accepted');
  store.ws.close();

  // The override replaces the fallback rather than adding to it: a published
  // server must not keep trusting the development identity.
  const dev = await handshake(port, OUR_ORIGIN);
  assert.equal(dev.outcome, 'rejected');
  assert.equal(dev.status, 403);
});

test('the ID override and the escape hatch compose', async (t) => {
  const server = startServer({
    SARTEL_BROWSER_MCP_EXTENSION_ID: STORE_ID,
    SARTEL_BROWSER_MCP_ALLOWED_ORIGIN: OUR_ORIGIN,
  });
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  for (const origin of [`chrome-extension://${STORE_ID}`, OUR_ORIGIN]) {
    const r = await handshake(port, origin);
    assert.equal(r.outcome, 'open', `${origin} is accepted`);
    r.ws.close();
  }

  const denied = await handshake(port, 'https://evil.example');
  assert.equal(denied.outcome, 'rejected');
  assert.equal(denied.status, 403);
});

test('stdio → WS → response round trip', async (t) => {
  const server = startServer();
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  // Stand in for the extension's offscreen document.
  const { outcome, ws } = await handshake(port, OUR_ORIGIN);
  assert.equal(outcome, 'open');
  t.after(() => ws.close());

  ws.on('message', (data) => {
    const cmd = JSON.parse(data.toString());
    if (cmd.method === 'navigate') {
      ws.send(JSON.stringify({ id: cmd.id, result: { ok: true, url: cmd.params.url } }));
    }
  });

  // Newline-delimited JSON-RPC over the server's stdin/stdout.
  const replies = new Map();
  let buffer = '';
  server.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = replies.get(msg.id);
      if (waiter) {
        replies.delete(msg.id);
        waiter(msg);
      }
    }
  });

  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10000);
    replies.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'origin-gate-test', version: '0' },
  });
  assert.equal(init.result.serverInfo.name, 'sartel-browser');

  server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc(2, 'tools/list', {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('browser_solve_captcha'), 'the upstream CAPTCHA tool is exposed');
  assert.equal(names.length, 41, 'the full upstream tool surface is exposed');

  const called = await rpc(3, 'tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  const payload = JSON.parse(called.result.content[0].text);
  assert.deepEqual(payload, { ok: true, url: 'https://example.com' });
});

// Regression guard, found by driving a real idle Chrome rather than a fake client.
//
// Upstream waited 5 × 1500ms = 7.5s for the extension. That is enough for a
// long-lived server, which is how upstream is run. Ours is spawned per session by
// the connector daemon, so a fresh server routinely meets an asleep extension: the
// offscreen document only scans every 2s while it is alive, and reviving it after
// the MV3 service worker has idled measured ~9s. The first browser tool call of the
// session therefore failed. These two tests exist so that budget cannot quietly
// shrink back below what a real Chrome needs.
test('the connect budget clears the measured worst case', () => {
  const source = readFileSync(serverPath, 'utf8');
  const retries = Number(/CONNECT_RETRIES = (\d+)/.exec(source)?.[1]);
  const delay = Number(/RETRY_DELAY_MS = (\d+)/.exec(source)?.[1]);
  assert.ok(Number.isFinite(retries) && Number.isFinite(delay), 'budget constants are readable');
  const windowMs = retries * delay;
  assert.ok(windowMs >= 15000, `connect window ${windowMs}ms must clear the ~9s revival with margin`);
  assert.ok(windowMs <= 40000, `connect window ${windowMs}ms would read as a hang`);
});

test('a tool call issued before the extension connects still succeeds', async (t) => {
  const server = startServer();
  const port = await server.ready;
  t.after(() => server.child.kill('SIGKILL'));

  const replies = new Map();
  let buffer = '';
  server.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = replies.get(msg.id);
      if (waiter) { replies.delete(msg.id); waiter(msg); }
    }
  });
  const rpc = (id, method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), timeoutMs);
    replies.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'late-connect-test', version: '0' },
  });
  server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Fire the call with NO extension attached, then connect 9s later — the delay
  // that beat the old 7.5s budget.
  const pending = rpc(2, 'tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } });

  await new Promise((r) => setTimeout(r, 9000));
  const { outcome, ws } = await handshake(port, OUR_ORIGIN);
  assert.equal(outcome, 'open');
  t.after(() => ws.close());
  ws.on('message', (data) => {
    const cmd = JSON.parse(data.toString());
    if (cmd.method === 'navigate') ws.send(JSON.stringify({ id: cmd.id, result: { ok: true, url: cmd.params.url } }));
  });

  const called = await pending;
  assert.ok(!called.result?.isError, 'the late connect is waited out, not failed');
  assert.deepEqual(JSON.parse(called.result.content[0].text), { ok: true, url: 'https://example.com' });
});

// This fork tracks upstream's tool surface exactly. The check is here so a
// partial restore — schema back but handler missing, or vice versa — fails
// loudly instead of erroring only at the moment a user hits a CAPTCHA.
test('browser_solve_captcha matches upstream, schema and handler', async () => {
  const { TOOLS } = await import(join(here, '..', 'tools.js'));
  const tool = TOOLS.find((entry) => entry.name === 'browser_solve_captcha');
  assert.ok(tool, 'tool exists');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['detect', 'click_checkbox', 'click_grid', 'ask_human']);
  assert.ok(tool.inputSchema.properties.cells, 'grid cells parameter is present');

  const background = readFileSync(join(repoRoot, 'extension', 'background.js'), 'utf8');
  for (const symbol of ["case 'solve_captcha'", 'clickRecaptchaCheckbox', 'clickCaptchaGridCells']) {
    assert.ok(background.includes(symbol), `background.js still implements ${symbol}`);
  }
});
