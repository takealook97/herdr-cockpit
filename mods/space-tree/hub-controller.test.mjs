import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, host, element } from './host.test.mjs';
import * as model from './hub-model.js';
import { buildTree, assignSectionColors, machineId, rowId } from './model.js';
const layout = JSON.parse(readFileSync(new URL('../../layouts/cockpit.json', import.meta.url)));
function setup() {
  const h = host();
  h.spaces = [{ id: 's', name: 'Work', active: true, tabs: [{ id: 'tb', name: 'Head' }] }];
  h.panes = [{ pane: 'p', tab: 'tb', terminal: 't1', status: 'working' }];
  h.terminals = [{ address: 't1' }]; h.hud = { runs: [], terminals: [{ address: 't1' }] };
  h.focus = 't1'; h.writes = [];
  const deps = { ...h.deps, ...model, focused: () => ({ terminal: h.focus }),
    layout: () => layout, spaces: () => h.spaces, panes: () => h.panes, terminals: () => h.terminals,
    machines: () => [], nextCommand: () => new Promise(resolve => { h.command = resolve; }),
    exec: async (command, args) => {
      if (command === '/bin/bash') {
        h.writes.push(JSON.parse(args.at(-1)).layout);
        if (h.waitWrite) await h.waitWrite;
        return { code: h.failWrite ? 1 : 0, stderr: 'failed' };
      }
      if (h.failPoll) throw new Error('offline');
      return { code: 0, stdout: JSON.stringify(h.hud) };
    },
  };
  const Hub = load(new URL('./hub.js', import.meta.url), 'Hub', deps);
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', { ...deps, Hub,
    Plumbing: class { init() {} }, initRename() {}, props: () => ({}),
    localStorage: { getItem() { return null; } }, v_flex: element, svg: element,
    buildTree, assignSectionColors, machineId, rowId,
  });
  h.tree = new Tree(); h.tree.init({}, h.cx); h.view = h.tree.hub;
  return h;
}
const runs = h => h.calls.filter(c => c.run).map(c => c.run);
const terminals = node => node.content?.terminal ? [node.content.terminal] : (node.children ?? []).flatMap(terminals);
test('polling only discovers heads; open writes CLI grid and selects it; hide restores tabs', async () => {
  const h = setup(); await h.flush();
  assert.deepEqual(runs(h), []); assert.equal(h.writes.length, 0);
  h.view.open(h.cx, 't1'); await h.flush();
  assert.equal(h.view.active(), true);
  assert.equal(model.findNode(h.writes[0], 'work-stack').active, 'hub-view');
  assert.deepEqual(terminals(model.findNode(h.writes[0], 'hub-grid')), ['t1']);
  assert.deepEqual(runs(h), [['layout.select', { stack: 'work-stack', child: 'hub-view' }], ['layout.hide', { id: 'tabs' }], ['pane.focus', { terminal: 't1' }]]);
  h.view.hide(h.cx); await h.flush();
  assert.equal(h.view.active(), false);
  assert.equal(model.findNode(h.writes.at(-1), 'work-stack').active, 'work-normal');
  assert.deepEqual(runs(h).at(-1), ['layout.show', { id: 'tabs' }]);
  assert.ok(!runs(h).some(([cmd]) => /space.new|terminal.kill/.test(cmd)));
});
test('rapid open/hide serializes writes and never selects an outdated hub view', async () => {
  const h = setup(); await h.flush(); let release;
  h.waitWrite = new Promise(r => { release = r; });
  h.view.open(h.cx); h.view.hide(h.cx); release(); await h.flush();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(runs(h), [['layout.select', { stack: 'work-stack', child: 'work-normal' }], ['layout.show', { id: 'tabs' }]]);
});
test('head set rebuild is debounced 500ms and status-only changes do not rewrite layout', async () => {
  const h = setup(); await h.flush(); h.view.open(h.cx); await h.flush();
  h.panes[0].status = 'blocked'; h.view.sync(h.cx); h.tick(500); await h.flush();
  assert.equal(h.writes.length, 1);
  h.panes.push({ pane: 'p2', tab: 'tb', terminal: 't2' }); h.hud.terminals.push({ address: 't2' });
  h.tree.refreshOrch(h.cx); await h.flush(); h.view.sync(h.cx);
  assert.equal(h.writes.length, 1); h.tick(500); await h.flush();
  assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), ['t1', 't2']);
});
test('shortcuts pass through while closed and navigate/zoom using focused terminal in hub', async () => {
  const h = setup(); await h.flush(); h.view.go('left'); h.view.zoom(h.cx);
  assert.deepEqual(runs(h), [['pane.go', { direction: 'left' }], ['pane.zoom']]);
  h.view.open(h.cx); await h.flush(); h.calls.length = 0;
  h.view.heads = [{ address: 't1' }, { address: 't2' }, { address: 't3' }, { address: 't4' }];
  h.view.go('down'); assert.deepEqual(runs(h)[0], ['pane.focus', { terminal: 't3' }]);
  h.view.zoom(h.cx); await h.flush(); assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), ['t1']);
  h.view.zoom(h.cx); await h.flush(); assert.equal(terminals(model.findNode(h.writes.at(-1), 'hub-grid')).length, 4);
});
test('failed polls retain discovered heads; core metadata excludes legacy observers', async () => {
  const h = setup(); h.panes.push({ tab: 'tb', terminal: 'o1' });
  h.hud.terminals.push({ address: 'o1' }); h.terminals.push({ address: 'o1', labels: { 'hub.observer': 't1' } });
  await h.flush(); assert.deepEqual(h.view.heads.map(h => h.address), ['t1']);
  h.failPoll = true; h.tree.refreshOrch(h.cx); await h.flush();
  assert.deepEqual(h.view.heads.map(h => h.address), ['t1']);
});
test('tree head click opens and focuses; ordinary rows hide hub and preserve native commands', async () => {
  const h = setup(); await h.flush(); h.tree.select({ hub: true, terminal: 't1' }, h.cx); await h.flush();
  assert.deepEqual(runs(h).at(-1), ['pane.focus', { terminal: 't1' }]);
  h.tree.select({ kind: 'tab', id: 'target', key: 'k' }, h.cx); await h.flush();
  assert.equal(h.view.active(), false);
  assert.ok(runs(h).some(([cmd, args]) => cmd === 'tab.select' && args.id === 'target'));
});
test('source button navigation runs after hub has been hidden', async () => {
  const h = setup(); await h.flush(); h.view.open(h.cx); await h.flush(); h.calls.length = 0;
  h.shared.set('hub.source', { address: 't1', space: 's', tab: 'tb' });
  h.view.source(h.cx); await h.flush();
  assert.deepEqual(runs(h).slice(-3), [['space.select', { id: 's' }], ['tab.select', { id: 'tb' }], ['pane.focus', { terminal: 't1' }]]);
  assert.equal(h.view.active(), false);
});
test('command loop handles hub shortcuts and exits on null; close prevents further writes', async () => {
  const h = setup(); await h.flush(); h.command('go-left'); await Promise.resolve();
  assert.deepEqual(runs(h).at(-1), ['pane.go', { direction: 'left' }]);
  h.command(null); await Promise.resolve(); h.view.close(); h.view.open(h.cx); await h.flush();
  assert.equal(h.writes.length, 0);
});
test('failed layout write reports error and can be retried', async () => {
  const h = setup(); await h.flush(); h.failWrite = true; h.view.open(h.cx); await h.flush();
  assert.ok(h.calls.some(c => c.notify?.body === 'failed')); assert.deepEqual(runs(h), []);
  h.failWrite = false; h.view.sync(h.cx); h.tick(500); await h.flush();
  assert.equal(runs(h)[0][0], 'layout.select');
});
