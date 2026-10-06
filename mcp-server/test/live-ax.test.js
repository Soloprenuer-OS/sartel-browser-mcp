import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Run with SARTEL_BROWSER_AX_LIVE=1 and SARTEL_CHROME_FOR_TESTING=<binary>.
// The test talks to the unpacked extension's actual service worker over CDP.
// It avoids the localhost MCP bridge, which may be blocked by macOS Local Network
// permission in a locked/headless test session. Tool advertisement is unit-tested.
const run = process.env.SARTEL_BROWSER_AX_LIVE === '1';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chromeBinary = process.env.SARTEL_CHROME_FOR_TESTING;

function waitFor(fn, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const poll = async () => {
      try { const value = await fn(); if (value) return resolve(value); } catch {}
      if (Date.now() >= until) return reject(new Error('Timed out waiting for unpacked extension'));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function workerCDP(debugPort) {
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find(entry => entry.type === 'service_worker' &&
      entry.url === 'chrome-extension://ibkmogfbmahilhjcafoahjifiiinmnlf/background.js');
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  return {
    async evaluate(expression) {
      const raw = await new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        ws.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true,
        } }));
      });
      if (raw.exceptionDetails) throw new Error(raw.exceptionDetails.exception?.description || raw.exceptionDetails.text);
      return raw.result.value;
    },
    close() { ws.close(); },
  };
}

test('unpacked extension/CDP: observe → fill/click → verify, with stale, obscured and cross-session refs',
  { skip: !run, timeout: 120000 }, async () => {
    assert(chromeBinary, 'Set SARTEL_CHROME_FOR_TESTING to Chrome for Testing binary');
    const dir = mkdtempSync('/tmp/sartel-b4-live-');
    const ext = join(dir, 'extension');
    cpSync(join(repo, 'extension'), ext, { recursive: true });
    assert(readFileSync(join(ext, 'background.js'), 'utf8').includes("case 'observe'"));
    writeFileSync(join(ext, 'ax-fixture.html'), `<!doctype html><html><body style="font:22px sans-serif;padding:40px">
      <h1>AX reference fixture</h1><label>Name <input aria-label="Name"></label>
      <button id="save">Save</button><p id="count">Not saved</p><div id="host"></div>
      <script src="ax-fixture.js"></script></body></html>`);
    writeFileSync(join(ext, 'ax-fixture.js'), `
      document.querySelector('#save').onclick=()=>{const count=document.querySelector('#count');count.textContent='Saved '+(Number(count.dataset.count||0)+1);count.dataset.count=Number(count.dataset.count||0)+1};
      const shadow=document.querySelector('#host').attachShadow({mode:'open'});
      shadow.innerHTML='<button>Shadow Save</button>';
      shadow.querySelector('button').onclick=()=>shadow.querySelector('button').textContent='Shadow Saved';
    `);
    const pageUrl = 'chrome-extension://ibkmogfbmahilhjcafoahjifiiinmnlf/ax-fixture.html';
    const chrome = spawn(chromeBinary, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
      `--user-data-dir=${join(dir, 'profile')}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let chromeLog = '';
    chrome.stderr.on('data', data => { chromeLog = (chromeLog + data.toString()).slice(-4000); });
    let cdp;
    try {
      const debugPort = await waitFor(() => {
        try { return Number(readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]); }
        catch { return null; }
      });
      cdp = await workerCDP(debugPort);
      await waitFor(() => cdp.evaluate('typeof dispatch === "function"'));
      const call = (port, method, params = {}) => cdp.evaluate(`dispatch(${JSON.stringify(port)},${JSON.stringify(method)},${JSON.stringify(params)})`);
      const script = (port, code) => call(port, 'execute_script', { code }).then(result => result.result);
      const screenshot = async (port, path) => {
        const result = await call(port, 'screenshot');
        assert(result.image?.startsWith('data:image/png;base64,'));
        writeFileSync(path, Buffer.from(result.image.slice('data:image/png;base64,'.length), 'base64'));
      };
      const owner = 70001;
      const foreign = 70002;
      const nav = await call(owner, 'navigate', { url: pageUrl });
      const tabId = nav.tab_id;
      assert.equal(nav.url, pageUrl);
      const evidenceDir = process.env.SARTEL_BROWSER_AX_EVIDENCE_DIR;
      if (evidenceDir) { mkdirSync(evidenceDir, { recursive: true }); await screenshot(owner, join(evidenceDir, 'b4-before.png')); }

      const first = await call(owner, 'observe', { tab_id: tabId });
      const fillRef = first.nodes.find(node => node.role === 'textbox' && node.name === 'Name')?.ref;
      const saveRef = first.nodes.find(node => node.role === 'button' && node.name === 'Save')?.ref;
      const shadowRef = first.nodes.find(node => node.name === 'Shadow Save')?.ref;
      assert(fillRef && saveRef && shadowRef, 'AX tree exposes input, button and shadow control');
      assert.equal((await call(owner, 'fill_ref', { tab_id: tabId, ref: fillRef, value: 'Eden' })).value, 'Eden');
      assert.equal(await script(owner, 'document.querySelector("input").value'), 'Eden');
      await assert.rejects(call(owner, 'click_ref', { tab_id: tabId, ref: saveRef }), /stale/i);
      const freshSave = (await call(owner, 'observe', { tab_id: tabId })).nodes.find(node => node.name === 'Save')?.ref;
      assert(freshSave);
      await call(owner, 'click_ref', { tab_id: tabId, ref: freshSave });
      assert.equal(await script(owner, 'document.querySelector("#count").textContent'), 'Saved 1');
      const verified = await call(owner, 'observe', { tab_id: tabId });
      assert(verified.nodes.some(node => node.name === 'Saved 1'), 'fresh AX observation verifies outcome');
      await call(owner, 'click_ref', { tab_id: tabId, ref: verified.nodes.find(node => node.name === 'Shadow Save').ref });
      assert.equal(await script(owner, 'document.querySelector("#host").shadowRoot.querySelector("button").textContent'), 'Shadow Saved');
      if (evidenceDir) await screenshot(owner, join(evidenceDir, 'b4-after.png'));

      const otherTab = (await call(foreign, 'navigate', { url: pageUrl })).tab_id;
      const crossRef = (await call(owner, 'observe', { tab_id: tabId })).nodes.find(node => node.name === 'Save')?.ref;
      await assert.rejects(call(foreign, 'click_ref', { tab_id: otherTab, ref: crossRef }), /session|stale/i);
      assert.equal(await script(owner, 'document.querySelector("#count").textContent'), 'Saved 1');

      await script(owner, `(() => { document.querySelector('#save').style.marginLeft='200px'; return true; })()`);
      await call(owner, 'click_ref', { tab_id: tabId, ref: crossRef });
      assert.equal(await script(owner, 'document.querySelector("#count").textContent'), 'Saved 2', 'click uses fresh geometry');
      const overlayRef = (await call(owner, 'observe', { tab_id: tabId })).nodes.find(node => node.name === 'Save')?.ref;
      await script(owner, `(() => { const o=document.createElement('div');o.id='overlay';o.style='position:fixed;inset:0;z-index:9999';document.body.append(o);return true; })()`);
      await assert.rejects(call(owner, 'click_ref', { tab_id: tabId, ref: overlayRef }), /obscured|covered/i);
      assert.equal(await script(owner, 'document.querySelector("#count").textContent'), 'Saved 2');
      await script(owner, `(() => { document.querySelector('#overlay').remove();return true; })()`);

      const staleRef = (await call(owner, 'observe', { tab_id: tabId })).nodes.find(node => node.name === 'Save')?.ref;
      await call(owner, 'navigate', { tab_id: tabId, url: pageUrl });
      await assert.rejects(call(owner, 'click_ref', { tab_id: tabId, ref: staleRef }), /stale/i);
      assert.equal(await script(owner, 'document.querySelector("#count").textContent'), 'Not saved');
    } catch (error) {
      console.error('Chrome diagnostic tail', chromeLog.slice(-2000));
      throw error;
    } finally {
      cdp?.close();
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => chrome.once('exit', resolve)),
        new Promise(resolve => setTimeout(() => { if (chrome.exitCode === null) chrome.kill('SIGKILL'); resolve(); }, 3000)),
      ]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
