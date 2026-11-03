import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, element, byId, walk } from '../space-tree/host.test.mjs';
function header(empty = false, active = false) {
  const h = host({ 'hub.heads': [{ address: 'remote/t1', tabName: 'Review', spaceName: 'Project', space: 'remote/s', tab: 'remote/tb' }] });
  const Header = load(new URL('./main.js', import.meta.url), 'HubHead', { ...h.deps,
    props: () => ({ address: 'remote/t1', empty }), home: () => '/fixture',
    panes: () => [{ terminal: 'remote/t1', cwd: '/fixture/project', program: { icon: 'icons/test.svg', tint: true } }],
    svg: element, image: element, focused: () => ({ terminal: active ? 'remote/t1' : 'other' }),
  });
  return { ...h, root: new Header().render() };
}
test('header matches pane size and colors, shows source title and dim cwd with one source button', () => {
  const h = header();
  assert.equal(h.root.style.px, 10); assert.equal(h.root.style.gap, 8); assert.equal(h.root.style.text_size, 12);
  assert.equal(h.root.style.bg, 'background'); assert.equal(h.root.style.border_t, undefined);
  assert.equal(h.root.style.border_color, 'border'); assert.equal(h.root.style.opacity, undefined);
  assert.equal(h.root.style.border_b, 1); assert.equal(h.root.style.hover, undefined);
  const title = walk(h.root).find(n => n?.nodes?.includes('Project · Review'));
  const cwd = walk(h.root).find(n => n?.nodes?.includes('~/project'));
  assert.equal(title.style.text_color, 'foreground'); assert.equal(cwd.style.text_color, 'dim');
  const focused = header(false, true).root;
  assert.equal(focused.style.bg, 'background'); assert.equal(focused.style.border_t, undefined);
  assert.equal(focused.style.border_color, 'border'); assert.equal(focused.style.opacity, undefined);
  assert.equal(walk(focused).find(n => n?.nodes?.includes('Project · Review')).style.text_color, 'foreground');
  assert.ok(walk(h.root).includes('Project · Review'));
  assert.ok(walk(h.root).includes('~/project'));
  assert.equal(walk(h.root).filter(n => n?.style?.tooltip).length, 1);
  assert.equal(byId(h.root, 'hub-source-remote/t1').style.tooltip, 'Go to source');
  h.root.handlers.click(); assert.deepEqual(h.calls.at(-1), { run: ['pane.focus', { terminal: 'remote/t1' }] });
  byId(h.root, 'hub-source-remote/t1').handlers.click({}, h.cx);
  assert.deepEqual(h.shared.get('hub.source'), { address: 'remote/t1', space: 'remote/s', tab: 'remote/tb' });
  assert.deepEqual(h.calls.at(-1), { run: ['space-tree.source'] });
});
test('empty hub renders an explanatory placeholder', () => {
  assert.ok(walk(header(true).root).includes('No Head terminals'));
});
