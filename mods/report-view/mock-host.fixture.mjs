// Mock Herdr host shared by the report-view tests.
// Elements answer only registered builder methods, so a call outside the registry throws like the real runtime.
// Style callbacks (hover, on_hover) run at once; click handlers are kept so a test can fire them.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PARAM_STYLES, NULLARY_STYLES, ELEMENT_METHODS,
} from './herdr-registry.fixture.mjs';

const here = file => new URL(file, import.meta.url);
export const REGISTERED = new Set([...PARAM_STYLES, ...NULLARY_STYLES, ...ELEMENT_METHODS]);
export const THEME_KEYS = [
  'foreground', 'muted', 'dim', 'surface', 'raised', 'chrome', 'border', 'hover', 'working', 'blocked', 'done', 'accent',
];
export const TOKEN_PREFIX = 'token:';

// T1: every `.name(` and `['name'](` / `["name"](` call in a source text; blanks and line breaks may sit before the `(`.
export function usedMethods(source) {
  const dotted = [...source.matchAll(/\.([a-z_][a-z_0-9]*)\s*\(/g)].map(match => match[1]);
  const bracketed = [...source.matchAll(/\[\s*(['"])([a-z_][a-z_0-9]*)\1\s*\]\s*\(/g)].map(match => match[2]);
  return new Set([...dotted, ...bracketed]);
}

const HARNESS = `
const registered = new Set(JSON.parse(process.env.REGISTERED));
export class Element {
  constructor(kind) { this.kind = kind; this.parts = []; this.style = {}; this.handlers = []; }
}
const STRUCTURAL = new Set(['when', 'child', 'children', 'id', 'map', 'hover', 'on_hover', 'on_click', 'tab_index']);
for (const name of registered) {
  Element.prototype[name] = function (...args) {
    if (name === 'when') { if (args[0]) args[1](this); return this; }
    if (name === 'child') this.parts.push(args[0]);
    else if (name === 'children') this.parts.push(...args[0]);
    else if (name === 'map') return args[0](this) ?? this;
    else if (name === 'hover' || name === 'on_hover') args[0](new Element('hover'));
    else if (name === 'on_click') this.handlers.push(args[0]);
    else if (!STRUCTURAL.has(name)) this.style[name] = args.length ? args[0] : true;
    return this;
  };
}
export const div = () => new Element('div');
export class View {}
export const h_flex = () => new Element('h_flex');
export const v_flex = () => new Element('v_flex');
export const Button = { new: () => new Element('button') };
export const TextView = { markdown: () => { const el = new Element('markdown'); el.scrollable = function () { return this; }; return el; } };
`;

// `mainOverride` loads a changed copy of main.js (negative tests); model.js is always the real one.
export async function loadView({ mainOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'report-view-mock-'));
  const pkg = (name, source) => {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
    writeFileSync(join(dir, 'node_modules', name, 'index.js'), source);
  };
  pkg('gpui-kit', `import { div, View } from '../../mock/harness.js'; export { div, View };`);
  pkg('gpui-base', `import { h_flex, v_flex, Button, TextView } from '../../mock/harness.js'; export { h_flex, v_flex, Button, TextView };`);
  // Each theme token is its own name, so a rendered color can be traced back to the token the view picked.
  const theme = Object.fromEntries(THEME_KEYS.map(key => [key, `${TOKEN_PREFIX}${key}`]));
  pkg('herdr', `export const exec = () => Promise.reject(new Error('no exec')); export const focused = () => null;
    export const shared = () => undefined; export const theme = () => (${JSON.stringify(theme)});`);
  mkdirSync(join(dir, 'mock'), { recursive: true });
  writeFileSync(join(dir, 'mock', 'harness.js'), HARNESS);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  copyFileSync(here('./model.js'), join(dir, 'model.js'));
  if (mainOverride === null) copyFileSync(here('./main.js'), join(dir, 'main.js'));
  else writeFileSync(join(dir, 'main.js'), mainOverride);
  process.env.REGISTERED = JSON.stringify([...REGISTERED]);
  const mod = await import(pathToFileURL(join(dir, 'main.js')).href);
  const model = await import(pathToFileURL(join(dir, 'model.js')).href);
  const harness = await import(pathToFileURL(join(dir, 'mock', 'harness.js')).href);
  return { ReportView: mod.default, parseReport: model.parseReport, harness };
}

// spawn() really runs the async task it is given; each task's outcome (null, or the error it threw) lands in `tasks`.
export function mockCx(tasks = []) {
  const cx = {
    timer: { every() {}, after() {} },
    notify() {},
    spawn(task) {
      tasks.push(Promise.resolve().then(() => task(cx)).then(() => null, error => error ?? new Error('task rejected')));
    },
  };
  return cx;
}

// A view holding `data` (already parsed), closed so no timer work leaks.
export function viewWith(ReportView, data, logState = null) {
  const view = new ReportView();
  view.init({}, mockCx());
  view.closed = true;
  view.data = data;
  view.logState = logState;
  return view;
}

// T2: walk a rendered tree and record the token pair each text node and status dot actually uses.
// Text pairs: { kind: 'text', text, fg, bg, bold, size }. Dot pairs: { kind: 'dot', fg: dot color, bg }.
export function renderedPairs(root) {
  const pairs = [];
  const walk = (el, bg, fg) => {
    const nextBg = el.style.bg ?? bg;
    const nextFg = el.style.text_color ?? fg;
    const isDot = el.style.size !== undefined && el.style.bg !== undefined && el.parts.length === 0;
    if (isDot) pairs.push({ kind: 'dot', fg: el.style.bg, bg });
    for (const part of el.parts) {
      if (typeof part === 'string' || typeof part === 'number') {
        pairs.push({
          kind: 'text', text: String(part), fg: nextFg, bg: nextBg,
          bold: el.style.font_semibold === true || el.style.font_bold === true, size: el.style.text_size ?? 13,
        });
      } else if (part && part.kind !== 'markdown') walk(part, nextBg, nextFg);
    }
  };
  walk(root, undefined, undefined);
  return pairs;
}

// Fire every click handler in a rendered tree with a harmless cx and event.
export function fireClicks(root, tasks = []) {
  const walk = el => {
    for (const handler of el.handlers) handler({}, mockCx(tasks));
    for (const part of el.parts) if (part && typeof part === 'object') walk(part);
  };
  walk(root);
}

// T1: fire the clicks, then wait for every spawned task; returns the errors those tasks threw.
export async function fireClicksSettled(root) {
  const tasks = [];
  fireClicks(root, tasks);
  return (await Promise.all(tasks)).filter(error => error !== null);
}

export const sourceOf = file => readFileSync(here(file), 'utf8');
