import test from "node:test";
import assert from "node:assert/strict";
import { load, host, element, byId } from "./host.test.mjs";

function setup(p, initial) {
  const h = host(), calls = [], state = { spaces: initial };
  const menuView = load(new URL("./tree-menu.js", import.meta.url), "menuView", {
    ...h.deps, v_flex: element, props: () => p, spaces: () => state.spaces,
    run: (...args) => calls.push(args), closeOverlay: id => calls.push(["close", id]),
    openOverlay: value => calls.push(["open", value]),
    startRename: (...args) => calls.push(["rename", ...args]), nameElement: () => "editing", finishRename() {},
  });
  return { ...h, state, calls, render: () => menuView({ handle: {} }) };
}
const space = (machine, ...tabs) => ({ machine, tabs });
const tab = (id, settled = true) => ({ id, settled });

test("machine restore counts hidden tabs and re-reads only its own tabs on click", () => {
  const h = setup({ kind: "machine", id: "remote/host", current: "Remote", overlay: 7 }, [
    space("remote/host", tab("old"), tab("visible", false)), space("remote/host", tab("other")),
    space("remote", tab("foreign")), space(null, tab("local"))]);
  const menu = h.render(), button = byId(menu, "show-hidden-tabs");
  assert.deepEqual(button.nodes, ["Show hidden tabs (2)"]);
  assert.ok(byId(menu, "rename-alias"));
  h.state.spaces = [space("remote/host", tab("new"), tab("old", false)), space("remote", tab("foreign"))];
  button.handlers.click();
  assert.deepEqual(h.calls, [["tab.unsettle", { id: "new" }], ["close", 7]]);
});

test("restore is absent for local, other kinds, and machines without hidden tabs; pane actions remain", () => {
  for (const p of [{ kind: "machine", id: "local" }, { kind: "machine", id: null },
    { kind: "machine", id: "remote" }, { kind: "pane", id: "remote" }]) {
    const h = setup(p, [space("remote", tab("visible", false)), space(null, tab("local"))]);
    const menu = h.render();
    assert.equal(byId(menu, "show-hidden-tabs"), undefined);
    assert.ok(byId(menu, "rename-alias"));
    if (p.kind === "pane") {
      byId(menu, "pane-actions").handlers.click();
      assert.deepEqual(h.calls.map(c => c[0]), ["close", "open"]);
    }
  }
});
