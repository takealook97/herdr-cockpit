import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, machines, panes, terminals, run, exec, shared, setShared, theme, openOverlay, nextCommand, props, notify } from "herdr";
import Plumbing from "./plumbing.js";
import Hub from "./hub.js";
import { mergeHuds } from "./hub-model.js";
import { buildTree, aliasKey, machineId, rowId, pruneFolded, assignSectionColors } from "./model.js";
import { clearDrag, beginTabDrag, hoverTabTarget, dropTab } from "./drag.js";
import { treeRow, hubRow } from "./rows.js";
import { initRename, startRename, finishRename, renameId } from "./rename.js";
import { menuView } from "./tree-menu.js";

export default class SpaceTree extends Plumbing {
  init(p, cx) {
    this.handle = cx.focus_handle();
    initRename(this);
    if (props()?.treeMenu) { this.handle.focus(); return; }
    super.init(p, cx);
    try { this.treeFolded = JSON.parse(localStorage.getItem("tree.folded") ?? "{}"); } catch { this.treeFolded = {}; }
    this.orch = {};
    this.lastModel = {};
    this.orchStale = false;
    this.orchLoaded = false;
    this.highlight = null;
    this.hub = new Hub();
    this.hub.init(p, cx);
    this.refreshOrch(cx);
    cx.timer.every(3000, cx => this.refreshOrch(cx));
    cx.timer.every(60000, cx => this.prune(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command == null || this.closed) break;
        try {
          if (command === "focus") this.handle.focus();
          else if (command === "hub") this.hub.toggle(cx);
          else if (command === "hub-close") this.hub.hide(cx);
          else if (["go-left", "go-right", "go-up", "go-down"].includes(command)) this.hub.go(command.slice(3));
          else if (command === "zoom") this.hub.zoom(cx);
          else if (command === "source") this.hub.source(cx);
        } catch (error) { notify({ title: "hub", body: String(error), level: "error" }); }
        cx.notify();
      }
    });
  }

  refreshOrch(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async cx => {
      const names = [...new Set([null, ...machines().map(m => m.name), ...spaces().map(s => s.machine ?? null)])];
      const results = await Promise.all(names.map(async machine => {
        try {
          const r = await exec("sh", ["-c", 'exec "$HOME/.local/bin/herdr-hud" "$@"', "hud", "panes"], { on: machine || undefined });
          if (r.code !== 0) throw new Error("hud unavailable");
          const data = JSON.parse(r.stdout);
          if (data.error || !Array.isArray(data.runs) || !Array.isArray(data.terminals)) throw new Error("bad hud data");
          this.hub.snapshots.set(machine, { machine, data });
          return true;
        } catch { return false; }
      }));
      for (const machine of this.hub.snapshots.keys()) if (!names.includes(machine)) this.hub.snapshots.delete(machine);
      const data = mergeHuds([...this.hub.snapshots.values()]);
      for (const info of data.runs.flatMap(run => run.workers ?? [])) {
        if (info.terminal && info.model && !this.lastModel[info.terminal]?.model)
          this.lastModel[info.terminal] = { model: info.model, effort: info.effort };
      }
      for (const info of data.terminals) {
        if (info.address && info.model) this.lastModel[info.address] = { model: info.model, effort: info.effort };
      }
      data.lastModel = this.lastModel;
      this.orch = data;
      this.orchStale = results.some(ok => !ok);
      this.orchLoaded = this.orchLoaded || results.some(Boolean);
      setShared("hub.stale", this.orchStale);
      this.hub.sync(cx);
      this.polling = false;
      cx.notify();
    });
  }

  inputs() {
    const sp = this.ordered(), ps = panes(), aliases = {};
    const ms = [...machines()];
    for (const m of this.machines) if (!ms.some(k => k.name === m.name)) ms.push({ ...m, layout: "unavailable" });
    for (const m of [null, ...ms.map(m => m.name)]) {
      const key = aliasKey("machine", m ?? "local"); aliases[key] = shared(key);
    }
    for (const p of ps) if (p.terminal) {
      const key = aliasKey("pane", p.terminal); aliases[key] = shared(key);
    }
    const core = new Map(terminals().map(t => [t.address, t]));
    const orch = { ...this.orch, terminals: (this.orch.terminals ?? []).map(t => ({ ...core.get(t.address), ...t })) };
    return { machines: ms, spaces: sp, panes: ps, orch, aliases,
      hub: { heads: this.hub.heads, active: this.hubActive(), terminal: this.hub.focusedTerminal() },
      activeSpaceId: spaces().find(s => s.active)?.id };
  }

  liveKeys(input) {
    return ["hub-entry", machineId(null), ...input.machines.map(m => machineId(m.name)),
      ...input.spaces.flatMap(e => [rowId("space", e.w.id), ...(e.w.tabs ?? []).map(t => rowId("tab", t.id))]),
      ...input.panes.map(p => rowId("pane", p.pane))];
  }
  saveFold(cx) {
    localStorage.setItem("tree.folded", JSON.stringify(this.treeFolded));
    cx.notify();
  }
  toggle(row, cx, open = !row.open) {
    if (!row.foldable) return;
    this.treeFolded[row.key] = !open;
    this.highlight = row.key;
    this.handle.focus(); this.saveFold(cx);
  }
  foldAll(closed, cx) {
    for (const key of this.liveKeys(this.inputs())) if (!key.startsWith("pane:")) this.treeFolded[key] = closed;
    this.handle.focus(); this.saveFold(cx);
  }

  prune(cx) {
    const input = this.inputs();
    // Offline machines may return their spaces; only prune when layouts are ready.
    if (input.machines.every(m => m.layout === "ready")) {
      this.treeFolded = pruneFolded(this.treeFolded, this.liveKeys(input));
      this.saveFold(cx);
    }
    const known = shared("space-tree.alias.pane.keys") ?? [];
    const live = new Set(terminals().map(t => t.address));
    const kept = [];
    for (const address of known) {
      const remote = input.machines.filter(m => m.name && address.startsWith(`${m.name}/`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      const unavailable = remote ? remote.layout !== "ready" : address.includes("/");
      if (live.has(address) || unavailable) kept.push(address);
      else setShared(aliasKey("pane", address), null);
    }
    if (kept.length !== known.length) setShared("space-tree.alias.pane.keys", kept);
    const storedMachines = shared("space-tree.alias.machine.keys") ?? [];
    // Enroll aliases created before the machine-key registry was introduced.
    const machineKeys = [...new Set([...storedMachines, ...input.machines
      .map(m => m.name ?? "local").filter(name => shared(aliasKey("machine", name)))])];
    const liveMachines = new Set(["local", ...machines().map(m => m.name)]);
    const keptMachines = machineKeys.filter(name => {
      if (liveMachines.has(name)) return true;
      setShared(aliasKey("machine", name), null);
      return false;
    });
    if (JSON.stringify(keptMachines) !== JSON.stringify(storedMachines)) setShared("space-tree.alias.machine.keys", keptMachines);
  }

  close() { this.closed = true; this.hub?.close(); this.input?.release(); }

  hubActive() { return this.hub?.active() ?? false; }
  select(row, cx) {
    if (this.editing || this.movingTab) return;
    if (row.hub) { this.hub.open(cx, row.terminal); return; }
    if (["space", "tab", "pane"].includes(row.kind)) this.hub.hide(cx);
    this.highlight = row.key; this.handle.focus();
    if (row.kind === "space" || row.kind === "tab") run(`${row.kind}.select`, { id: row.id });
    if (row.kind === "pane") run("pane.focus", { pane: row.id });
    cx.notify();
  }
  contextMenu(row) {
    if (row.hub) return;
    if (row.kind === "space") return this.menu({ id: row.id });
    if (row.kind === "tab") return openOverlay({ mod: "menu", kind: "popup", width: 200,
      props: { tab: "tab", target: { id: row.id, space: row.space } } });
    openOverlay({ mod: "space-tree", kind: "popup", width: 200,
      props: { treeMenu: true, kind: row.kind, id: renameId(row), current: row.name,
        target: { pane: row.id, terminal: row.terminal } } });
  }
  beginTabDrag(row, cx) { beginTabDrag(this, row, cx, this.dragApi()); }
  hoverTabTarget(row, cx) { hoverTabTarget(this, row, cx, this.dragApi()); }
  dragApi() {
    return { run, spaces, panes,
      warn: body => notify({ title: "Cannot move tab", body, level: "warning", timeout: 5000 }),
      notice: body => notify({ title: "Tab moved", body, level: "info", timeout: 5000 }) };
  }
  dropTab(row, cx) { return dropTab(this, row, cx, this.dragApi()); }
  dragOver(row, cx) {
    if (this.tabDrag) { this.hoverTabTarget(row, cx); return; }
    const source = spaces()[this.pressed];
    const over = source && (source.machine ?? null) === (row.data.machine ?? null) ? row.data.order : null;
    if (this.pressed !== null && this.over !== over) { this.over = over; cx.notify(); }
  }
  dropSpace(row, cx) {
    if (this.dropTab(row, cx)) return;
    const from = this.pressed, over = this.over, i = row.data.order;
    this.pressed = null; this.over = null;
    if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
    cx.notify();
  }
  key(e, cx) {
    if (e.key === "escape" && this.tabDrag) { clearDrag(this, cx); cx.stop_propagation(); return; }
    if (this.editing) {
      if (e.key === "escape") { finishRename(this, cx, true); cx.stop_propagation(); }
      return;
    }
    const rows = this.visible ?? [], at = Math.max(0, rows.findIndex(r => r.key === this.highlight)), row = rows[at];
    if (!row) return;
    if (e.key === "up" || e.key === "down") {
      this.highlight = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "up" ? -1 : 1)))].key;
    } else if (e.key === "left" || e.key === "right") this.toggle(row, cx, e.key === "right");
    else if (e.key === "enter") this.select(row, cx);
    else if (e.key === "f2" && !row.hub && renameId(row) != null) startRename(this, row.kind, renameId(row), row.data?.named ? row.data.name : row.name, cx, row.data?.named);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  render() {
    this.hub?.render();
    if (props()?.treeMenu) return menuView(this);
    const t = theme(), input = this.inputs();
    this.visible = buildTree({ ...input, folded: this.treeFolded });
    if (!this.visible.some(r => r.key === this.highlight)) this.highlight = this.visible.find(r => r.active)?.key ?? this.visible[0]?.key;
    const stored = shared("space.colors") ?? {};
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "ansi14", "ansi11", "ansi12", "ansi13"];
    const sectionIds = buildTree({ ...input, folded: {} }).filter(row => row.kind === "space" && !row.hub && row.sectionColorKey === row.id && row.name !== "~").map(row => row.id);
    const colors = assignSectionColors(sectionIds, stored, palette);
    if (JSON.stringify(colors) !== JSON.stringify(stored)) setShared("space.colors", colors);
    const button = (id, icon, label, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center()
      .rounded(4).tooltip(label).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(svg(`mods/space-tree/${icon}.svg`).size(12));
    return v_flex().id("space-tree").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.chrome).text_size(12)
      .on_hover((hovered, cx) => { if (!hovered) clearDrag(this, cx); })
      .on_mouse_up("left", (_e, cx) => clearDrag(this, cx))
      .child(h_flex().h(30).flex_none().pl(12).pr(8).items_center().text_color(t.muted)
        .child(div().flex_1().child("Spaces"))
        .when(this.orchStale, el => el.child(div().text_size(10).text_color(t.dim).tooltip("herdr-hud unavailable; retaining last data").child("⚠")))
        .child(button("expand-all", "chevron-down", "Expand all", (_e, cx) => this.foldAll(false, cx)))
        .child(button("collapse-all", "chevron-up", "Collapse all", (_e, cx) => this.foldAll(true, cx)))
        .child(button("new-space", "plus", "New space", () => run("space.new"))))
      .child(v_flex().id("tree-list").flex_1().min_h(0).px(4).pb(10).overflow_y_scroll()
        .children(this.treeChildren(t)));
  }

  // Hub rows sit directly in the list, followed by a hairline divider.
  treeChildren(t) {
    const out = [];
    this.visible.forEach((row, i) => {
      if (row.hub) {
        out.push(hubRow(this, row, t));
        if (!this.visible[i + 1]?.hub) out.push(div().id("hub-divider").mx(12).my(6).h(1).bg(t.border));
        return;
      }
      out.push(treeRow(this, row, t)
        .when(row.kind === "space" && !row.data.parentId && this.visible[i - 1]?.sectionColorKey != null && !this.visible[i - 1]?.hub, el => el.mt(4)));
    });
    return out;
  }
}
