import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, byId } from '../cerberus-bar/host.test.mjs';

test('cell navigates to source space then tab, updates blocked border and toggles focus', () => {
  const h = host();
  const p = { address: 'remote/t1', tabName: 'Task', spaceName: 'Repo', space: 'remote/s1', tab: 'remote/tb', status: 'idle' };
  const Cell = load(new URL('./main.js', import.meta.url), 'CerberusCell', { ...h.deps,
    props: () => p, panes: () => [{ terminal: p.address, status: 'blocked' }],
  });
  const cell = new Cell(), tree = cell.render();
  assert.equal(tree.style.h, 26);
  assert.equal(tree.style.border_color, 'blocked');
  byId(tree, 'select-head').handlers.click();
  assert.deepEqual(h.calls.map(c => c.run), [['space.select', { id: 'remote/s1' }], ['tab.select', { id: 'remote/tb' }]]);
  byId(tree, 'focus-head').handlers.click();
  assert.equal(h.shared.get('cerberus.focus'), 'remote/t1');
  p.focus = true; byId(cell.render(), 'focus-head').handlers.click();
  assert.equal(h.shared.get('cerberus.focus'), null);
});
