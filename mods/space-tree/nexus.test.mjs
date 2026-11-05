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

test('nexus command opens a dialog overlay and a second one closes it while open', () => {
  const h = setup();
  h.tree.toggleNexus(false);
  assert.deepEqual(h.overlays[0], ['open', { mod: 'nexus', kind: 'dialog', width: 560, height: 120, props: { listen: false } }]);
  h.shared.set('nexus.open', true);
  h.tree.toggleNexus(false);
  assert.deepEqual(h.overlays[1], ['close', 'ov1']);
  h.shared.set('nexus.open', false);
  h.tree.toggleNexus(true);
  assert.equal(h.overlays[2][1].props.listen, true);
});

test('nexus-listen while open keeps the dialog and bumps nexus.listenToggle', () => {
  const h = setup();
  h.tree.toggleNexus(false);
  h.shared.set('nexus.open', true);
  h.tree.toggleNexus(true);
  assert.equal(h.overlays.length, 1);
  assert.equal(typeof h.shared.get('nexus.listenToggle'), 'number');
  const first = h.shared.get('nexus.listenToggle');
  const real = Date.now; Date.now = () => first + 5;
  try { h.tree.toggleNexus(true); } finally { Date.now = real; }
  assert.equal(h.shared.get('nexus.listenToggle'), first + 5);
});

test('init clears a stale nexus.open flag', () => {
  const h = host({ 'nexus.open': true });
  assert.equal(h.shared.get('nexus.open'), true);
  const s = setup(h);
  assert.equal(s.shared.get('nexus.open'), false);
});

test('selecting the nexus row toggles the dialog instead of the hub', () => {
  const h = setup(); let hubOpened = false; h.tree.hub.open = () => { hubOpened = true; };
  h.tree.select({ nexus: true, hub: true, key: 'nexus-entry' }, h.cx);
  assert.equal(h.overlays[0][0], 'open'); assert.equal(hubOpened, false);
});

test('main.js wires commands and live keys', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /command === "nexus"\) this\.toggleNexus\(false\)/);
  assert.match(main, /command === "nexus-listen"\) this\.toggleNexus\(true\)/);
  assert.match(main, /return \["hub-entry", "nexus-entry"/);
});
