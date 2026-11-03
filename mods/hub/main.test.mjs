import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, host } from '../hub-bar/host.test.mjs';
import * as model from './model.js';
const cockpit = () => JSON.parse(readFileSync(new URL('../../layouts/cockpit.json', import.meta.url), 'utf8'));
function setup(tree = cockpit()) {
  const h = host(); h.layout = tree;
  h.spaces = [{ id: 's', name: 'Repo', machine: null, tabs: [{ id: 'tb', name: 'Head', index: 1 }] }];
  h.panes = [{ tab: 'tb', terminal: 't1', status: 'working' }];
  h.hud = { runs: [], terminals: [{ address: 't1' }] };
  h.responses = () => ({ code: 0, stdout: JSON.stringify(h.hud) });
  const Controller = load(new URL('./main.js', import.meta.url), 'Hub', {
    ...h.deps, ...model, layout: () => h.layout, spaces: () => h.spaces,
    machines: () => [], panes: () => h.panes, nextCommand: () => new Promise(() => {}),
    exec: async (...args) => { h.calls.push({ exec: args }); return h.responses(args); },
    run: (command, args) => {
      h.calls.push({ run: [command, args] });
      if (command === 'layout.set') h.layout = args.layout;
      if (command === 'layout.select') model.findNode(h.layout, args.stack).active = args.child;
    },
  });
  h.view = new Controller(); h.view.init({}, h.cx); return h;
}
const writes = h => h.calls.filter(c => c.run?.[0] === 'layout.set');
const active = h => model.findNode(h.layout, 'work-stack').active;
test('toggle selects inline hub and normal tab view, preserving bar and normal subtree', async () => {
  const h = setup(); await h.flush();
  const normal = model.findNode(h.layout, 'work-normal'), bar = model.findNode(h.layout, 'hub-bar');
  h.view.toggle(h.cx);
  assert.equal(active(h), 'hub-view');
  assert.equal(model.findNode(h.layout, 'hub-grid').children[0].children[0].children[1].content.terminal, 't1');
  assert.equal(model.findNode(h.layout, 'work-normal'), normal);
  assert.equal(model.findNode(h.layout, 'hub-bar'), bar);
  h.view.toggle(h.cx);
  assert.equal(active(h), 'work-normal');
  assert.equal(h.shared.get('hub.open'), false);
});
test('grid changes debounce while open and stop on sidebar exit', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.panes.push({ tab: 'tb', terminal: 't2', status: 'idle' }); h.hud.terminals.push({ address: 't2' });
  h.view.refresh(h.cx); await h.flush();
  assert.equal(writes(h).length, 1);
  h.panes[1].status = 'blocked'; h.view.sync(h.cx);
  assert.equal(h.timers.filter(t => !t.canceled).length, 1);
  h.tick(1000); assert.equal(writes(h).length, 2);
  assert.equal(active(h), 'hub-view');
  h.shared.set('hub.focus', 't1'); h.view.sync(h.cx);
  model.findNode(h.layout, 'work-stack').active = 'work-normal';
  h.tick(1000); assert.equal(writes(h).length, 2);
  h.view.sync(h.cx); assert.equal(h.shared.get('hub.open'), false);
});
test('status updates remain live and failed polls retain Heads and pause broadcast', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.panes[0].status = 'done'; h.view.sync(h.cx);
  assert.equal(h.timers.filter(t => !t.canceled).length, 0);
  assert.equal(h.shared.get('hub.heads')[0].status, 'done');
  h.responses = () => ({ code: 1 }); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.shared.get('hub.heads').length, 1);
  assert.equal(h.shared.get('hub.stale'), true);
});
test('in-flight sends defer requested close and grid changes', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.shared.set('hub.sending', true); h.shared.set('hub.focus', 't1'); h.view.sync(h.cx);
  assert.equal(h.timers.length, 0);
  h.view.hide(); assert.equal(active(h), 'hub-view');
  h.shared.set('hub.sending', false); h.view.sync(h.cx);
  assert.equal(active(h), 'work-normal');
});
test('equal grids skip layout writes; paging and focus retain the stable grid slot', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.view.updateGrid(); assert.equal(writes(h).length, 1);
  h.shared.set('hub.page', 99); h.view.updateGrid();
  assert.equal(h.shared.get('hub.page'), 0); assert.equal(writes(h).length, 1);
  h.shared.set('hub.focus', 't1'); h.view.sync(h.cx); h.tick(1000);
  assert.ok(model.findNode(h.layout, 'hub-grid'));
});
test('another layout stays untouched and reports why hub cannot open', async () => {
  const h = setup({ id: 'other', type: 'column', children: [] }); await h.flush(); h.view.toggle(h.cx);
  assert.equal(h.calls.filter(c => c.run).length, 0);
  assert.match(h.shared.get('hub.unavailable'), /work-stack/);
});
test('remote helpers qualify full worker addresses before exclusion', async () => {
  const h = setup(); await h.flush();
  h.spaces.push({ id: 'remote/host/s', name: 'Remote', machine: 'remote/host', tabs: [{ id: 'remote/host/tb', index: 1, name: 'Remote Head' }] });
  h.panes.push({ tab: 'remote/host/tb', terminal: 'remote/host/t1' }, { tab: 'remote/host/tb', terminal: 'remote/host/t2' });
  h.responses = args => ({ code: 0, stdout: JSON.stringify(args[2].on ? {
    runs: [{ workers: [{ terminal: 't2' }] }], terminals: [{ address: 't1' }, { address: 't2' }],
  } : h.hud) });
  h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.shared.get('hub.heads').map(h => h.address), ['t1', 'remote/host/t1']);
});
test('cockpit mounts controller, stable stack slots and hub key without floating APIs', () => {
  const tree = cockpit();
  assert.equal(model.findNode(tree, 'hub-controller').size.px, 0);
  assert.equal(model.findNode(tree, 'work-stack').active, 'work-normal');
  assert.equal(model.findNode(tree, 'hub-bar').size.px, 44);
  assert.equal(model.findNode(tree, 'panel').hidden, true);
  assert.equal(JSON.parse(readFileSync(new URL('../../keys/hub.json', import.meta.url))).global['ctrl-shift-h'], 'hub.toggle');
  for (const mod of ['hub', 'hub-bar', 'hub-cell'])
    assert.doesNotMatch(readFileSync(new URL(`../${mod}/main.js`, import.meta.url), 'utf8'), /openOverlay|closeOverlay/);
});
test('replaceNode is immutable and returns same root for equal children or missing ids', () => {
  const tree = cockpit(), children = [model.gridFor(4)];
  const next = model.replaceNode(tree, 'hub-grid', children);
  assert.notEqual(next, tree);
  assert.equal(model.findNode(tree, 'hub-grid').children[0].content.props.empty, true);
  assert.deepEqual(model.findNode(next, 'hub-grid').children, children);
  children[0].children = [];
  assert.notDeepEqual(model.findNode(next, 'hub-grid').children, children);
  assert.equal(model.replaceNode(next, 'hub-grid', model.findNode(next, 'hub-grid').children), next);
  assert.equal(model.replaceNode(next, 'absent', []), next);
});
