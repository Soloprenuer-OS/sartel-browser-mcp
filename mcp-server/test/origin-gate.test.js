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

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'index.js');
const repoRoot = join(here, '..', '..');

// The unpacked/dev ID derived from key.pem. The published Chrome Web Store ID is
// assigned by CWS at first upload and is injected via SARTEL_BROWSER_MCP_EXTENSION_ID
// (or baked in) before the npm package is published — see store/SUBMIT.md.
const DEV_EXTENSION_ID = 'mjnnkmbiaoheconngckmilheckmepnam';
const OUR_ORIGIN = `chrome-extension://${DEV_EXTENSION_ID}`;
const STORE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // stands in for a CWS-assigned ID

/** Spawn the MCP server and resolve once it reports the port it bound. */
function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
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

test('the pinned manifest key and the server fallback name the same extension', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string');
  assert.ok(manifest.key.length > 300, 'manifest must pin the public key');
  const source = readFileSync(serverPath, 'utf8');
  assert.ok(source.includes(DEV_EXTENSION_ID), 'server must fall back to the dev extension ID');
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
  assert.ok(names.includes('browser_captcha_handoff'), 'captcha handoff tool is exposed');
  assert.ok(!names.includes('browser_solve_captcha'), 'no CAPTCHA-solving tool is exposed');

  const called = await rpc(3, 'tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  const payload = JSON.parse(called.result.content[0].text);
  assert.deepEqual(payload, { ok: true, url: 'https://example.com' });
});

test('browser_captcha_handoff offers no solving actions', async () => {
  const { TOOLS } = await import(join(here, '..', 'tools.js'));
  const tool = TOOLS.find((entry) => entry.name === 'browser_captcha_handoff');
  assert.ok(tool, 'tool exists');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['detect', 'ask_human']);
  assert.equal(tool.inputSchema.properties.cells, undefined);
  assert.ok(!/solve/i.test(tool.description) || /does not attempt to solve/i.test(tool.description));
});
