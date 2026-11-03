import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observerFor, planHub, headsFrom, hubSpace, mergeHuds, observerArgs } from './hub-model.js';
import { buildTree, paneName, paneSub, orchIndexes } from './model.js';

test('labels and observe argv detect observers without matching ordinary attach', () => {
  assert.equal(observerFor({ labels: { 'hub.observer': 'remote/host/t1' } }), 'remote/host/t1');
  assert.equal(observerFor({ argv: ['hc', 'attach', '--observe', '--history', '2000', 'remote/host/t1'] }), 'remote/host/t1');
  assert.equal(observerFor({ argv: ['hc', 'attach', 't1'] }), null);
  assert.equal(observerFor({ argv: 'hc attach --observe t1' }), null);
});
test('plan adds missing heads, removes gone and duplicate observers, and kills a seed only after a surviving observer exists', () => {
  const observers = [{ address: 'o1', labels: { 'hub.observer': 't1' } },
    { address: 'o2', labels: { 'hub.observer': 'gone' } }, { address: 'o3', labels: { 'hub.observer': 't1' } },
    { address: 'outside', labels: { 'hub.observer': 'gone' } }];
  const hubPanes = ['seed', 'o1', 'o2', 'o3'].map(terminal => ({ terminal }));
  assert.deepEqual(planHub({ heads: ['t1', 'remote/t2'], hubPanes, observers }),
    { add: ['remote/t2'], remove: ['o2', 'o3'], killSeed: 'seed' });
  assert.deepEqual(planHub({ heads: ['t1'], hubPanes: [{ terminal: 'seed' }], observers }), { add: ['t1'], remove: [] });
  assert.deepEqual(planHub({ heads: [], hubPanes, observers }), { add: [], remove: ['o1', 'o2', 'o3'] });
});
test('heads exclude workers, observers and hub space and retain models and complete remote addresses', () => {
  const spaces = [{ id: 's', tabs: [{ id: 'tab', name: 'Head' }] }, { id: 'h', tabs: [{ id: 'hubtab' }] },
    { id: 'remote/host/s', machine: 'remote/host', tabs: [{ id: 'remote/host/tab', name: 'Remote' }] }];
  const panes = ['head', 'worker', 'observer', 'argv'].map(terminal => ({ terminal, tab: 'tab' }));
  panes.push({ terminal: 'inside', tab: 'hubtab' }, { terminal: 'remote/host/t1', tab: 'remote/host/tab' });
  const data = { runs: [{ workers: [{ terminal: 'worker' }] }], terminals: [
    { address: 'head', model: 'sol' }, { address: 'worker' }, { address: 'inside' },
    { address: 'observer', labels: { 'hub.observer': 'head' } },
    { address: 'argv', argv: ['hc', 'attach', '--observe', 'head'] }, { address: 'remote/host/t1' }] };
  const heads = headsFrom(data, panes, spaces, 'h');
  assert.deepEqual(heads.map(h => h.address), ['head', 'remote/host/t1']);
  assert.equal(heads[0].model, 'sol');
});
test('hub resolves a remembered local space, falls back to exact local name, never a remote hub', () => {
  const spaces = [{ id: 'remote/h', name: 'hub', machine: 'remote' }, { id: 'h', name: 'hub' }, { id: 'renamed', name: 'renamed' }];
  assert.equal(hubSpace(spaces, 'renamed').id, 'renamed');
  assert.equal(hubSpace(spaces, 'deleted').id, 'h');
  assert.equal(hubSpace(spaces.slice(0, 1)), undefined);
});
test('hub row is first under This computer and real hub is not duplicated; observer tree names and models follow source', () => {
  const head = { address: 'remote/t1', tabName: 'Review', spaceName: 'Project', model: 'sol', effort: 'high' };
  const orch = { terminals: [{ address: 'o1', labels: { 'hub.observer': head.address }, model: 'incorrect' }] };
  const rows = buildTree({ spaces: [{ id: 's', name: 'Work' }, { id: 'h', name: 'hub', tabs: [{ id: 'ht' }] }],
    panes: [{ pane: 'p', terminal: 'o1', tab: 'ht' }], orch, hub: { id: 'h', heads: [head] } });
  assert.equal(rows[0].name, 'This computer');
  assert.equal(rows[1].key, 'hub-entry');
  assert.equal(rows.filter(r => r.id === 'h').length, 1);
  const observer = rows.find(r => r.kind === 'pane');
  assert.equal(observer.name, 'Review · Project'); assert.equal(observer.sub, 'sol-high');
  assert.equal(buildTree({ hub: {} })[1].key, 'hub-entry');
});
test('remote snapshots qualify worker, space and tab ids and retain observer labels', () => {
  const data = mergeHuds([{ machine: 'remote/host', data: { orch: true, terminals: [{ address: 't1', labels: { 'hub.observer': 't9' } }],
    runs: [{ head_terminal: 't2', workspace: 's', tab: 'tb', workers: [{ terminal: 't3' }] }] } }]);
  assert.equal(data.terminals[0].address, 'remote/host/t1');
  assert.equal(data.terminals[0].labels['hub.observer'], 't9');
  assert.equal(data.runs[0].workers[0].terminal, 'remote/host/t3');
  assert.equal(data.runs[0].tab, 'remote/host/tb'); assert.equal(data.orch, true);
});
test('observer command uses native panes with literal labels and read-only attach', () => {
  assert.deepEqual(observerArgs('s', 'tb', 'remote/host/t1'), ['run', '--keep', '--bg', '--json', '--no-parent',
    '--label', 'herdr.space=s', '--label', 'herdr.tab=tb', '--label', 'hub.observer=remote/host/t1',
    '--', 'hc', 'attach', '--observe', '--history', '2000', 'remote/host/t1']);
});
test('cockpit is a plain work column with native tab panes and the hub shortcut', () => {
  const layout = JSON.parse(readFileSync(new URL('../../layouts/cockpit.json', import.meta.url)));
  assert.deepEqual(layout.children[1].children.map(n => n.id), ['usage', 'tabs', 'work-body', 'status']);
  assert.doesNotMatch(JSON.stringify(layout), /hub-grid|hub-view|work-stack|hub-bar|hub-cell/);
  assert.equal(JSON.parse(readFileSync(new URL('../../keys/hub.json', import.meta.url))).global['ctrl-shift-h'], 'space-tree.hub');
});
