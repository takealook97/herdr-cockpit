import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observerFor, headsFrom, mergeHuds, gridFor, gridShape, neighbor, zoomToggle, findNode } from './hub-model.js';
import { buildTree } from './model.js';

const heads = n => Array.from({ length: n }, (_, i) => ({ address: `t${i + 1}`, tabName: `Tab ${i}`, spaceName: 'Work', space: 's', tab: `tb${i}` }));
const terminals = node => node.content?.terminal ? [node.content.terminal] : (node.children ?? []).flatMap(terminals);
test('grid rule covers n=1..9 exactly once, with native cards and interactive terminal blocks', () => {
  for (let n = 1; n <= 9; n++) {
    const grid = gridFor(heads(n));
    const shape = gridShape(n);
    assert.equal(shape.rows, n <= 2 ? 1 : 2);
    assert.equal(shape.cols, Math.ceil(n / shape.rows));
    assert.equal(grid.children.length, shape.rows);
    assert.deepEqual(terminals(grid), heads(n).map(h => h.address));
    assert.equal(grid.gap, 8); assert.equal(grid.padding, 8);
    const cell = grid.children[0].children[0];
    assert.equal(cell.focus, undefined);
    assert.deepEqual(cell.border, { width: 1, color: 'border' });
    assert.equal(cell.radius, 10); assert.equal(cell.children[0].size.px, 30);
    assert.equal(cell.children[0].content.mod, 'hub-head');
  }
});
test('neighbor navigation respects rows, columns, boundaries and odd final rows', () => {
  for (const [n, cols] of [[4, 2], [5, 3], [6, 3]]) {
    const hs = heads(n);
    for (let i = 0; i < n; i++) {
      const address = hs[i].address;
      const expected = {
        left: i % cols > 0 ? i - 1 : i,
        right: i % cols < cols - 1 && i + 1 < n ? i + 1 : i,
        up: i >= cols ? i - cols : i,
        down: i + cols < n ? i + cols : i,
      };
      for (const [direction, at] of Object.entries(expected)) assert.equal(neighbor(hs, address, direction), hs[at].address, `${n} ${address} ${direction}`);
    }
  }
  assert.equal(neighbor([], null, 'left'), undefined);
  assert.equal(neighbor(heads(2), null, 'right'), 't1');
});
test('zoom toggles a focused cell to full hub and back; empty hub uses a placeholder', () => {
  let zoom = zoomToggle(null, 't2');
  assert.deepEqual(terminals(gridFor(heads(5), zoom)), ['t2']);
  zoom = zoomToggle(zoom, 't2'); assert.equal(zoom, null);
  assert.equal(terminals(gridFor(heads(5), zoom)).length, 5);
  assert.equal(gridFor([]).children[0].content.props.empty, true);
});
test('heads exclude orch workers and legacy observers, preserving remote addresses', () => {
  const hud = { runs: [{ workers: [{ terminal: 'worker' }] }], terminals: [
    { address: 'head' }, { address: 'worker' }, { address: 'observer', labels: { 'hub.observer': 'head' } },
    { address: 'argv', argv: ['hc', 'attach', '--observe', 'head'] }, { address: 'remote/host/t1' }] };
  const spaces = [{ id: 's', tabs: [{ id: 'tab' }] }, { id: 'remote/host/s', machine: 'remote/host', tabs: [{ id: 'remote/host/tab' }] }];
  const ps = ['head', 'worker', 'observer', 'argv'].map(terminal => ({ terminal, tab: 'tab' }));
  ps.push({ terminal: 'remote/host/t1', tab: 'remote/host/tab' });
  assert.deepEqual(headsFrom(hud, ps, spaces).map(h => h.address), ['head', 'remote/host/t1']);
  assert.equal(observerFor({ argv: ['hc', 'attach', 't1'] }), null);
});
test('hub section is locked, directly lists heads, and retains ordinary spaces named hub', () => {
  const hs = heads(2), rows = buildTree({ spaces: [{ id: 's', name: 'Work' }, { id: 'user-hub', name: 'hub' }], hub: { heads: hs, active: true, terminal: 't2' } });
  assert.equal(rows[0].name, 'This computer');
  assert.equal(rows[1].key, 'nexus-entry'); assert.equal(rows[1].foldable, false);
  assert.equal(rows[2].name, 'hub · 2'); assert.equal(rows[2].key, 'hub-entry');
  assert.equal(rows[2].active, true); assert.equal(rows[2].foldable, false);
  assert.deepEqual(rows.slice(3, 5).map(r => [r.kind, r.terminal, r.hub]), [['pane', 't1', true], ['pane', 't2', true]]);
  assert.equal(rows[4].active, true);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
  assert.ok(rows.find(r => r.id === 'user-hub' && !r.hub));
  assert.equal(buildTree({ hub: {}, folded: { 'hub-entry': true } })[2].foldable, false);
});
test('remote helper snapshots qualify worker and terminal addresses once', () => {
  const result = mergeHuds([{ machine: 'remote/host', data: { terminals: [{ address: 't1' }], runs: [{ workers: [{ terminal: 't2' }] }] } }]);
  assert.equal(result.terminals[0].address, 'remote/host/t1');
  assert.equal(result.runs[0].workers[0].terminal, 'remote/host/t2');
});
test('cockpit stacks hub and normal work; tab bar belongs only to normal work', () => {
  const layout = JSON.parse(readFileSync(new URL('../../layouts/cockpit.json', import.meta.url)));
  const stack = findNode(layout, 'work-stack');
  assert.equal(stack.active, 'work-normal');
  assert.deepEqual(stack.children.map(n => n.id), ['work-normal', 'hub-view']);
  assert.ok(findNode(stack.children[0], 'tabs'));
  assert.equal(findNode(stack.children[1], 'tabs'), undefined);
  assert.ok(findNode(stack.children[1], 'hub-grid'));
});

test('focused address colors only the whole matching card', () => {
  const grid = gridFor(heads(3), null, 't2');
  for (const h of heads(3)) {
    const cell = findNode(grid, `hub-cell-${h.address}`);
    assert.deepEqual(cell.border, { width: 1, color: h.address === 't2' ? 'accent' : 'border' });
    assert.equal(cell.focus, undefined);
  }
});
test('hub names put space first and never include model text', () => {
  const rows = buildTree({ hub: { heads: [{ ...heads(1)[0], model: 'sol', effort: 'high' }] } });
  const row = rows.find(r => r.terminal === 't1');
  assert.equal(row.name, 'Work · Tab 0'); assert.equal(row.sub, '');
});

test('the nexus voice terminal never becomes a Head', () => {
  const hud = { runs: [], terminals: [{ address: 'head' }, { address: 'voice', labels: { 'nexus.voice': '1' } }] };
  const ps = [{ pane: 'p1', terminal: 'head', tab: 'tb1' }, { pane: 'p2', terminal: 'voice', tab: 'tb1' }];
  const spaces = [{ id: 's1', name: 'a', tabs: [{ id: 'tb1', name: 'x' }] }];
  assert.deepEqual(headsFrom(hud, ps, spaces).map(h => h.address), ['head']);
  const labelledPane = [{ pane: 'p1', terminal: 'head', tab: 'tb1' }, { pane: 'p2', terminal: 'v2', tab: 'tb1', labels: { 'nexus.voice': '1' } }];
  assert.deepEqual(headsFrom({ runs: [], terminals: [{ address: 'head' }, { address: 'v2' }] }, labelledPane, spaces).map(h => h.address), ['head']);
});
