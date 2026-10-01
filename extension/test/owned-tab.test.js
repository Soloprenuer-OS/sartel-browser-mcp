import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../../mcp-server/tools.js';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const start = source.indexOf('async function getSessionTab(');
const end = source.indexOf('// ── Chrome Debugger API Helpers', start);
assert(start >= 0 && end > start);

function fixture() {
  const sessions = new Map([
    [1, { tabIds: new Set([10, 20]), activeTabId: 10 }],
    [2, { tabIds: new Set([30]), activeTabId: 30 }],
  ]);
  const tabs = new Map([
    [10, { id: 10, url: 'https://a.example', active: true }],
    [20, { id: 20, url: 'https://b.example', active: false }],
    [30, { id: 30, url: 'https://foreign.example', active: false }],
  ]);
  let created = 0;
  const chrome = {
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('tab closed'); return tabs.get(id); },
      create: async () => { created++; throw Error('must not create a tab'); },
      update: async id => tabs.get(id),
    },
    windows: { get: async () => null, update: async () => {} },
  };
  const getSessionTab = new Function('getSession', 'chrome', 'persistSessions', 'addTabToSession',
    `${source.slice(start, end)}; return getSessionTab;`)(port => sessions.get(port), chrome, () => {}, () => {});
  return { getSessionTab, sessions, tabs, created: () => created };
}

test('explicit owned tab overrides the session active tab', async () => {
  const f = fixture();
  assert.equal((await f.getSessionTab(1, false, 20)).id, 20);
  assert.equal((await f.getSessionTab(1)).id, 10, 'omitted target retains legacy active-tab behavior');
});

test('foreign and closed explicit tabs reject without falling back or creating a tab', async () => {
  const f = fixture();
  f.sessions.get(1).tabIds.add(99);
  await assert.rejects(f.getSessionTab(1, false, 30), /session|owned/i);
  await assert.rejects(f.getSessionTab(1, false, 99), /closed|missing|stale/i);
  assert.equal(f.created(), 0);
});

test('page action contracts expose an explicit tab target', () => {
  for (const name of ['browser_navigate', 'browser_get_page_content', 'browser_click', 'browser_fill', 'browser_screenshot']) {
    const tool = TOOLS.find(t => t.name === name);
    assert.equal(tool.inputSchema.properties.tab_id?.type, 'number', name);
    assert(!tool.inputSchema.required?.includes('tab_id'), name);
  }
});

test('page content runs against the explicit owned tab rather than the last active tab', async () => {
  const f = fixture();
  const caseStart = source.indexOf("case 'get_page_content': {");
  const caseEnd = source.indexOf("case 'screenshot': {", caseStart);
  assert(caseStart >= 0 && caseEnd > caseStart);
  const body = source.slice(caseStart + "case 'get_page_content': {".length, caseEnd).trim().replace(/}\s*$/, '');
  const runCase = new (Object.getPrototypeOf(async function () {}).constructor)(
    'port', 'params', 'getSessionTab', 'safeExecuteScript', 'debuggerEval', body,
  );
  const result = await runCase(1, { tab_id: 20 }, f.getSessionTab,
    async id => ({ cspBlocked: false, result: `page ${id}` }), async () => 'fallback');
  assert.equal(result.url, 'https://b.example');
  assert.equal(result.content, 'page 20');
});

test('get_new_tab cannot claim another session tab and can claim an owned popup', async () => {
  const f = fixture();
  const caseStart = source.indexOf("case 'get_new_tab': {");
  const caseEnd = source.indexOf("case 'switch_tab': {", caseStart);
  assert(caseStart >= 0 && caseEnd > caseStart);
  const body = source.slice(caseStart + "case 'get_new_tab': {".length, caseEnd).trim().replace(/}\s*$/, '');
  const runCase = new (Object.getPrototypeOf(async function () {}).constructor)(
    'port', 'lastCreatedTabId', 'getSession', 'chrome', 'addTabToSession', body,
  );
  const addTab = async (port, id) => f.sessions.get(port).tabIds.add(id);
  const chrome = {
    tabs: { get: async id => {
      if (id === 30) return { id: 30, url: 'https://foreign.example', openerTabId: 31 };
      if (id === 40) return { id: 40, url: 'https://popup.example', openerTabId: 10 };
      throw Error('missing');
    } },
  };
  const getSession = port => f.sessions.get(port);
  const foreign = await runCase(1, 30, getSession, chrome, addTab);
  assert.match(foreign.error, /session|owned|new tab/i);
  assert(!f.sessions.get(1).tabIds.has(30));

  const owned = await runCase(1, 40, getSession, chrome, addTab);
  assert.equal(owned.id, 40);
  assert(f.sessions.get(1).tabIds.has(40));
});
