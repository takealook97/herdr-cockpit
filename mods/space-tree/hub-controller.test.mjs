import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, host, element } from './host.test.mjs';
import * as model from './hub-model.js';
import { beginTabDrag, hoverTabTarget, dropTab } from './drag.js';
import { buildTree, paneSub, orchIndexes, assignSectionColors, machineId, rowId } from './model.js';
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

test('render debounces focus writes, cancels superseded focus, and retains ring outside hub', async () => {
  const h = setup(); await h.flush();
  h.panes.push({ pane: 'p2', tab: 'tb', terminal: 't2' }, { pane: 'p3', tab: 'tb', terminal: 't3' });
  h.hud.terminals.push({ address: 't2' }, { address: 't3' });
  h.tree.refreshOrch(h.cx); await h.flush();
  h.view.open(h.cx, 't1'); await h.flush();
  const count = h.writes.length;
  h.focus = 't2'; h.view.render(); h.view.render();
  h.focus = 't3'; h.view.render();
  assert.equal(h.writes.length, count);
  assert.equal(h.timers.filter(t => t.ms === 30 && !t.canceled).length, 1);
  h.tick(30); await h.flush();
  assert.equal(h.writes.length, count + 1);
  assert.equal(model.findNode(h.writes.at(-1), 'hub-cell-t3').border.color, 'accent');
  assert.equal(model.findNode(h.writes.at(-1), 'hub-cell-t1').border.color, 'border');
  h.focus = 'outside'; h.view.render(); h.tick(30); await h.flush();
  assert.equal(h.writes.length, count + 1);
  h.focus = 't2'; h.view.render(); h.focus = 't3'; h.view.render();
  h.tick(30); await h.flush(); assert.equal(h.writes.length, count + 1);
  h.focus = 't2'; h.view.render(); h.view.hide(h.cx); await h.flush();
  const hidden = h.writes.length; h.tick(30); await h.flush(); assert.equal(h.writes.length, hidden);
});

test('hub includes all local spaces and tabs regardless of selection and excludes remote heads', async () => {
  const h = setup(); await h.flush();
  h.spaces = [
    { id: 's', name: 'Local', active: true, tabs: [{ id: 'tb', name: 'One', active: true }, { id: 'tb2', name: 'Two', active: false }] },
    { id: 's2', name: 'Local 2', machine: null, active: false, tabs: [{ id: 'tb3', name: 'Three' }] },
    { id: 'remote/s', machine: 'remote', active: false, tabs: [{ id: 'remote/tb' }] },
    { id: 'remote/s2', machine: 'remote', active: false, tabs: [{ id: 'remote/tb2' }] },
  ];
  h.panes = [
    { tab: 'tb', terminal: 't1' }, { tab: 'tb2', terminal: 't2' }, { tab: 'tb3', terminal: 't3' },
    { tab: 'tb2', terminal: 'worker' }, { tab: 'tb2', terminal: 'observer' },
    { tab: 'remote/tb', terminal: 'remote/t1' }, { tab: 'remote/tb2', terminal: 'remote/t2' },
    { tab: 'tb3', terminal: 'remote/t1' },
  ];
  h.terminals.push({ address: 'observer', labels: { 'hub.observer': 't1' } });
  h.view.snapshots = new Map([
    ['local', { data: { terminals: ['t1', 't2', 't3', 'worker', 'observer'].map(address => ({ address })), runs: [{ workers: [{ terminal: 'worker' }] }] } }],
    ['remote', { machine: 'remote', data: { terminals: [{ address: 't1' }, { address: 't2' }], runs: [] } }],
  ]);
  const expected = ['t1', 't2', 't3'];
  h.view.open(h.cx, 'remote/t1'); await h.flush();
  assert.deepEqual(h.shared.get('hub.heads').map(x => x.address), expected);
  assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), expected);
  assert.ok(!runs(h).some(([cmd, args]) => cmd === 'pane.focus' && args.terminal === 'remote/t1'));
  h.spaces[0].active = false; h.spaces[2].active = true;
  h.view.sync(h.cx); h.tick(500); await h.flush();
  assert.deepEqual(h.shared.get('hub.heads').map(x => x.address), expected);
  h.spaces[2].active = false;
  h.view.snapshots.set('remote', { machine: 'remote', data: { terminals: [{ address: 't1' }, { address: 't2' }, { address: 't3' }], runs: [] } });
  h.view.sync(h.cx); h.tick(500); await h.flush();
  assert.deepEqual(h.shared.get('hub.heads').map(x => x.address), expected);
  assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), expected);
});

test('losing all local heads during a pending write cannot focus an old head and renders empty', async () => {
  const h = setup(); await h.flush(); let release;
  h.spaces.push({ id: 'remote/s', machine: 'remote', active: true, tabs: [{ id: 'remote/tb' }] });
  h.panes.push({ tab: 'remote/tb', terminal: 'remote/t1' });
  h.view.snapshots.set('remote', { machine: 'remote', data: { terminals: [{ address: 't1' }], runs: [] } });
  h.waitWrite = new Promise(r => { release = r; });
  h.view.open(h.cx, 't1');
  h.spaces = h.spaces.filter(space => space.machine != null); h.view.sync(h.cx);
  release(); await h.flush();
  assert.deepEqual(h.shared.get('hub.heads'), []);
  assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), []);
  assert.ok(model.findNode(h.writes.at(-1), 'hub-empty'));
  assert.ok(!runs(h).some(([cmd]) => cmd === 'pane.focus'));
  h.view.open(h.cx, 'remote/t1'); await h.flush();
  assert.ok(!runs(h).some(([cmd]) => cmd === 'pane.focus'));
});


test('native sibling drag order flows through sidebar, shared heads and Hub grid', async () => {
  const h = setup(); await h.flush();
  h.spaces = [
    { id: 's', name: 'Tools', active: true, tabs: ['lukuku-os', 'slack', 'herdr', 'orch'].map((id, i) => ({ id, name: id, index: i + 1 })) },
    { id: 's2', name: 'Other', tabs: [{ id: 'other', name: 'Other', index: 1 }] },
    { id: 'remote/s', machine: 'remote', tabs: [{ id: 'remote/tab', index: 1 }] },
  ];
  h.panes = [...h.spaces[0].tabs, ...h.spaces[1].tabs].map(t => ({ tab: t.id, terminal: `term-${t.id}` }));
  h.panes.push({ tab: 'remote/tab', terminal: 'remote/term' });
  h.view.snapshots = new Map([['local', { data: { terminals: h.panes.map(p => ({ address: p.terminal })), runs: [] } }]]);
  h.focus = 'term-herdr'; h.view.open(h.cx, h.focus); await h.flush();
  const calls = [], view = { orchStale: true }, api = {
    spaces: () => h.spaces, panes: () => h.panes, warn: message => assert.fail(message),
    run(command, args) {
      calls.push([command, args]); assert.equal(command, 'tab.move');
      const tabs = h.spaces[0].tabs, at = tabs.findIndex(t => t.id === args.id);
      const [moved] = tabs.splice(at, 1); tabs.splice(args.index - 1, 0, moved);
      tabs.forEach((t, i) => { t.index = i + 1; });
    },
  };
  const reorder = async (source, target, expected) => {
    const row = { kind: 'tab', id: target, space: 's', key: target };
    beginTabDrag(view, { id: source, space: 's' }, h.cx, api);
    hoverTabTarget(view, row, h.cx, api); assert.equal(view.tabOver, target);
    dropTab(view, row, h.cx, api); h.view.sync(h.cx); h.tick(500); await h.flush();
    const sidebar = buildTree({ spaces: h.spaces, panes: h.panes, hub: { heads: h.view.heads } });
    assert.deepEqual(sidebar.filter(r => r.kind === 'tab' && r.space === 's').map(r => r.id), expected);
    const addresses = [...expected.map(id => `term-${id}`), 'term-other'];
    assert.deepEqual(h.shared.get('hub.heads').map(head => head.address), addresses);
    assert.deepEqual(sidebar.filter(r => r.hub && r.kind === 'pane').map(r => r.terminal), addresses);
    assert.deepEqual(terminals(model.findNode(h.writes.at(-1), 'hub-grid')), h.view.zoomed ? ['term-herdr'] : addresses);
    assert.equal(h.view.focusedAddress, 'term-herdr');
  };
  await reorder('lukuku-os', 'orch', ['slack', 'herdr', 'orch', 'lukuku-os']);
  await reorder('lukuku-os', 'slack', ['lukuku-os', 'slack', 'herdr', 'orch']);
  h.view.zoom(h.cx); await h.flush();
  await reorder('slack', 'orch', ['lukuku-os', 'herdr', 'orch', 'slack']);
  assert.equal(h.view.zoomed, 'term-herdr');
  assert.deepEqual(calls.map(c => c[0]), ['tab.move', 'tab.move', 'tab.move']);
});

test('normal refresh updates idle model and effort and retains current values on fallback', async () => {
  const h = setup(); await h.flush();
  h.panes[0].status = 'idle';
  h.hud.runs = [{ workers: [{ terminal: 't1', model: 'launch', effort: 'high' }] }];
  const refresh = async () => { h.intervals.find(t => t.ms === 3000).fn(h.cx); await h.flush(); };
  h.hud.terminals = [{ address: 't1' }];
  await refresh();
  assert.deepEqual(h.tree.lastModel.t1, { model: 'launch', effort: 'high', programKey: undefined, at: h.tree.lastModel.t1.at });
  h.hud.terminals = [{ address: 't1', model: 'current', effort: 'low' }];
  await refresh();
  assert.deepEqual(h.tree.lastModel.t1, { model: 'current', effort: 'low', programKey: undefined, at: h.tree.lastModel.t1.at });
  h.hud.terminals[0].effort = 'max';
  await refresh();
  assert.deepEqual(h.tree.lastModel.t1, { model: 'current', effort: 'max', programKey: undefined, at: h.tree.lastModel.t1.at });
  h.hud.terminals = [{ address: 't1' }];
  await refresh();
  assert.deepEqual(h.tree.orch.lastModel.t1, { model: 'current', effort: 'max', programKey: undefined, at: h.tree.lastModel.t1.at });
});


test('model observations follow program identity and survive helper failure', async () => {
  const h = setup(); await h.flush();
  const pane = h.panes[0];
  const refresh = async () => { h.intervals.find(t => t.ms === 3000).fn(h.cx); await h.flush(); };
  const label = () => paneSub(pane, orchIndexes(h.tree.orch));
  pane.program = { key: 'claude', agent: true };
  h.hud.terminals = [{ address: 't1', program: 'claude-code', model: 'opus', effort: 'high' }];
  await refresh(); assert.equal(label(), 'opus-high');
  assert.equal(h.tree.lastModel.t1.programKey, 'claude');
  assert.ok(Number.isFinite(h.tree.lastModel.t1.at));
  const observedAt = h.tree.lastModel.t1.at;
  h.failPoll = true; await refresh();
  assert.equal(label(), 'opus-high'); assert.equal(h.tree.lastModel.t1.at, observedAt);
  pane.program = { key: 'shell', icon: 'icons/shell.svg' };
  assert.equal(label(), 'main');
  pane.program = { key: 'codex', agent: true };
  assert.equal(label(), 'main'); await refresh(); assert.equal(label(), 'main');
  h.failPoll = false; await refresh(); assert.equal(label(), 'main');
  h.hud.terminals = [{ address: 't1', program: 'codex', model: 'gpt', effort: 'low' }];
  await refresh(); assert.equal(label(), 'gpt-low');
  h.hud.terminals[0].model = 'gpt-new';
  await refresh(); assert.equal(label(), 'gpt-new-low');
});
