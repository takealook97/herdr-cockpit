import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dropTab } from "./drag.js";
import { rowDisplay, machineConnected, tabIconColor } from "./model.js";
import { load, host, element as retainedElement, walk } from "./host.test.mjs";

const rows = readFileSync(new URL("./rows.js", import.meta.url), "utf8");

test("compact rows use one-line pane details and aligned indentation", () => {
  assert.match(rows, /\.h\(row\.kind === "space" && !row\.data\.parentId \? 26 : 24\)/);
  assert.match(rows, /\.pl\(2 \+ row\.depth \* 12\)/);
  assert.match(rows, /\.left\(2 \+ row\.depth \* 12\)/);
  assert.match(rows, /\.gap\(row\.kind === "pane" \? 6 : 5\)/);
  assert.match(rows, /div\(\)\.flex_none\(\)\.min_w\(0\)\.max_w_3_5\(\)\.truncate\(\)\.text_size\(12\)\.text_color\(t\.foreground\)\.child\(name\)/);
  assert.match(rows, /div\(\)\.flex_1\(\)\.min_w\(0\)\.truncate\(\)\.text_size\(11\)\.text_color\(isHead \? t\.accent : t\.dim\)/);
  assert.doesNotMatch(rows, /v_flex/);
});

test("space rows are muted and regular weight like the hub, tab rows keep foreground", () => {
  assert.match(rows, /text_size\(12\.5\)\.text_color\(t\.muted \?\? t\.dim\)\.child\(name\)/);
  assert.doesNotMatch(rows, /text_size\(12\.5\)\.font_semibold\(\)/);
  assert.match(rows, /row\.orch && view\.orchStale \? t\.dim : t\.foreground/);
});

// Render the actual row handlers with a minimal retained-element host.
function element() {
  const node = { handlers: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when" && args[0]) args[1](proxy);
      if (key === "on_click") target.handlers.click = args[0];
      if (key === "on_mouse_up") target.handlers.mouseUp = args[1];
      if (key === "on_mouse_down" && args[0] === "left") target.handlers.mouseDown = args[1];
      return proxy;
    };
  } });
  return proxy;
}

const tagCalls = [];
const treeRow = new Function("div", "svg", "image", "h_flex", "run", "shared", "nameElement", "startRename", "renameId", "headTag",
  "tabIconColor", "machineConnected", "rowDisplay",
  `${rows.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\nreturn treeRow;`)(
  element, element, element, element, () => {}, () => ({}), () => "Name", () => {}, () => null, (...a) => { tagCalls.push(a); return element(); },
  tabIconColor, machineConnected, rowDisplay);

test("drop mouse-up on a space or tab row does not also select that row", () => {
  for (const kind of ["space", "tab"]) {
    const calls = [], tab = { id: "a", index: 1 }, sibling = { id: "b", index: 2 };
    const spaces = [{ id: "source", active: true, tabs: [tab, sibling] }, { id: "target", tabs: [] }];
    const api = { spaces: () => spaces, panes: () => [{ tab: "a", terminal: "t" }],
      run: (command, args) => calls.push({ command, args }), warn: assert.fail };
    const row = kind === "space"
      ? { kind, id: "target", key: "space:target", name: "Target", data: { order: 1 } }
      : { kind, id: "b", key: "tab:b", space: "source", data: sibling };
    const view = { orchLoaded: true, tabDrag: { id: "a", space: "source" },
      select: row => api.run(`${row.kind}.select`, { id: row.id }),
      dropTab: (row, cx) => dropTab(view, row, cx, api),
      dropSpace: (row, cx) => dropTab(view, row, cx, api) };
    const cx = { notify() {}, timer: { after() {} } };
    const el = treeRow(view, row, {});
    el.handlers.mouseUp({}, cx);
    // Even after the operation clears its busy flag, the generated click is suppressed.
    view.movingTab = false;
    el.handlers.click({}, cx);
    assert.deepEqual(calls, kind === "space"
      ? [{ command: "terminal.park", args: { terminal: "t" } }]
      : [{ command: "tab.move", args: { id: "a", index: 2 } }]);
    view.suppressClickUntil = Date.now() - 1;
    el.handlers.click({}, cx);
    assert.deepEqual(calls.at(-1), { command: `${kind}.select`, args: { id: row.id } });
  }
});


test("repository section rails span every descendant without letter avatars", () => {
  assert.match(rows, /row\.sectionColorKey != null/);
  assert.match(rows, /\.left\(2 \+ row\.sectionDepth \* 12\)\.top\(0\)\.bottom\(0\)\.w\(2\)/);
  assert.match(rows, /shared\("space.colors"\)/);
  assert.doesNotMatch(rows, /toUpperCase|accent_foreground/);
  const main = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  assert.match(main, /this\.visible\[i - 1\]\?\.sectionColorKey != null && !this\.visible\[i - 1\]\?\.hub, el => el\.mt\(4\)/);
});

test('hub section and head rows select without registering drop/reorder handlers', () => {
  for (const kind of ['space', 'pane']) {
    const selected = [];
    const row = { kind, hub: true, key: `hub-${kind}`, name: 'Hub', data: {}, depth: 1 };
    const el = treeRow({ select: row => selected.push(row) }, row, {});
    assert.equal(el.handlers.mouseUp, undefined);
    el.handlers.click({}, {}); assert.deepEqual(selected, [row]);
  }
});

test('hub cannot be a drop target even when drag helpers are called directly', () => {
  const calls = [], view = { orchLoaded: true, tabDrag: { id: 'tb', space: 's' } };
  const row = { kind: 'space', hub: true, id: 'hub-entry' };
  dropTab(view, row, { notify() {} }, { spaces: () => [], panes: () => [],
    run: (...args) => calls.push(args), warn: reason => calls.push(reason) });
  assert.deepEqual(calls, ['Hub is a locked section.']);
});


test("hubRow renders a count header and a compact head row", () => {
  const h = host();
  const render = load(new URL("./rows.js", import.meta.url), "hubRow", {
    ...h.deps, svg: retainedElement, image: retainedElement, nameElement: () => {},
    tabIconColor, machineConnected, rowDisplay,
  });
  const selected = [], view = { select: row => selected.push(row) };
  const t = h.deps.theme();
  const header = { kind: "space", key: "hub", name: "hub · 2", count: 2, hub: true };
  const head = { kind: "pane", key: "head", name: "Project · Review", spaceName: "Project", tabName: "Review", sub: "Project", status: "working", data: {} };
  const a = render(view, header, t), b = render(view, head, t);
  assert.equal(a.style.h, 26); assert.equal(b.style.h, 26);
  assert.ok(walk(a).includes("HUB")); assert.ok(walk(a).includes("2"));
  assert.ok(walk(b).includes("Review")); assert.ok(!walk(b).includes("Project"));
  assert.equal(a.style.tooltip, "Head hub · Cmd-Shift-H");
  assert.equal(b.style.tooltip, "Show in hub");
  assert.ok(!walk(b).some(n => n?.style?.border_l || n?.style?.absolute));
  a.handlers.click({}, {}); b.handlers.click({}, {});
  assert.deepEqual(selected, [header, head]);
});

test("treeChildren inserts a hairline after the plain hub section", () => {
  const h = host();
  const Tree = load(new URL("./main.js", import.meta.url), "SpaceTree", {
    ...h.deps, v_flex: retainedElement, Plumbing: class {},
    hubRow: (_view, row) => retainedElement().id(row.key),
    treeRow: (_view, row) => retainedElement().id(row.key),
  });
  const tree = new Tree();
  tree.visible = [
    { key: "before", kind: "space", data: {} },
    { key: "hub", hub: true }, { key: "head-1", hub: true }, { key: "head-2", hub: true },
    { key: "after", kind: "space", data: {} },
  ];
  const children = tree.treeChildren(h.deps.theme());
  assert.deepEqual(children.map(n => n.style.id), ["before", "hub", "head-1", "head-2", "hub-divider", "after"]);
  assert.equal(children[1].style.bg, undefined);
  assert.equal(children[4].style.h, 1);
  assert.equal(children[4].style.mx, 12);
  assert.equal(children[4].style.my, 6);
  assert.equal(children[4].style.bg, "border");
});


test("hub header, status opacity and selected floating card follow v2", () => {
  const h = host(), t = h.deps.theme();
  const render = load(new URL("./rows.js", import.meta.url), "hubRow", {
    ...h.deps, svg: retainedElement, image: retainedElement, nameElement: () => {},
    tabIconColor, machineConnected, rowDisplay,
  });
  const header = render({}, { kind: "space", key: "hub", count: 3, active: true }, t);
  assert.equal(header.style.mx, 10);
  assert.equal(header.style.gap, 8);
  assert.equal(header.style.bg, undefined);
  assert.equal(header.style.hover, undefined);
  const [label, pill, rule] = header.nodes;
  assert.equal(label.style.text_size, 11);
  assert.equal(label.style.text_color, "accent");
  assert.equal(pill.style.text_color, "accent");
  assert.equal(pill.style.rounded, 8);
  assert.equal(pill.style.px, 6);
  assert.equal(rule.style.h, 1);
  assert.equal(rule.style.bg, "border");
  for (const status of ["idle", "done", "working", "blocked"]) {
    const row = render({}, { kind: "pane", key: status, status, active: true,
      spaceName: "Project", tabName: "Review" }, t);
    assert.equal(row.style.opacity, ["idle", "done"].includes(status) ? 0.62 : 1);
    assert.equal(row.style.bg, "background");
    assert.equal(row.style.border, 1);
    assert.equal(row.style.border_color, "border");
    assert.equal(row.style.rounded, 7);
    assert.equal(row.style.mx, 6);
    assert.equal(row.style.px, 8);
    assert.equal(row.nodes[0].style.size, 6);
    if (status === "idle") assert.equal(row.nodes[0].style.border_color, "dim");
    else assert.equal(row.nodes[0].style.bg, status);
    if (status === "working") assert.equal(row.nodes[0].style.loop, "opacity");
    assert.ok(!walk(row).some(n => n?.style?.absolute));
  }
});

test("only the active tab paints a selection, regardless of keyboard highlight", () => {
  const h = host(), t = h.deps.theme();
  const render = load(new URL("./rows.js", import.meta.url), "treeRow", {
    ...h.deps, svg: retainedElement, image: retainedElement, nameElement: () => "Name",
    tabIconColor, machineConnected, rowDisplay,
  });
  for (const kind of ["space", "tab", "pane"]) {
    const row = render({ highlight: "row" }, { key: "row", kind, active: true, data: {}, depth: 1 }, t);
    assert.equal(row.style.bg, kind === "tab" ? "selected" : "chrome");
    if (kind === "pane") assert.ok(!walk(row).some(n => n?.style?.absolute));
  }
});

test("ageLabel and nexus hint selection", () => {
  const { ageLabel, nexusHint } = loadRows(["ageLabel", "nexusHint"]);
  assert.equal(ageLabel(0, 12_000), "12s"); assert.equal(ageLabel(0, 180_000), "3m");
  assert.equal(ageLabel(0, 7_200_000), "2h"); assert.equal(ageLabel(10_000, 0), "0s");
  assert.equal(nexusHint(null), "⌘⇧N");
  assert.equal(nexusHint({ label: "tool · x", at: 0 }, 180_000), "→ tool · x · 3m");
});

test("nexusRow renders the label, hint and selects on click", () => {
  const h = host(), { nexusRow } = loadRows(["nexusRow"]);
  const selected = [], row = { key: "nexus-entry", nexus: true, hub: true, name: "NEXUS", active: true, last: null };
  const el = nexusRow({ select: r => selected.push(r) }, row, h.deps.theme());
  assert.equal(el.style.h, 30); assert.equal(el.style.tooltip, "Nexus · Cmd-Shift-N");
  assert.ok(walk(el).includes("NEXUS")); assert.ok(walk(el).includes("⌘⇧N"));
  el.handlers.click({}, {}); assert.deepEqual(selected, [row]);
});

function loadRows(names) {
  const h = host();
  const source = readFileSync(new URL("./rows.js", import.meta.url), "utf8");
  const deps = { ...h.deps, svg: retainedElement, image: retainedElement, nameElement: () => {}, tabIconColor, machineConnected, rowDisplay };
  const body = source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  return new Function(...Object.keys(deps), `${body}; return { ${names.join(", ")} };`)(...Object.values(deps));
}

// Head tag: rendered through the real head-tag.js with the retained-element host.
const tagModule = () => load(new URL("./head-tag.js", import.meta.url), "({ headTag, headTagTextColor, contrast })", host().deps);
const THEME = { accent: "#e8a33d", background: "#14161a" };
const renderTag = row => tagModule().headTag(row, THEME);

test("head tag is one flat pill: solid accent, a single HEAD text child, no images or layers", () => {
  const tag = renderTag({ key: "p", status: "working", data: { program: { key: "claude" } } });
  assert.deepEqual(tag.nodes, ["HEAD"]);
  assert.equal(tag.style.bg, THEME.accent);
  assert.equal(tag.style.h, 16);
  assert.equal(tag.style.text_size, 10);
  const nodes = walk(tag);
  assert.ok(!nodes.some(n => n?.style?.loop || n?.style?.absolute !== undefined));
  const source = readFileSync(new URL("./head-tag.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /image|\.png|headColor|program/);
});

test("head tag style is identical for claude and codex heads", () => {
  const codex = renderTag({ key: "p", status: "idle", data: { program: { key: "codex" } } });
  const claude = renderTag({ key: "p", status: "idle", data: { program: { key: "claude" } } });
  assert.equal(JSON.stringify(codex), JSON.stringify(claude));
});

test("HEAD text keeps 4.5:1 contrast on the accent in the bundled themes", () => {
  const { headTagTextColor, contrast } = tagModule();
  for (const name of ["asphodel", "elysium"]) {
    const { colors } = JSON.parse(readFileSync(new URL(`../../themes/${name}.json`, import.meta.url), "utf8"));
    const color = headTagTextColor(colors.accent, colors.background);
    assert.ok(contrast(color, colors.accent) >= 4.5, name);
  }
  assert.equal(headTagTextColor("#101010", "#14161a"), "#f5f5f5");
  assert.equal(headTagTextColor("accent", "#14161a"), "#14161a");
});

test("treeRow swaps the plain name for the tag only on head rows", () => {
  const row = (extra) => ({ kind: "pane", key: "k", name: "head", terminal: "t", data: {}, depth: 2, ...extra });
  const hasTag = el => { const n = tagCalls.length; treeRow({}, el, {}); return tagCalls.length > n; };
  assert.ok(hasTag(row({ head: true })));
  assert.ok(!hasTag(row({ head: false })));
  assert.ok(!hasTag(row({ head: true, name: "renamed" })));
  assert.ok(!hasTag(row({ head: true, hub: true })));
});

test("model text is accent semibold on head rows and dim on workers", () => {
  const { div, h_flex } = host().deps;
  const noop = () => {};
  const { subLabel } = load(new URL("./rows.js", import.meta.url), "({ subLabel })",
    { div, svg: div, image: div, h_flex, run: noop, shared: noop, nameElement: noop, startRename: noop, renameId: noop,
      headTag: noop, tabIconColor: noop, machineConnected: noop, rowDisplay: noop });
  const t = { accent: "#e8a33d", dim: "#888888" };
  const head = subLabel({ head: true, sub: "opus-5.5-high" }, t);
  assert.equal(head.style.text_color, "#e8a33d");
  assert.ok("font_semibold" in head.style);
  assert.deepEqual(head.nodes, ["opus-5.5-high"]);
  for (const row of [{ head: false }, { head: true, hub: true }]) {
    const dim = subLabel({ ...row, sub: "opus-5.5-high" }, t);
    assert.equal(dim.style.text_color, "#888888");
    assert.ok(!("font_semibold" in dim.style));
  }
});

test("tree pane row dot matches hub: ring when idle, pulse when working", () => {
  const h = host(), t = h.deps.theme();
  const render = load(new URL("./rows.js", import.meta.url), "treeRow", {
    ...h.deps, svg: retainedElement, image: retainedElement, nameElement: () => "Name",
    tabIconColor, machineConnected, rowDisplay,
  });
  const dotOf = status => walk(render({}, { key: "p", kind: "pane", status, data: {}, depth: 1 }, t))
    .filter(n => n?.style?.size === 6 && n.style.rounded === 3).pop();
  const idle = dotOf("idle");
  assert.equal(idle.style.border, 1); assert.equal(idle.style.border_color, "dim"); assert.equal(idle.style.bg, undefined);
  const working = dotOf("working");
  assert.equal(working.style.bg, "working"); assert.equal(working.style.loop, "opacity");
  assert.equal(dotOf("blocked").style.loop, undefined);
});

// Exercise the real press and drop handlers against a changing native list.
function spaceDragHost() {
  const h = { spaces: ['a', 'b', 'c'].map(id => ({ id, machine: null })), calls: [] };
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', {
    Plumbing: class {}, spaces: () => h.spaces, run: (...args) => h.calls.push(args),
  });
  h.view = new Tree(); h.view.dropTab = () => false;
  h.row = id => ({ kind: 'space', id, key: `space:${id}`, data: { ...h.spaces.find(s => s.id === id), order: h.spaces.findIndex(s => s.id === id) } });
  h.press = id => treeRow(h.view, h.row(id), {}).handlers.mouseDown({}, { notify() {} });
  h.drop = row => { h.view.dragOver(row, { notify() {} }); h.view.dropSpace(row, { notify() {} }); };
  return h;
}
test('space drag moves the pressed ID after external reorder, including a stale target row', () => {
  const h = spaceDragHost(), target = h.row('c'); h.press('a');
  h.spaces = [h.spaces[2], h.spaces[1], h.spaces[0]];
  h.drop(target);
  assert.deepEqual(h.calls, [['space.move', { id: 'a', index: 1 }]]);
});
test('space drag aborts for missing source, missing target, self, or changed machine boundary', () => {
  for (const change of ['source', 'target', 'self', 'machine']) {
    const h = spaceDragHost(), target = h.row(change === 'self' ? 'a' : 'c'); h.press('a');
    if (change === 'source') h.spaces.shift();
    if (change === 'target') h.spaces.pop();
    if (change === 'machine') h.spaces[2].machine = 'remote';
    assert.doesNotThrow(() => h.drop(target));
    assert.deepEqual(h.calls, [], change);
  }
});
test('space drop rechecks machine boundary after hover', () => {
  const h = spaceDragHost(), target = h.row('c'); h.press('a');
  h.view.dragOver(target, { notify() {} }); h.spaces[2].machine = 'remote';
  h.view.dropSpace(target, { notify() {} }); assert.deepEqual(h.calls, []);
});

test('space drag safely stops when the last pressed space disappears', () => {
  const h = spaceDragHost(), target = h.row('a'); h.press('c'); h.spaces.pop();
  assert.doesNotThrow(() => h.drop(target)); assert.deepEqual(h.calls, []);
});


test('same tinted Program uses muted and full-color Program keeps its image', () => {
  const t = { muted: '#999999', foreground: '#eeeeee', dim: '#606060' };
  const calls = [];
  const tagged = kind => path => { const el = retainedElement(); el.kind = kind; el.path = path; calls.push(el); return el; };
  const program = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg', tint: true };
  const h = host();
  const deps = { ...h.deps, svg: tagged('svg'), image: tagged('image'), theme: () => t };
  const draw = load(new URL('./rows.js', import.meta.url), 'treeRow', { ...deps, nameElement: () => 'Name', tabIconColor, machineConnected, rowDisplay });
  const render = program => draw({}, { kind: 'pane', key: 'p', data: { program }, depth: 1 }, t);
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
  const tagged = kind => path => { const el = retainedElement(); el.kind = kind; el.path = path; calls.push(el); return el; };
  const program = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg', tint: true };
  const h = host();
  const deps = { ...h.deps, svg: tagged('svg'), image: tagged('image'), theme: () => t };
  const draw = load(new URL('./rows.js', import.meta.url), 'treeRow', { ...deps, nameElement: () => 'Name', tabIconColor, machineConnected, rowDisplay });
  const render = program => draw({}, { kind: 'pane', key: 'p', data: { program }, depth: 1 }, t);
  for (const program of [null, { key: 'program', icon: null }]) {
    const root = render(program);
    const fallback = walk(root).find(n => n?.nodes?.includes('›_'));
    assert.ok(fallback);
    assert.equal(fallback.style.text_color, t.muted);
    assert.equal(fallback.style.size, 14);
  }
});


test('space press expires after 10 seconds and a fresh press replaces it', t => {
  const now = 100000; t.mock.method(Date, 'now', () => now);
  const h = spaceDragHost(); h.press('a');
  t.mock.method(Date, 'now', () => now + 11000);
  h.drop(h.row('c')); assert.deepEqual(h.calls, []);
  assert.equal(h.view.pressed, null);
  h.press('a');
  t.mock.method(Date, 'now', () => now + 22000);
  h.press('b'); h.drop(h.row('c'));
  assert.deepEqual(h.calls, [['space.move', { id: 'b', index: 3 }]]);
});
test('new space press clears an old press even when a tab move blocks it', () => {
  const h = spaceDragHost(); h.press('a'); h.view.movingTab = true;
  h.press('b'); assert.equal(h.view.pressed, null); assert.equal(h.view.over, null);
  h.drop(h.row('c')); assert.deepEqual(h.calls, []);
});

test('leaving the tree container clears a pending space press', async () => {
  const { clearDrag } = await import('./drag.js');
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', {
    Plumbing: class {}, div: retainedElement, svg: retainedElement,
    h_flex: retainedElement, v_flex: retainedElement, props: () => ({}),
    theme: () => ({}), buildTree: () => [], shared: () => ({}),
    assignSectionColors: () => ({}), SECTION_PALETTE: [], clearDrag,
  });
  const view = new Tree(); view.inputs = () => ({}); view.treeChildren = () => [];
  view.pressed = { id: 'a', at: Date.now() }; view.over = 'b';
  const root = view.render(); root.style.on_hover(false, { notify() {} });
  assert.equal(view.pressed, null); assert.equal(view.over, null);
});
