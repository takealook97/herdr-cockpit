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

const treeRow = new Function("div", "svg", "image", "h_flex", "run", "shared", "nameElement",
  "tabIconColor", "machineConnected", "rowDisplay",
  `${rows.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\nreturn treeRow;`)(
  element, element, element, element, () => {}, () => ({}), () => "Name",
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
  const header = { kind: "space", key: "hub", name: "hub · 2", hub: true };
  const head = { kind: "pane", key: "head", name: "Review", sub: "Project", status: "working", data: {} };
  const a = render(view, header, t), b = render(view, head, t);
  assert.equal(a.style.h, 26); assert.equal(b.style.h, 24);
  assert.ok(walk(a).includes("hub")); assert.ok(walk(a).includes("2"));
  assert.ok(walk(b).includes("Review")); assert.ok(walk(b).includes("Project"));
  assert.equal(a.style.tooltip, "Head hub · Ctrl-Shift-H");
  assert.equal(b.style.tooltip, "Show in hub");
  assert.ok(!walk(b).some(n => n?.style?.border_l || n?.style?.absolute));
  a.handlers.click({}, {}); b.handlers.click({}, {});
  assert.deepEqual(selected, [header, head]);
});

test("treeChildren groups consecutive hub rows into a card", () => {
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
  assert.deepEqual(children.map(n => n.style.id), ["before", "hub-card", "after"]);
  assert.deepEqual(children[1].nodes.map(n => n.style.id), ["hub", "head-1", "head-2"]);
});
