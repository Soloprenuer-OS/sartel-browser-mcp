import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../../mcp-server/tools.js';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const caseStart = source.indexOf("case 'start_network_capture': {");
const caseEnd = source.indexOf("case 'fetch': {", caseStart);

function fixture({ getBody, sendCommand } = {}) {
  assert(caseStart >= 0 && caseEnd > caseStart, 'network capture dispatcher cases exist');
  const helperStart = source.indexOf('// ── Network Capture Lease');
  const helperEnd = source.indexOf('// ── Command Dispatcher', helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, 'network capture lease exists');
  const listeners = new Set();
  const commands = [];
  const chrome = { debugger: { onEvent: {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
  } } };
  const make = new Function('chrome', 'getSessionTab', 'cdpSend', 'debuggerAttach', 'debuggerDetach',
    `${source.slice(helperStart, helperEnd)};
     return {
       run: async (method, port, params) => { switch (method) { ${source.slice(caseStart, caseEnd)} } },
       release: cancelNetworkCapturesForPort,
       tabClose: cancelNetworkCapturesForTab,
       listeners: () => [...chrome.debugger.onEventListeners],
     };`);
  chrome.debugger.onEventListeners = listeners;
  const api = make(chrome,
    async (port, _activate, requestedTabId) => {
      const tabId = port === 1 ? 10 : 20;
      if (requestedTabId !== undefined && requestedTabId !== tabId) throw Error('Foreign tab');
      return { id: tabId, url: 'https://example.com/' };
    },
    async (_tabId, method, params) => {
      commands.push({ method, params });
      if (sendCommand) return await sendCommand(method, params);
      if (method === 'Network.getResponseBody') return getBody ? await getBody() : { body: '{"saved":true}', base64Encoded: false };
      return {};
    },
    async () => {},
    async () => {});
  return {
    ...api, commands,
    fire: (tabId, method, eventParams) => {
      for (const listener of [...listeners]) listener({ tabId }, method, eventParams);
    },
  };
}

test('a completed POST remains readable after the serial trigger with method, status and body', async () => {
  const f = fixture();
  const armed = await f.run('start_network_capture', 1, { tab_id: 10, timeout: 1000 });
  assert.equal(armed.ok, true);
  f.fire(10, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.com/api/save', method: 'POST' } });
  f.fire(10, 'Network.responseReceived', { requestId: 'r1', response: { url: 'https://example.com/api/save', status: 201 } });
  f.fire(10, 'Network.loadingFinished', { requestId: 'r1' });
  await new Promise(resolve => setTimeout(resolve, 0));

  const read = await f.run('read_network', 1, { tab_id: 10, cursor: armed.cursor });
  assert.deepEqual(read.records.map(({ method, status, body }) => ({ method, status, body })),
    [{ method: 'POST', status: 201, body: '{"saved":true}' }]);
  assert.equal(read.expired, false);
  assert.equal(f.commands.some(command => command.method === 'Network.disable'), false);
  await f.run('stop_network_capture', 1, { tab_id: 10 });
  assert.equal(f.commands.some(command => command.method === 'Network.disable'), true);
});

test('the MCP contract exposes network capture and read tools', () => {
  assert(TOOLS.some(tool => tool.name === 'browser_start_network_capture'));
  assert(TOOLS.some(tool => tool.name === 'browser_read_network'));
  assert(TOOLS.some(tool => tool.name === 'browser_stop_network_capture'));
});

test('redirects retain each hop and a cursor reports evicted records', async () => {
  const f = fixture();
  await f.run('start_network_capture', 1, { timeout: 1000 });
  f.fire(10, 'Network.requestWillBeSent', { requestId: 'redirect', request: { url: 'https://example.com/old', method: 'POST' } });
  f.fire(10, 'Network.requestWillBeSent', { requestId: 'redirect', redirectResponse: { url: 'https://example.com/old', status: 307 }, request: { url: 'https://example.com/new', method: 'POST' } });
  f.fire(10, 'Network.responseReceived', { requestId: 'redirect', response: { url: 'https://example.com/new', status: 200 } });
  f.fire(10, 'Network.loadingFinished', { requestId: 'redirect' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const redirect = await f.run('read_network', 1, { cursor: 0 });
  assert.deepEqual(redirect.records.map(({ url, method, status, completion }) => ({ url, method, status, completion })), [
    { url: 'https://example.com/old', method: 'POST', status: 307, completion: 'redirect' },
    { url: 'https://example.com/new', method: 'POST', status: 200, completion: 'finished' },
  ]);

  for (let i = 0; i < 101; i++) {
    const id = `r${i}`;
    f.fire(10, 'Network.requestWillBeSent', { requestId: id, request: { url: `https://example.com/${i}`, method: 'GET' } });
    f.fire(10, 'Network.loadingFailed', { requestId: id, errorText: 'cancelled' });
  }
  const bounded = await f.run('read_network', 1, { cursor: 0 });
  assert.equal(bounded.records.length, 25);
  assert.equal(bounded.expired, true);
  assert.equal(bounded.records.at(-1).url, 'https://example.com/100');
  await f.run('stop_network_capture', 1, {});
});

test('pending metadata stays bounded and a later response is marked partial', async () => {
  const f = fixture();
  await f.run('start_network_capture', 1, { timeout: 1000 });
  for (let i = 0; i < 101; i++) {
    f.fire(10, 'Network.requestWillBeSent', { requestId: `hang${i}`, request: { url: `https://example.com/${i}`, method: 'POST' } });
  }
  const before = await f.run('read_network', 1, {});
  assert.equal(before.pending, 100);
  assert.equal(before.evicted_pending, 1);
  f.fire(10, 'Network.responseReceived', { requestId: 'hang0', response: { url: 'https://example.com/0', status: 202 } });
  f.fire(10, 'Network.loadingFinished', { requestId: 'hang0' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const after = await f.run('read_network', 1, {});
  assert.equal(after.records[0].partial, true);
  assert.equal(after.records[0].method, null);
  await f.run('stop_network_capture', 1, {});
});

test('legacy waiter and retained capture share Network.enable until both release', async () => {
  const f = fixture();
  await f.run('start_network_capture', 1, { timeout: 1000 });
  const waiter = f.run('wait_for_network', 1, { url_pattern: '/api/', timeout: 100 });
  await new Promise(resolve => setTimeout(resolve, 0));
  f.fire(10, 'Network.responseReceived', { requestId: 'wait', response: { url: 'https://example.com/api/test', status: 200 } });
  await waiter;
  assert.equal(f.commands.filter(command => command.method === 'Network.disable').length, 0);
  await f.run('stop_network_capture', 1, {});
  assert.equal(f.commands.filter(command => command.method === 'Network.disable').length, 1);
});

test('capture ignores foreign tab traffic and releases on timeout', async () => {
  const f = fixture();
  await f.run('start_network_capture', 1, { timeout: 15 });
  f.fire(20, 'Network.requestWillBeSent', { requestId: 'foreign', request: { url: 'https://elsewhere.test/', method: 'GET' } });
  f.fire(20, 'Network.loadingFailed', { requestId: 'foreign' });
  assert.deepEqual((await f.run('read_network', 1, {})).records, []);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.listeners().length, 0);
  assert.equal((await f.run('read_network', 1, {})).ok, false);
});

test('a read distinguishes body retrieval still in progress from no matching traffic', async () => {
  let completeBody;
  const f = fixture({ getBody: () => new Promise(resolve => { completeBody = resolve; }) });
  await f.run('start_network_capture', 1, { timeout: 1000 });
  f.fire(10, 'Network.requestWillBeSent', { requestId: 'slow', request: { url: 'https://example.com/slow', method: 'POST' } });
  f.fire(10, 'Network.responseReceived', { requestId: 'slow', response: { url: 'https://example.com/slow', status: 200 } });
  f.fire(10, 'Network.loadingFinished', { requestId: 'slow' });
  const before = await f.run('read_network', 1, {});
  assert.equal(before.processing, 1);
  assert.deepEqual(before.records, []);
  completeBody({ body: 'ready', base64Encoded: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  const after = await f.run('read_network', 1, {});
  assert.equal(after.processing, 0);
  assert.equal(after.records[0].body, 'ready');
  await f.run('stop_network_capture', 1, {});
});

test('simultaneous body reads are capped and skipped bodies are explicit', async () => {
  const f = fixture({ getBody: () => new Promise(() => {}) });
  await f.run('start_network_capture', 1, { timeout: 1000 });
  for (let i = 0; i < 26; i++) {
    const requestId = `body${i}`;
    f.fire(10, 'Network.requestWillBeSent', { requestId, request: { url: `https://example.com/${i}`, method: 'GET' } });
    f.fire(10, 'Network.loadingFinished', { requestId });
  }
  const read = await f.run('read_network', 1, {});
  assert.equal(read.processing, 25);
  assert.equal(f.commands.filter(command => command.method === 'Network.getResponseBody').length, 25);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].body_skipped_budget, true);
  await f.run('stop_network_capture', 1, {});
});

test('stop and immediate re-arm cannot leave Network disabled after a delayed release', async () => {
  let finishDisable;
  const f = fixture({ sendCommand: method => method === 'Network.disable'
    ? new Promise(resolve => { finishDisable = resolve; }) : {} });
  await f.run('start_network_capture', 1, { timeout: 1000 });
  const stopping = f.run('stop_network_capture', 1, {});
  await new Promise(resolve => setTimeout(resolve, 0));
  const restarting = f.run('start_network_capture', 1, { timeout: 1000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.commands.filter(command => command.method === 'Network.enable').length, 1);
  finishDisable({});
  await stopping;
  await restarting;
  assert.deepEqual(f.commands.map(command => command.method),
    ['Network.enable', 'Network.disable', 'Network.enable']);
  f.tabClose(10, false);
});

test('concurrent starts cannot replace the same session capture or leak a listener', async () => {
  let finishEnable;
  const enabled = new Promise(resolve => { finishEnable = resolve; });
  const f = fixture({ sendCommand: method => method === 'Network.enable' ? enabled : {} });
  const first = f.run('start_network_capture', 1, { timeout: 1000 });
  const second = f.run('start_network_capture', 1, { timeout: 1000 });
  finishEnable({});
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(result => result.ok).sort(), [false, true]);
  assert.equal(f.listeners().length, 1);
  await f.run('stop_network_capture', 1, {});
});
