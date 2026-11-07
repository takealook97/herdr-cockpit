import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, element, walk } from '../space-tree/host.test.mjs';


test('same tinted Program uses muted and full-color Program keeps its image', () => {
  const t = { muted: '#999999', foreground: '#eeeeee', dim: '#606060' };
  const calls = [];
  const tagged = kind => path => { const el = element(); el.kind = kind; el.path = path; calls.push(el); return el; };
  const program = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg', tint: true };
  const h = host();
  const deps = { ...h.deps, svg: tagged('svg'), image: tagged('image'), theme: () => t };
  const draw = load(new URL('./presentation.js', import.meta.url), 'icon', deps);
  const render = program => { for (const size of [14, 16]) { const pic = draw(program, size, t.muted); assert.equal(pic.style.size ?? pic.style.w, size); } };
  render(program);
  assert.equal(calls.find(c => c.path === program.icon).style.text_color, t.muted);
  assert.equal(calls.find(c => c.path === program.icon).kind, 'svg');
  calls.length = 0;
  render({ ...program, tint: false });
  assert.equal(calls.find(c => c.path === program.icon).kind, 'image');
});

test('parent and child call sites pass the shared muted tint', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /icon\(k\.program, 14, t\.muted\)/);
  assert.match(main, /icon\(a\.program, 16, t\.muted\)/);
});
