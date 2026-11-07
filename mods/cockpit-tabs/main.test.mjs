import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTree } from '../space-tree/model.js';

// Retain children and callbacks so tests dispatch the actual native header handlers.
function host({ remote = true, ready = false, fallback = true, tabs } = {}) {
  const state = { spaces: [{ id: 's', machine: remote ? 'r' : null, active: true,
    tabs: tabs ?? [{ id: 'a', name: 'Agent', active: true }] },
    ...(fallback ? [{ id: 'local', machine: null, tabs: [] }] : [])],
    machines: [{ name: 'r', layout: ready ? 'ready' : 'loading' }], calls: [] };
  function element() {
    const node = { kids: [], handlers: {} };
    let proxy;
    proxy = new Proxy(node, { get(obj, key) {
      if (key in obj) return obj[key];
      return (...args) => {
        if (key === 'id') obj.key = args[0];
        else if (key === 'child') obj.kids.push(args[0]);
        else if (key === 'children') obj.kids.push(...args[0]);
        else if (key === 'when') { if (args[0]) args[1](proxy); }
        else if (key.startsWith('on_')) obj.handlers[key + (key === 'on_mouse_down' || key === 'on_mouse_up' ? ':' + args[0] : '')] = args.at(-1);
        return proxy;
      };
    } });
    return proxy;
  }
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
  const names = ['View','div','svg','image','h_flex','spaces','machines','panes','run','openOverlay','theme','window','shared','layout','settings','localStorage'];
  const Tabs = new Function(...names, source)(class {}, element, element, element, element,
    () => state.spaces, () => state.machines, () => [],
    (command, args) => state.calls.push([command, args]), () => {}, () => ({}),
    () => ({}), () => [], () => ({}), () => ({ zoom: 1 }), { getItem: () => null, setItem() {} });
  const view = new Tabs(); view.init();
  state.render = () => { state.root = view.render(); };
  state.find = id => {
    const walk = node => typeof node === 'object' && node != null ? node.key === id ? node : node.kids?.map(walk).find(Boolean) : undefined;
    return walk(state.root);
  };
  state.fire = (id, event = 'on_click') => state.find(id).handlers[event]({ click_count: 1 }, { stop_propagation() {} });
  state.render();
  return state;
}

test('offline close only selects local and settles; without fallback only settles', () => {
  for (const fallback of [true, false]) {
    const h = host({ fallback }); h.fire('close-a');
    assert.deepEqual(h.calls, [...(fallback ? [['space.select', { id: 'local' }]] : []), ['tab.settle', { id: 'a' }]]);
  }
});
test('ready remote and local preserve native close', () => {
  for (const options of [{ ready: true }, { remote: false }]) {
    const h = host(options); h.fire('close-a');
    assert.deepEqual(h.calls, [['tab.close', { id: 'a' }]]);
  }
});
test('click rereads readiness and active space', () => {
  const h = host({ ready: true }); h.machines[0].layout = 'unavailable';
  h.spaces[0].active = false; h.fire('close-a');
  assert.deepEqual(h.calls, [['tab.settle', { id: 'a' }]]);
  const k = host(); k.machines[0].layout = 'ready'; k.fire('close-a');
  assert.deepEqual(k.calls, [['tab.close', { id: 'a' }]]);
});
test('removed space, removed tab, and already hidden stale targets do nothing', () => {
  for (const change of [h => h.spaces.shift(), h => h.spaces[0].tabs = [], h => h.spaces[0].tabs[0].settled = true]) {
    const h = host(); change(h); h.fire('close-a'); assert.deepEqual(h.calls, []);
  }
});
test('remote filtering and restore reread current hidden IDs', () => {
  const tabs = [{ id: 'a', name: 'A', active: true }, { id: 'b', name: 'B', settled: true }];
  const h = host({ tabs }); assert.equal(h.find('tab-b'), undefined);
  assert.ok(h.find('tab-a')); assert.ok(h.find('restore-hidden-tabs'));
  h.spaces[0].tabs = [{ id: 'new', settled: true }, { id: 'visible' }];
  h.fire('restore-hidden-tabs'); assert.deepEqual(h.calls, [['tab.unsettle', { id: 'new' }]]);
  const local = host({ remote: false, tabs }); assert.ok(local.find('tab-b')); assert.equal(local.find('restore-hidden-tabs'), undefined);
  h.calls.length = 0; h.spaces = []; h.fire('restore-hidden-tabs'); assert.deepEqual(h.calls, []);
});
test('reorder uses native full index across hidden gaps', () => {
  const h = host({ tabs: [{ id: 'a', name: 'A' }, { id: 'b', settled: true }, { id: 'c', name: 'C' }] });
  h.fire('tab-a', 'on_mouse_down:left'); h.fire('tab-c', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.move', { id: 'a', index: 3 }]]);
});
test('tree hides remote settled rows and panes while retaining machine, space, local and hub', () => {
  const rows = buildTree({ machines: [{ name: 'r', layout: 'loading' }], spaces: [
    { id: 's', machine: 'r', tabs: [{ id: 'hidden', settled: true }, { id: 'visible' }] },
    { id: 'l', tabs: [{ id: 'local-hidden', settled: true }] }],
    panes: [{ pane: 'p', tab: 'hidden', terminal: 't' }], hub: { heads: [{ address: 't', tab: 'hidden' }] } });
  for (const id of ['s', 'r', 'visible', 'l', 'local-hidden', 'hub-entry', 'hub:t']) assert.ok(rows.some(r => r.id === id), id);
  assert.ok(!rows.some(r => r.id === 'hidden' || r.id === 'p'));
});

test('tab drag moves the pressed ID after external reorder and redraw', () => {
  const h = host({ remote: false, tabs: ['a', 'b', 'c'].map(id => ({ id, name: id })) });
  h.fire('tab-a', 'on_mouse_down:left');
  h.spaces[0].tabs = [h.spaces[0].tabs[1], h.spaces[0].tabs[0], h.spaces[0].tabs[2]];
  h.render(); h.fire('tab-c', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.move', { id: 'a', index: 3 }]]);
});
test('tab drag safely aborts if the pressed tab disappears before redraw', () => {
  const h = host({ remote: false, tabs: ['a', 'b', 'c'].map(id => ({ id, name: id })) });
  h.fire('tab-c', 'on_mouse_down:left'); h.spaces[0].tabs.pop(); h.render();
  assert.doesNotThrow(() => h.fire('tab-a', 'on_mouse_up:left'));
  assert.deepEqual(h.calls, []);
});
test('tab drop revalidates stale rows, visibility and source space', () => {
  for (const change of ['target', 'source', 'settled-source', 'settled-target', 'space']) {
    const h = host({ tabs: ['a', 'b', 'c'].map(id => ({ id, name: id })) });
    h.fire('tab-a', 'on_mouse_down:left');
    if (change === 'target') h.spaces[0].tabs.pop();
    if (change === 'source') h.spaces[0].tabs.shift();
    if (change === 'settled-source') h.spaces[0].tabs[0].settled = true;
    if (change === 'settled-target') h.spaces[0].tabs[2].settled = true;
    if (change === 'space') h.spaces[0].id = 'new-space';
    h.fire('tab-c', 'on_mouse_up:left'); assert.deepEqual(h.calls, [], change);
  }
});
test('tab drop derives the current native index without requiring redraw', () => {
  const h = host({ tabs: [{ id: 'a', name: 'A' }, { id: 'hidden', settled: true }, { id: 'c', name: 'C' }] });
  h.fire('tab-a', 'on_mouse_down:left'); h.spaces[0].tabs.reverse();
  h.fire('tab-c', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.move', { id: 'a', index: 1 }]]);
});
test('press and release on the same tab preserves selection without moving it', () => {
  const h = host(); h.fire('tab-a', 'on_mouse_down:left'); h.fire('tab-a', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.select', { id: 'a' }]]);
});


test('tab press expires after 10 seconds without selecting or moving', t => {
  t.mock.method(Date, 'now', () => 100000);
  const h = host({ remote: false, tabs: ['a', 'b', 'c'].map(id => ({ id, name: id })) });
  h.fire('tab-a', 'on_mouse_down:left');
  t.mock.method(Date, 'now', () => 111000);
  h.fire('tab-c', 'on_mouse_up:left'); assert.deepEqual(h.calls, []);
  h.fire('tab-b', 'on_mouse_down:left'); h.fire('tab-c', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.move', { id: 'b', index: 3 }]]);
});
test('fresh tab press replaces a stale press', t => {
  t.mock.method(Date, 'now', () => 100000);
  const h = host({ remote: false, tabs: ['a', 'b', 'c'].map(id => ({ id, name: id })) });
  h.fire('tab-a', 'on_mouse_down:left');
  t.mock.method(Date, 'now', () => 111000);
  h.fire('tab-b', 'on_mouse_down:left'); h.fire('tab-c', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.move', { id: 'b', index: 3 }]]);
});
test('leaving the tabs container clears the press', () => {
  const h = host({ remote: false, tabs: ['a', 'b'].map(id => ({ id, name: id })) });
  h.fire('tab-a', 'on_mouse_down:left'); h.root.handlers.on_hover(false);
  h.fire('tab-b', 'on_mouse_up:left');
  assert.deepEqual(h.calls, [['tab.select', { id: 'b' }]]);
});
