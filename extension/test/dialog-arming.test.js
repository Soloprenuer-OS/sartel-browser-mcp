import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../../mcp-server/tools.js';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const caseStart = source.indexOf("case 'handle_dialog': {");
const caseEnd = source.indexOf("case 'wait_for_network': {", caseStart);
assert(caseStart >= 0 && caseEnd > caseStart);

function fixture({ sendCommand, waitForTab } = {}) {
  const listeners = new Set();
  const commands = [];
  const chrome = { debugger: { onEvent: {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
  } } };
  const helpersStart = source.indexOf('// ── JavaScript Dialog Lease');
  const helpersEnd = source.indexOf('// ── Command Dispatcher', helpersStart);
  const helpers = helpersStart >= 0 && helpersEnd > helpersStart ? source.slice(helpersStart, helpersEnd) : '';
  const body = source.slice(caseStart + "case 'handle_dialog': {".length, caseEnd).trim().replace(/}\s*$/, '');
  const make = new Function('chrome', 'getSessionTab', 'debuggerAttach', 'cdpSend', 'debuggerDetach',
    `${helpers}; return { run: async (port, params) => { ${body} },
      release: typeof cancelDialogsForPort === 'function' ? cancelDialogsForPort : () => {},
      detach: typeof cancelDialogForTab === 'function' ? id => cancelDialogForTab(id, false) : () => {},
      tabClose: typeof cancelDialogForTab === 'function' ? id => cancelDialogForTab(id) : () => {} };`);
  const { run, release, detach, tabClose } = make(chrome,
    async (port, _activate, requestedTabId) => {
      if (waitForTab) await waitForTab();
      const ownedId = port === 1 ? 10 : 20;
      if (requestedTabId !== undefined && requestedTabId !== ownedId) throw Error('Tab does not belong to this session');
      return { id: ownedId, url: 'https://example.com/' };
    },
    async () => {},
    async (_tabId, method, params) => { commands.push({ method, params }); if (sendCommand) return await sendCommand(method, params); },
    async () => {});
  return { run, release, detach, tabClose, commands, listenerCount: () => listeners.size,
    fire: (tabId, type, message) => { for (const listener of [...listeners]) listener({ tabId }, 'Page.javascriptDialogOpening', { type, message }); } };
}

test('dialog arming returns before the serial click and handles exactly one owned dialog', async () => {
  const f = fixture();
  const armed = await f.run(1, { action: 'dismiss', timeout: 40, tab_id: 10 });
  assert.equal(armed.armed, true);
  assert.equal(f.listenerCount(), 1);

  f.fire(20, 'alert', 'foreign');
  assert.equal(f.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').length, 0);
  f.fire(10, 'confirm', 'Delete?');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').map(command => command.params),
    [{ accept: false, promptText: '' }]);
  assert.equal(f.listenerCount(), 0);
});

test('MCP dialog contract exposes serial arm, status, and cancel modes', () => {
  const tool = TOOLS.find(tool => tool.name === 'browser_handle_dialog');
  assert.deepEqual(tool.inputSchema.properties.mode?.enum, ['arm', 'status', 'cancel']);
});

test('prompt result can be read once after the triggering action', async () => {
  const f = fixture();
  await f.run(1, { action: 'accept', text: 'yes', timeout: 100 });
  f.fire(10, 'prompt', 'Name?');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(await f.run(1, { mode: 'status' }),
    { ok: true, dialog_type: 'prompt', message: 'Name?', action: 'accept' });
  assert.deepEqual(await f.run(1, { mode: 'status' }),
    { ok: false, error: 'No dialog is armed for this session' });
  assert.deepEqual(f.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').map(command => command.params),
    [{ accept: true, promptText: 'yes' }]);
});

test('timeout, cancel, session release, and tab detach remove the dialog listener', async () => {
  const f = fixture();
  await f.run(1, { timeout: 15 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.listenerCount(), 0);
  assert.equal((await f.run(1, { mode: 'status' })).ok, false);

  await f.run(1, { timeout: 100 });
  assert.deepEqual(await f.run(1, { mode: 'cancel' }), { ok: true, cancelled: true });
  assert.equal(f.listenerCount(), 0);

  await f.run(1, { timeout: 100 });
  f.release(1);
  assert.equal(f.listenerCount(), 0);

  await f.run(1, { timeout: 100 });
  f.detach(10);
  assert.equal(f.listenerCount(), 0);
});

test('an arm cannot silently replace an outstanding arm', async () => {
  const f = fixture();
  await f.run(1, { timeout: 100 });
  const second = await f.run(1, { timeout: 100 });
  assert.equal(second.ok, false);
  assert.equal(f.listenerCount(), 1);
  f.release(1);
});

test('debugger detach after dialog opening does not erase the handled outcome', async () => {
  const f = fixture();
  await f.run(1, { timeout: 100 });
  f.fire(10, 'confirm', 'Navigate?');
  f.detach(10);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await f.run(1, { mode: 'status' }),
    { ok: true, dialog_type: 'confirm', message: 'Navigate?', action: 'accept' });
});

test('arm expiry cannot erase a dialog that already opened', async () => {
  const f = fixture();
  await f.run(1, { timeout: 10 });
  f.fire(10, 'confirm', 'Proceed?');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await f.run(1, { mode: 'status' }),
    { ok: true, dialog_type: 'confirm', message: 'Proceed?', action: 'accept' });
});

test('session release or tab close during Page.enable cannot install a dialog arm afterward', async () => {
  for (const teardown of ['release', 'tabClose']) {
    let finishEnable;
    const enabled = new Promise(resolve => { finishEnable = resolve; });
    const f = fixture({ sendCommand: method => method === 'Page.enable' ? enabled : {} });
    const starting = f.run(1, { timeout: 100 });
    await new Promise(resolve => setTimeout(resolve, 0));
    teardown === 'release' ? f.release(1) : f.tabClose(10);
    finishEnable({});
    const result = await starting;
    assert.equal(result.ok, false, teardown);
    assert.equal(f.listenerCount(), 0, teardown);
  }
});

test('session release during tab lookup cannot arm a dialog afterward', async () => {
  let finishLookup;
  const lookup = new Promise(resolve => { finishLookup = resolve; });
  const f = fixture({ waitForTab: () => lookup });
  const starting = f.run(1, { timeout: 100 });
  f.release(1);
  finishLookup();
  assert.equal((await starting).ok, false);
  assert.equal(f.listenerCount(), 0);
});
