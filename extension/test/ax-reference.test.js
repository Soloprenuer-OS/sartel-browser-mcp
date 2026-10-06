import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from '../../mcp-server/tools.js';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const start = source.indexOf('// ── AX Reference Actions');
const end = source.indexOf('// ── Command Dispatcher', start);

function fixture() {
  assert(start >= 0 && end > start, 'AX reference implementation is present');
  let documentId = 10;
  let blocked = false;
  let attached = true;
  let inputValue = '';
  let clickCount = 0;
  let nextRef = 0;
  const calls = [];
  const nodes = [
    { nodeId: 'ax1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 101 },
    { nodeId: 'ax2', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 102 },
    { nodeId: 'ax3', role: { value: 'button' }, name: { value: 'Shadow Save' }, backendDOMNodeId: 103 },
  ];
  const cdpSend = async (_tabId, method, params = {}) => {
    calls.push({ method, params });
    if (method === 'DOM.getDocument') return { root: { backendNodeId: documentId } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes };
    if (method === 'DOM.resolveNode') {
      if (!attached) throw Error('Could not find node');
      return { object: { objectId: `object-${params.backendNodeId}` } };
    }
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 50, 10, 50, 30, 10, 30] } };
    if (method === 'Runtime.callFunctionOn') {
      if (params.functionDeclaration.includes('elementFromPoint')) return { result: { value: { connected: attached, blocked, disabled: false } } };
      if (params.functionDeclaration.includes('return this.value')) return { result: { value: inputValue } };
      if (params.functionDeclaration.includes('editable:')) return { result: { value: { connected: attached, disabled: false, readOnly: false, editable: true } } };
      return { result: { value: true } };
    }
    if (method === 'DOM.focus') return {};
    if (method === 'Input.dispatchKeyEvent') {
      if (params.key === 'Backspace') inputValue = '';
      return {};
    }
    if (method === 'Input.insertText') { inputValue = params.text; return {}; }
    throw Error(`Unexpected CDP method ${method}`);
  };
  const debuggerClick = async () => { clickCount++; };
  const factory = new Function('cdpSend', 'debuggerClick', 'crypto', 'SELECT_ALL_MODS',
    `${source.slice(start, end)}; return { observeAx, clickAxRef, fillAxRef, clearAxRefsForPort, clearAxRefsForTab };`);
  const api = factory(cdpSend, debuggerClick, { randomUUID: () => `ref-${++nextRef}` }, 4);
  return {
    ...api, calls, nodes,
    tab: { id: 10, url: 'https://fixture.test/', title: 'Fixture' },
    navigate: () => { documentId++; },
    obscure: () => { blocked = true; },
    detach: () => { attached = false; },
    clickCount: () => clickCount,
    value: () => inputValue,
  };
}

test('AX tools expose observation, ref click and ref fill with explicit tab ownership', () => {
  for (const name of ['browser_observe', 'browser_click_ref', 'browser_fill_ref']) {
    const tool = TOOLS.find(entry => entry.name === name);
    assert(tool, `${name} is advertised`);
    assert.equal(tool.inputSchema.properties.tab_id.type, 'number');
  }
});

test('observed button ref clicks, and the next observation verifies the changed page', async () => {
  const f = fixture();
  const observed = await f.observeAx(1, f.tab);
  const button = observed.nodes.find(node => node.name === 'Save');
  assert(button?.ref);
  assert.equal(observed.tab_id, 10);
  assert.equal(observed.truncated, false);
  assert.equal((await f.clickAxRef(1, f.tab, button.ref)).ok, true);
  assert.equal(f.clickCount(), 1);
  assert((await f.observeAx(1, f.tab)).nodes.some(node => node.name === 'Save'));
});

test('a ref cannot cross sessions or survive navigation, detached node or overlay', async () => {
  const f = fixture();
  const ref = (await f.observeAx(1, f.tab)).nodes[0].ref;
  await assert.rejects(f.clickAxRef(2, f.tab, ref), /session|owner/i);
  assert.equal(f.clickCount(), 0);
  f.navigate();
  await assert.rejects(f.clickAxRef(1, f.tab, ref), /stale|document/i);
  const detached = (await f.observeAx(1, f.tab)).nodes[0].ref;
  f.detach();
  await assert.rejects(f.clickAxRef(1, f.tab, detached), /stale|detached/i);
  assert.equal(f.clickCount(), 0);
});

test('an obscured ref rejects before sending a click', async () => {
  const f = fixture();
  const ref = (await f.observeAx(1, f.tab)).nodes[0].ref;
  f.obscure();
  await assert.rejects(f.clickAxRef(1, f.tab, ref), /obscured|covered/i);
  assert.equal(f.clickCount(), 0);
});

test('observed textbox ref fills and verifies its value without a selector', async () => {
  const f = fixture();
  const ref = (await f.observeAx(1, f.tab)).nodes.find(node => node.role === 'textbox').ref;
  const result = await f.fillAxRef(1, f.tab, ref, 'Eden');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'Eden');
  assert.equal(f.value(), 'Eden');
  assert(f.calls.some(call => call.method === 'DOM.focus' && call.params.backendNodeId === 102));
});

test('a long run of static AX text does not hide later actionable controls', async () => {
  const f = fixture();
  f.nodes.splice(0, f.nodes.length);
  for (let i = 0; i < 85; i++) {
    f.nodes.push({ role: { value: 'StaticText' }, name: { value: `Paragraph ${i}` }, backendDOMNodeId: 1000 + i });
  }
  f.nodes.push({ role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 2000 });
  const observed = await f.observeAx(1, f.tab);
  assert(observed.truncated);
  assert.equal(observed.nodes.length, 17, 'static context stays bounded alongside the actionable result');
  assert.equal(observed.nodes[0].name, 'Paragraph 0', 'static context remains in document order');
  assert.equal(observed.nodes.at(-1).name, 'Continue', 'the later actionable node remains visible');
  assert(observed.nodes.at(-1).ref);
});
