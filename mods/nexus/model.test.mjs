import test from "node:test";
import assert from "node:assert/strict";
import { buildRoster, logLines, parseReply, dotHeights, helperArgs } from "./model.js";

test("buildRoster uses cwd basename, caps the report and tolerates missing panes", () => {
  const long = "x".repeat(200);
  const roster = buildRoster(
    [{ address: "t1", spaceName: "tool", tabName: "ontology" }, { address: "t2", spaceName: "a", tabName: "b" },
      { address: "r/t3" }, { spaceName: "no address" }],
    [{ terminal: "t1", cwd: "/Users/me/work/ontology/", status: "working" }],
    [{ address: "t1", model: "opus-5.5", report: { text: long } }, { address: "t2", report: "  done\n now " }]);
  assert.equal(roster.length, 2);
  assert.deepEqual(roster[0], { address: "t1", space: "tool", tab: "ontology", cwd: "ontology",
    status: "working", model: "opus-5.5", report: "x".repeat(80) });
  assert.equal(roster[1].cwd, ""); assert.equal(roster[1].report, "done now"); assert.equal(roster[1].status, "idle");
  assert.deepEqual(buildRoster(), []);
});

test("logLines maps each action to its marker", () => {
  const lines = logLines([
    { text: "a", action: "send", label: "tool · x" }, { text: "b", action: "ask", question: "which?" },
    { text: "c", action: "read", summary: "sum" }, { text: "d", action: "error", error: "boom" }]);
  assert.deepEqual(lines.map(l => l.kind), [">", "→", ">", "?", ">", "·", ">", "!"]);
  assert.deepEqual(lines.filter(l => l.kind !== ">").map(l => l.text), ["tool · x", "which?", "sum", "boom"]);
});

test("parseReply returns an error object for bad JSON", () => {
  assert.equal(parseReply('{"action":"send"}').action, "send");
  for (const bad of ["", "nope", "[1]", "null"]) {
    const r = parseReply(bad); assert.equal(r.action, "error"); assert.ok(r.error);
  }
});

test("dotHeights clamps levels and pads to five", () => {
  assert.deepEqual(dotHeights([]), [4, 4, 4, 4, 4]);
  assert.deepEqual(dotHeights([1]), [4, 4, 4, 4, 18]);
  assert.deepEqual(dotHeights([2, -1, 0.5, 0, 0, 1]), [4, 11, 4, 4, 18]);
});

test("helperArgs builds the D15 argv", () => {
  const roster = [{ address: "t1" }];
  const base = ["-c", 'exec "$HOME/.local/bin/herdr-hud" "$@"', "hud", "nexus"];
  assert.deepEqual(helperArgs("route", { text: "hi", roster }), [...base, "route", "--text", "hi", "--roster", JSON.stringify(roster)]);
  assert.deepEqual(helperArgs("send", { to: "t1", text: "-x", roster }), [...base, "send", "--to", "t1", "--text", "-x", "--roster", JSON.stringify(roster)]);
  assert.deepEqual(helperArgs("log"), [...base, "log", "--limit", "6"]);
  assert.deepEqual(helperArgs("listen", { action: "status" }), [...base, "listen", "status"]);
  assert.throws(() => helperArgs("bogus"));
});
