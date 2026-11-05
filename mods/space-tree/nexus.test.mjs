import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, host, element } from './host.test.mjs';
import * as model from './hub-model.js';
import { buildTree, assignSectionColors, machineId, rowId } from './model.js';

function setup(existing) {
  const h = existing ?? host(); h.overlays = [];
  const deps = { ...h.deps, ...model, spaces: () => [], panes: () => [], terminals: () => [], machines: () => [],
    focused: () => ({}), layout: () => ({}), nextCommand: () => new Promise(resolve => { h.command = resolve; }),
    exec: async () => ({ code: 0, stdout: '{"runs":[],"terminals":[]}' }),
    openOverlay: spec => { h.overlays.push(['open', spec]); return 'ov1'; },
    closeOverlay: id => { h.overlays.push(['close', id]); return null; },
  };
  const Hub = class { init() {} close() {} snapshots = new Map(); sync() {} hide() {} toggle() {} };
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', { ...deps, Hub,
    Plumbing: class { init() {} }, initRename() {}, props: () => ({}), localStorage: { getItem() { return null; } },
    v_flex: element, svg: element, buildTree, assignSectionColors, machineId, rowId, nexusRow() {}, treeRow() {}, hubRow() {},
    mergeHuds: () => ({ runs: [], terminals: [] }) });
  h.tree = new Tree(); h.tree.init({}, h.cx);
  return h;
}

const ensure = reply => ({ exec: async (_c, args) => { ensure.args = args; return { code: 0, stdout: JSON.stringify(typeof reply === 'function' ? await reply() : reply) }; } });
const settle = () => new Promise(resolve => setImmediate(resolve));

function setupVoice(reply, existing) {
  const h = existing ?? host(); h.overlays = [];
  const deps = { ...h.deps, ...model, spaces: () => [], panes: () => [], terminals: () => [], machines: () => [],
    focused: () => ({}), layout: () => ({}), nextCommand: () => new Promise(resolve => { h.command = resolve; }), ...ensure(reply),
    openOverlay: spec => { h.overlays.push(['open', spec]); return 'ov1'; },
    closeOverlay: id => { h.overlays.push(['close', id]); return null; } };
  const Hub = class { init() {} close() {} snapshots = new Map(); sync() {} hide() {} toggle() {} };
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', { ...deps, Hub,
    Plumbing: class { init() {} }, initRename() {}, props: () => ({}), localStorage: { getItem() { return null; } },
    v_flex: element, svg: element, buildTree, assignSectionColors, machineId, rowId, nexusRow() {}, treeRow() {}, hubRow() {},
    mergeHuds: () => ({ runs: [], terminals: [] }) });
  h.tree = new Tree(); h.tree.init({}, h.cx);
  return h;
}

test('claude mode opens a layout dialog with the header mod and the voice terminal, then focuses it', async () => {
  const h = setupVoice({ mode: 'claude', terminal: 't9' });
  h.tree.toggleNexus(false); await settle();
  assert.deepEqual(ensure.args.slice(-3), ['nexus', 'voice', 'ensure']);
  assert.deepEqual(h.overlays[0], ['open', { kind: 'dialog', width: 640, height: 300, layout: { type: 'column', children: [
    { type: 'block', size: { px: 26 }, content: { mod: 'nexus', props: { header: true } } },
    { type: 'block', content: { terminal: 't9' } }] } }]);
  assert.deepEqual(h.calls.filter(c => c.run).map(c => c.run), [['pane.focus', { terminal: 't9' }]]);
});

test('either nexus command closes the open dialog without running ensure again', async () => {
  const h = setupVoice({ mode: 'claude', terminal: 't9' });
  h.tree.toggleNexus(false); await settle();
  h.shared.set('nexus.open', true); ensure.args = null;
  h.tree.toggleNexus(true);
  assert.deepEqual(h.overlays[1], ['close', 'ov1']);
  assert.equal(ensure.args, null);
  assert.equal(h.shared.get('nexus.listenToggle'), undefined);
});

test('a second press while ensure is pending opens only one dialog', async () => {
  const h = setupVoice({ mode: 'claude', terminal: 't9' });
  h.tree.toggleNexus(false); h.tree.toggleNexus(false); await settle();
  assert.equal(h.overlays.filter(o => o[0] === 'open').length, 1);
});

test('a close() before ensure resolves opens no dialog and takes no focus', async () => {
  const h = setupVoice({ mode: 'claude', terminal: 't9' });
  h.tree.toggleNexus(false); h.tree.close(); await settle();
  assert.equal(h.overlays.length, 0);
  assert.deepEqual(h.calls.filter(c => c.run || c.notify), []);
});

test('a newer toggle supersedes an older pending ensure', async () => {
  const gates = [];
  const h = setupVoice(() => new Promise(resolve => gates.push(resolve)));
  const base = gates.length;
  h.tree.toggleNexus(false); h.tree.toggleNexus(false); await settle();
  gates[base + 1]({ mode: 'claude', terminal: 't2' }); await settle();
  gates[base]({ mode: 'claude', terminal: 't1' }); await settle();
  const opened = h.overlays.filter(o => o[0] === 'open');
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0][1].layout.children[1].content, { terminal: 't2' });
  assert.deepEqual(h.calls.filter(c => c.run).map(c => c.run), [['pane.focus', { terminal: 't2' }]]);
});

test('apple mode keeps the old bar and passes the listen flag', async () => {
  const h = setupVoice({ mode: 'apple' });
  h.tree.toggleNexus(true); await settle();
  assert.deepEqual(h.overlays[0], ['open', { mod: 'nexus', kind: 'dialog', width: 560, height: 150, props: { listen: true } }]);
});

test('ensure errors notify instead of opening a dialog, and a later press retries', async () => {
  const h = setupVoice({ action: 'error', error: 'claude를 찾지 못했습니다' });
  h.tree.toggleNexus(false); await settle();
  assert.equal(h.overlays.length, 0);
  assert.deepEqual(h.calls.find(c => c.notify).notify, { title: 'Nexus', body: 'claude를 찾지 못했습니다', level: 'error' });
  h.tree.toggleNexus(false); await settle();
  assert.equal(h.calls.filter(c => c.notify).length, 2);
});

test('init clears a stale nexus.open flag', () => {
  const h = host({ 'nexus.open': true });
  assert.equal(h.shared.get('nexus.open'), true);
  const s = setup(h);
  assert.equal(s.shared.get('nexus.open'), false);
});

test('selecting the nexus row toggles the dialog instead of the hub', () => {
  const h = setupVoice({ mode: 'claude', terminal: 't9' }); let hubOpened = false; h.tree.hub.open = () => { hubOpened = true; };
  h.tree.select({ nexus: true, hub: true, key: 'nexus-entry' }, h.cx);
  assert.equal(ensure.args.at(-1), 'ensure'); assert.equal(hubOpened, false);
});

test('main.js wires commands and live keys', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /command === "nexus"\) this\.toggleNexus\(false\)/);
  assert.match(main, /command === "nexus-listen"\) this\.toggleNexus\(true\)/);
  assert.match(main, /return \["hub-entry", "nexus-entry"/);
});
