import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headsFrom, gridFor, cellOrder, selectedHeads, toggleTarget, mergeHuds, aggregateStatus, sendArgs } from './model.js';

const spaces = [
  { id: 's2', name: 'Second', tabs: [{ id: 'tb2', name: 'Two', index: 2 }, { id: 'tb1', name: 'One', index: 1 }] },
  { id: 'remote/host/s1', name: 'Remote', machine: 'remote/host', tabs: [{ id: 'remote/host/tb', name: 'Remote tab', index: 1 }] },
];
const panes = [
  { tab: 'tb2', terminal: 't2', status: 'working' },
  { tab: 'tb1', terminal: 'worker', status: 'working' },
  { tab: 'tb1', terminal: 't1', status: 'blocked' },
  { tab: 'tb1', terminal: 'shell', program: { agent: false } },
  { tab: 'tb1', terminal: null, mod: 'files' },
  { tab: 'remote/host/tb', terminal: 'remote/host/t9', status: 'idle' },
];
const hud = { runs: [{ workers: [{ terminal: 'worker', status: 'done' }] }],
  terminals: ['t2', 'worker', 't1', 'remote/host/t9'].map(address => ({ address })) };

test('heads exclude workers and non-agent panes and follow space then tab index order', () => {
  const heads = headsFrom(hud, panes, spaces);
  assert.deepEqual(cellOrder(heads), ['t1', 't2', 'remote/host/t9']);
  assert.deepEqual(heads[2], { address: 'remote/host/t9', tabName: 'Remote tab', spaceName: 'Remote',
    status: 'idle', machine: 'remote/host', space: 'remote/host/s1', tab: 'remote/host/tb' });
  assert.equal(aggregateStatus(heads), 'blocked');
  assert.deepEqual(headsFrom({}, panes, spaces), []);
  assert.deepEqual(cellOrder(headsFrom(hud, [...panes, panes[0]], spaces)), cellOrder(heads));
});

test('per-machine snapshots qualify remote workers and preserve complete addresses', () => {
  const merged = mergeHuds([{ machine: null, data: hud }, { machine: 'remote/host', data: {
    terminals: [{ address: 't9' }, { address: 'remote/host/t10' }],
    runs: [{ head_terminal: 't9', workers: [{ terminal: 't8' }] }],
  } }]);
  assert.deepEqual(merged.terminals.slice(-2).map(t => t.address), ['remote/host/t9', 'remote/host/t10']);
  assert.equal(merged.runs[1].workers[0].terminal, 'remote/host/t8');
  assert.equal(merged.runs[1].head_terminal, 'remote/host/t9');
});

const terminalAddresses = node => node.content?.terminal ? [node.content.terminal] : (node.children ?? []).flatMap(terminalAddresses);
test('grid geometry for 1 through 10 keeps each terminal once, with a header above it', () => {
  const rowSizes = { 1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 3, 1], 8: [3, 3, 2], 9: [3, 3, 3], 10: [3, 3, 3] };
  for (let n = 1; n <= 10; n++) {
    const grid = gridFor(n);
    assert.deepEqual(terminalAddresses(grid), Array.from({ length: Math.min(9, n) }, (_, i) => `head-${i}`));
    assert.deepEqual(grid.type === 'row' ? [grid.children.length] : grid.children.map(r => r.children.length), rowSizes[n]);
    const cells = grid.type === 'row' ? grid.children : grid.children.flatMap(r => r.children);
    for (const cell of cells) {
      assert.equal(cell.children[0].size.px, 26);
      assert.equal(cell.children[0].content.mod, 'hub-cell');
      assert.equal(cell.children[1].content.terminal, cell.children[0].content.props.address);
    }
  }
  assert.deepEqual(terminalAddresses(gridFor(10, null, 1)), ['head-9']);
  assert.deepEqual(terminalAddresses(gridFor(10, null, 999)), ['head-9']);
  assert.equal(gridFor(0).content.props.empty, true);
});

test('focus takes two thirds and stacks the rest in stable order', () => {
  for (let n = 2; n <= 10; n++) {
    const grid = gridFor(n, 1);
    assert.equal(grid.type, 'row');
    assert.equal(grid.children[0].size.weight, 2);
    assert.deepEqual(terminalAddresses(grid.children[0]), ['head-1']);
    assert.equal(grid.children[1].size.weight, 1);
    assert.equal(grid.children[1].type, 'column');
    assert.deepEqual(terminalAddresses(grid.children[1]), Array.from({ length: Math.min(9, n) }, (_, i) => `head-${i}`).filter(a => a !== 'head-1'));
  }
  assert.deepEqual(terminalAddresses(gridFor(1, 0)), ['head-0']);
  assert.deepEqual(terminalAddresses(gridFor(4, 'missing')), ['head-0', 'head-1', 'head-2', 'head-3']);
});

test('broadcast selection defaults to all, respects exclusions and enrolls new heads', () => {
  const heads = headsFrom(hud, panes, spaces);
  assert.deepEqual(selectedHeads(heads), heads);
  const excluded = toggleTarget([], 't2');
  assert.deepEqual(cellOrder(selectedHeads(heads, excluded)), ['t1', 'remote/host/t9']);
  assert.deepEqual(toggleTarget(excluded, 't2'), []);
  assert.deepEqual(cellOrder(selectedHeads([...heads, { address: 'new' }], excluded)), ['t1', 'remote/host/t9', 'new']);
  assert.deepEqual(sendArgs('remote/host/t9', '$(literal)\ntext'), ['send', 'remote/host/t9', '$(literal)\ntext']);
});

test('sandboxed mods carry identical model helpers', () => {
  assert.equal(readFileSync(new URL('./model.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../hub/model.js', import.meta.url), 'utf8'));
});
