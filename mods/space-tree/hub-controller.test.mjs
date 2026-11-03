import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, element, byId } from './host.test.mjs';
import * as model from './hub-model.js';
import { buildTree, assignSectionColors, tabIconColor, machineConnected, rowDisplay, machineId, rowId } from './model.js';

function setup({ existing = false } = {}) {
  const h = host();
  h.spaces = [{ id: 's', name: 'Repo', active: true, tabs: [{ id: 'tb', name: 'Head', index: 1 }] }];
  h.panes = [{ pane: 'p', tab: 'tb', terminal: 't1', status: 'working' }];
  h.terminals = [{ address: 't1', model: 'sol' }];
  h.hud = { runs: [], terminals: [{ address: 't1', model: 'sol' }] };
  h.addHub = () => {
    h.spaces.push({ id: 'h', name: 'hub', active: false, tabs: [{ id: 'ht', name: 'Mirrors', index: 1 }] });
    h.panes.push({ pane: 'seed-pane', tab: 'ht', terminal: 'seed' });
    h.terminals.push({ address: 'seed', argv: ['zsh'] });
  };
  if (existing) h.addHub();
  const deps = {
    ...h.deps, ...model, spaces: () => h.spaces, panes: () => h.panes, terminals: () => h.terminals,
    machines: () => [], nextCommand: () => new Promise(resolve => { h.command = resolve; }),
    exec: async () => ({ code: h.fail ? 1 : 0, stdout: JSON.stringify(h.hud) }),
    run: (command, args) => {
      h.calls.push({ run: [command, args] });
      if (command === 'space.select') for (const s of h.spaces) s.active = s.id === args.id;
    },
  };
  const Hub = load(new URL('./hub.js', import.meta.url), 'Hub', deps);
  const SpaceTree = load(new URL('./main.js', import.meta.url), 'SpaceTree', {
    ...deps, Hub, Plumbing: class { init() {} }, initRename() {}, props: () => ({}),
    localStorage: { getItem() { return null; } }, v_flex: element, svg: element,
    buildTree, assignSectionColors, machineId, rowId,
    treeRow: load(new URL('./rows.js', import.meta.url), 'treeRow', {
      ...h.deps, svg: element, image: element, nameElement: (_v, row) => row.name, tabIconColor, machineConnected, rowDisplay,
    }),
  });
  h.tree = new SpaceTree(); h.tree.init({}, h.cx);
  h.view = h.tree.hub;
  h.observer = (terminal = 'o1', target = 't1') => {
    const info = { address: terminal, labels: { 'hub.observer': target }, argv: ['hc', 'attach', '--observe', target] };
    h.terminals.push(info); h.hud.terminals.push(info);
    h.panes.push({ pane: `pane-${terminal}`, tab: 'ht', terminal });
  };
  return h;
}
const runs = h => h.calls.filter(c => c.run).map(c => c.run);
const launches = h => h.calls.filter(c => c.hc);

test('poll never creates a space; open creates lazily, waits for ids, moves first and selects hub', async () => {
  const h = setup(); await h.flush();
  assert.deepEqual(runs(h), []);
  h.view.open(h.cx); h.view.open(h.cx);
  assert.deepEqual(runs(h), [['space.new', { name: 'hub' }]]);
  h.addHub(); h.view.sync(h.cx); await h.flush();
  assert.deepEqual(runs(h), [['space.new', { name: 'hub' }], ['space.move', { id: 'h', index: 1 }], ['space.select', { id: 'h' }]]);
  assert.equal(h.shared.get('hub.space'), 'h');
  assert.deepEqual(launches(h)[0].hc, model.observerArgs('h', 'ht', 't1'));
  assert.equal(h.view.active(), true);
});
test('toggle returns to previous space; pinned click opens even when hub is already active', async () => {
  const h = setup({ existing: true }); await h.flush();
  h.view.toggle(h.cx); await h.flush(); assert.equal(h.view.active(), true);
  h.view.toggle(h.cx); assert.equal(h.spaces[0].active, true);
  h.command('hub'); await Promise.resolve(); assert.equal(h.view.active(), true);
  h.tree.select({ hub: true }, h.cx); assert.equal(h.view.active(), true);
  h.command('hub-close'); await Promise.resolve(); assert.equal(h.spaces[0].active, true);
});
test('reconciliation deduplicates in-flight adds and kills seed exactly once after a live observer exists', async () => {
  const h = setup({ existing: true }); await h.flush();
  h.view.sync(h.cx); h.view.sync(h.cx); await h.flush();
  assert.equal(launches(h).length, 1);
  assert.equal(runs(h).length, 0);
  h.observer(); h.view.sync(h.cx); h.view.sync(h.cx); await h.flush();
  assert.deepEqual(runs(h), [['terminal.kill', { terminal: 'seed' }]]);
  assert.deepEqual(h.shared.get('hub.heads').map(h => h.address), ['t1']);
  h.panes.push({ tab: 'ht', terminal: 'user-shell' }); h.view.sync(h.cx);
  assert.equal(runs(h).length, 1);
});
test('only observers inside the hub tab are removed when their head disappears', async () => {
  const h = setup({ existing: true }); h.observer('o1', 'gone');
  h.terminals.push({ address: 'outside', labels: { 'hub.observer': 'gone' } });
  h.panes.push({ tab: 'tb', terminal: 'outside' });
  await h.flush();
  assert.deepEqual(runs(h), [['terminal.kill', { terminal: 'o1' }]]);
});
test('failed helper poll retains heads and pauses destructive reconciliation', async () => {
  const h = setup({ existing: true }); await h.flush();
  h.fail = true; h.tree.refreshOrch(h.cx); await h.flush();
  h.observer('stale', 'unknown'); h.view.sync(h.cx);
  assert.equal(h.shared.get('hub.stale'), true);
  assert.equal(h.shared.get('hub.heads').length, 1);
  assert.deepEqual(runs(h), []);
});
test('observer core metadata excludes observers even when old HUD omits labels', async () => {
  const h = setup();
  h.panes.push({ tab: 'tb', terminal: 'observer' });
  h.terminals.push({ address: 'observer', argv: ['hc', 'attach', '--observe', 't1'] });
  h.hud.terminals.push({ address: 'observer' });
  await h.flush();
  assert.deepEqual(h.view.heads.map(h => h.address), ['t1']);
});
test('failed observer launch is retried without killing the shell', async () => {
  const h = setup({ existing: true }); await h.flush();
  h.view.pending.clear();
  // Inject a failure through the bound fake hc on a separate host.
  const failing = host(), deps = { ...failing.deps, ...model, spaces: () => h.spaces, panes: () => h.panes,
    terminals: () => h.terminals, hc: async () => { throw new Error('offline'); } };
  const Hub = load(new URL('./hub.js', import.meta.url), 'Hub', deps);
  const manager = new Hub(); manager.init({}, failing.cx);
  manager.snapshots.set(null, { data: h.hud }); failing.shared.set('hub.stale', false);
  manager.sync(failing.cx); await failing.flush();
  assert.equal(manager.pending.size, 0);
  assert.deepEqual(runs(failing), []);
});
test('regular tree navigation runs native space/tab/pane commands without layout operations', async () => {
  const h = setup(); await h.flush();
  for (const kind of ['space', 'tab', 'pane']) h.tree.select({ kind, id: 'target', key: 'k' }, h.cx);
  assert.deepEqual(runs(h), [['space.select', { id: 'target' }], ['tab.select', { id: 'target' }], ['pane.focus', { pane: 'target' }]]);
});
test('controller close stops future polling mutations', async () => {
  const h = setup(); await h.flush(); h.view.close(); h.addHub(); h.view.sync(h.cx); await h.flush();
  assert.equal(launches(h).length, 0);
});


test('first render places clickable hub row directly below This computer and uses space row geometry', async () => {
  const h = setup({ existing: true }); await h.flush();
  h.tree.inputs = () => ({ machines: [], spaces: h.spaces, panes: h.panes, orch: h.hud, hub: { id: 'h', heads: h.view.heads } });
  h.tree.machines = []; h.tree.reconnecting = {}; h.tree.rebuilt = () => false;
  const root = h.tree.render(), list = byId(root, 'tree-list');
  assert.equal(list.nodes[0].style.id, 'machine:');
  assert.equal(list.nodes[1].style.id, 'hub-entry');
  assert.equal(list.nodes[1].style.h, 26);
  assert.equal(list.nodes[1].style.pl, 14);
  list.nodes[1].handlers.click({}, h.cx);
  assert.equal(h.view.active(), true);
  list.nodes[1].handlers.click({}, h.cx);
  assert.equal(h.view.active(), true);
});
test('initial metadata loading cannot remove existing observers', async () => {
  const h = setup({ existing: true }); h.observer('existing', 'unknown');
  h.view.sync(h.cx);
  assert.deepEqual(runs(h), []);
  await h.flush();
  assert.deepEqual(runs(h), [['terminal.kill', { terminal: 'existing' }]]);
});
test('hub fold key is retained by pruning', async () => {
  const h = setup({ existing: true }); await h.flush();
  assert.ok(h.tree.liveKeys({ machines: [], spaces: [], panes: [] }).includes('hub-entry'));
});


test('seed removal survives a controller restart and preserves later hub shells', async () => {
  const h = setup({ existing: true }); h.observer(); await h.flush();
  assert.deepEqual(h.shared.get('hub.seedRemoved'), ['h']);
  h.calls.length = 0;
  const Hub = load(new URL('./hub.js', import.meta.url), 'Hub', { ...h.deps, ...model,
    spaces: () => h.spaces, panes: () => h.panes, terminals: () => h.terminals });
  const restarted = new Hub(); restarted.init({}, h.cx);
  restarted.snapshots.set(null, { data: h.hud });
  h.shared.set('hub.stale', false); restarted.sync(h.cx); await h.flush();
  assert.deepEqual(runs(h), []);
});
