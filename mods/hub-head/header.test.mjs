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
test('header matches pane size and colors, shows source title and dim cwd without a source button', () => {
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
  assert.equal(walk(h.root).filter(n => n?.style?.tooltip).length, 0);
  assert.equal(byId(h.root, 'hub-source-remote/t1'), undefined);
  h.root.handlers.click(); assert.deepEqual(h.calls.at(-1), { run: ['pane.focus', { terminal: 'remote/t1' }] });
});
test('empty hub renders an explanatory placeholder', () => {
  assert.ok(walk(header(true).root).includes('No Head terminals'));
});


test('same tinted Program uses muted and full-color Program keeps its image', () => {
  const t = { muted: '#999999', foreground: '#eeeeee', dim: '#606060' };
  const calls = [];
  const tagged = kind => path => { const el = element(); el.kind = kind; el.path = path; calls.push(el); return el; };
  const program = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg', tint: true };
  const h = host();
  const deps = { ...h.deps, svg: tagged('svg'), image: tagged('image'), theme: () => t };
  let current;
  const Header = load(new URL('./main.js', import.meta.url), 'HubHead', { ...deps, props: () => ({ address: 't' }), home: () => '/fixture', panes: () => [{ terminal: 't', program: current }] });
  const render = program => { current = program; return new Header().render(); };
  render(program);
  assert.equal(calls.find(c => c.path === program.icon).style.text_color, t.muted);
  assert.equal(calls.find(c => c.path === program.icon).kind, 'svg');
  calls.length = 0;
  render({ ...program, tint: false });
  assert.equal(calls.find(c => c.path === program.icon).kind, 'image');
});

test('missing Program and icon use the muted terminal glyph', () => {
  const t = { muted: '#999999', foreground: '#eeeeee', dim: '#606060' };
  const calls = [];
  const tagged = kind => path => { const el = element(); el.kind = kind; el.path = path; calls.push(el); return el; };
  const program = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg', tint: true };
  const h = host();
  const deps = { ...h.deps, svg: tagged('svg'), image: tagged('image'), theme: () => t };
  let current;
  const Header = load(new URL('./main.js', import.meta.url), 'HubHead', { ...deps, props: () => ({ address: 't' }), home: () => '/fixture', panes: () => [{ terminal: 't', program: current }] });
  const render = program => { current = program; return new Header().render(); };
  for (const program of [null, { key: 'program', icon: null }]) {
    const root = render(program);
    const fallback = walk(root).find(n => n?.nodes?.includes('›_'));
    assert.ok(fallback);
    assert.equal(fallback.style.text_color, t.muted);
    assert.equal(fallback.style.size, 14);
  }
});
