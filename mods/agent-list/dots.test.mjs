import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const pres = readFileSync(new URL('./presentation.js', import.meta.url), 'utf8');

test('status dot follows the HUB indicator', () => {
  assert.match(pres, /size\(6\)\.rounded\(3\)/);
  assert.match(pres, /status === "idle", e => e\.border\(1\)\.border_color\(t\.dim\)/);
  assert.match(pres, /loop\("opacity", \{ from: 0\.35, to: 1, period: 1800 \}\)/);
});

test('no spinner is left in the agent list', () => {
  assert.doesNotMatch(main, /spinner\.svg|\.spin\(/);
});

test('space part is dim and tab part is foreground', () => {
  assert.match(main, /text_color\(full \? t\.dim : t\.foreground\)\.child\(name\)/);
  assert.match(main, /text_color\(t\.foreground\)\.child\(more\)/);
});
