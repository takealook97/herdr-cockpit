import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, byId } from '../hub-bar/host.test.mjs';
const tree = active => ({ children: [{ id: 'work-stack', active }] });
function setup(active = 'hub-view') {
  const h = host(); h.layout = tree(active);
  const SpaceTree = load(new URL('./main.js', import.meta.url), 'SpaceTree', {
    ...h.deps, Plumbing: class {}, layout: () => h.layout,
  });
  h.view = new SpaceTree(); h.view.handle = { focus() {} }; return h;
}
for (const kind of ['space', 'tab', 'pane']) test(`${kind} row returns to normal before navigating`, () => {
  const h = setup(); h.view.select({ kind, id: 'target', key: 'key' }, h.cx);
  assert.deepEqual(h.calls.map(c => c.run), [
    ['layout.select', { stack: 'work-stack', child: 'work-normal' }],
    [kind === 'pane' ? 'pane.focus' : `${kind}.select`, kind === 'pane' ? { pane: 'target' } : { id: 'target' }],
  ]);
});
test('normal view and machine rows do not request stack changes; editing guards still apply', () => {
  const h = setup('work-normal'); h.view.select({ kind: 'space', id: 's' }, h.cx);
  assert.deepEqual(h.calls.map(c => c.run), [['space.select', { id: 's' }]]);
  h.calls.length = 0; h.layout = tree('hub-view');
  h.view.select({ kind: 'machine', id: 'm' }, h.cx); assert.equal(h.calls.length, 0);
  h.view.editing = true; h.view.select({ kind: 'tab', id: 't' }, h.cx); assert.equal(h.calls.length, 0);
});
test('pinned hub active state follows the shown stack rather than stale shared state', () => {
  const h = setup(); h.shared.set('hub.open', false); assert.equal(h.view.hubActive(), true);
  h.layout = tree('work-normal'); h.shared.set('hub.open', true); assert.equal(h.view.hubActive(), false);
});
