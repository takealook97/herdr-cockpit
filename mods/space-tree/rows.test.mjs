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
  assert.match(rows, /div\(\)\.flex_1\(\)\.min_w\(0\)\.truncate\(\)\.text_size\(11\)\.text_color\(t\.dim\)\.child\(row\.sub\)/);
  assert.doesNotMatch(rows, /v_flex/);
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
const tagHost = () => { const h = host(); return { h, t: h.deps.theme() }; };
const tagModule = () => load(new URL("./head-tag.js", import.meta.url), "({ headTag, headColor, withAlpha, mixColor })",
  host().deps);
const { headColor, withAlpha, mixColor } = tagModule();
const renderTag = (row, t) => tagModule().headTag(row, t);

test("head rows render a HEAD tag without a glyph", () => {
  const { t } = tagHost();
  const tag = renderTag({ key: "p", status: "idle", data: { program: { key: "claude" } } }, t);
  const nodes = walk(tag);
  assert.ok(nodes.includes("HEAD"));
  assert.ok(!nodes.some(n => n?.style?.size === 11));
  assert.ok(!nodes.some(n => n?.style?.loop));
});

test("sheen child exists only while the head is working", () => {
  const { t } = tagHost();
  const idle = walk(renderTag({ key: "p", status: "idle", data: {} }, t));
  const busy = walk(renderTag({ key: "p", status: "working", data: {} }, t));
  assert.equal(idle.filter(n => n?.style?.loop).length, 0);
  assert.equal(busy.filter(n => n?.style?.loop).length, 1);
});

test("head color follows the program family", () => {
  const t = { ansi1: "#d00000", ansi3: "#00d000", ansi4: "#4080d0", accent: "#00ff00" };
  assert.equal(mixColor("#d00000", "#00d000"), "#686800");
  assert.equal(headColor({ key: "claude" }, t), "#686800");
  assert.equal(headColor({ name: "Codex" }, t), "#4080d0");
  assert.equal(headColor({ name: "bash" }, t), "#00ff00");
  assert.equal(withAlpha("#abc", 0.5), "#aabbcc80");
  assert.equal(withAlpha("#102030", 1), "#102030ff");
});

test("HEAD label keeps 4.5:1 contrast on the tinted tag in the bundled themes", () => {
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const lum = c => { const [r, g, b] = c.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const mix = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k);
  for (const name of ["asphodel", "elysium"]) {
    const theme = JSON.parse(readFileSync(new URL(`../../themes/${name}.json`, import.meta.url), "utf8"));
    const t = { ...theme.colors, ansi1: theme.ansi[1], ansi3: theme.ansi[3], ansi4: theme.ansi[4] };
    for (const program of [{ key: "claude" }, { key: "codex" }]) {
      // base 0.2 + gloss 0.2 stacked is the strongest tint behind the text.
      const tint = rgb(headColor(program, t));
      const bg = mix(mix(rgb(t.chrome), tint, 0.2), tint, 0.2);
      const [hi, lo] = [lum(rgb(t.foreground)), lum(bg)].sort((a, b) => b - a);
      assert.ok((hi + 0.05) / (lo + 0.05) >= 4.5, `${name} ${program.key}`);
    }
  }
});

test("treeRow swaps the plain name for the tag only on head rows", () => {
  const row = (extra) => ({ kind: "pane", key: "k", name: "head", terminal: "t", data: {}, depth: 2, ...extra });
  const hasTag = el => { const n = tagCalls.length; treeRow({}, el, {}); return tagCalls.length > n; };
  assert.ok(hasTag(row({ head: true })));
  assert.ok(!hasTag(row({ head: false })));
  assert.ok(!hasTag(row({ head: true, name: "renamed" })));
  assert.ok(!hasTag(row({ head: true, hub: true })));
});
