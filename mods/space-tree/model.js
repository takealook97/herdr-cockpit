export const tabIconColor = (status, active) => active ? "foreground" : status === "working" || status === "blocked" ? status : "muted";

export const aggregateStatus = statuses => ["blocked", "working", "done", "idle"]
  .find(status => statuses.includes(status)) ?? "idle";

export const hubRowStatus = (head, panes) => aggregateStatus(
  panes.filter(pane => pane.tab === head.tab).map(pane => pane.status));
export const machineConnected = (row, machine) => row.id == null || machine?.state === "connected" || row.data.layout === "ready";
export const rowDisplay = (row, connected = true, hovered = false) => ({
  dot: row.kind === "pane" || (row.kind === "machine" ? !connected : !row.open),
  count: row.kind === "tab" && !row.open && row.count >= 2 ? `· ${row.count}` : "",
  add: row.kind === "machine" && connected && hovered,
});

// Pure tree projection. Git ordering/linked parent information comes from spaces.
export const machineId = name => `machine:${name ?? ""}`;
export const rowId = (kind, id) => `${kind}:${id}`;
export const aliasKey = (kind, id) => `space-tree.alias.${kind}.${id}`;

// Deep jewel tones for the space rails: moderate saturation, readable on the dark chrome.
export const SECTION_PALETTE = ["#1f8f86", "#4f5ad8", "#7c4fe0", "#c43d55", "#b9791a",
  "#2a9462", "#4a76ab", "#a1488e", "#1a7f9a", "#b4532f"];

// Stored palette colors never change, even when two spaces share one. Only spaces without a valid
// stored color (new spaces, old theme keys) get a random pick among the least used palette colors.
export function assignSectionColors(orderedSpaceIds, stored = {}, palette = SECTION_PALETTE, random = Math.random) {
  const colors = { ...stored }, counts = new Map(palette.map(c => [c, 0]));
  const fresh = [];
  for (const id of orderedSpaceIds) {
    if (palette.includes(colors[id])) counts.set(colors[id], counts.get(colors[id]) + 1);
    else fresh.push(id);
  }
  for (const id of fresh) {
    const least = Math.min(...counts.values());
    const pool = palette.filter(c => counts.get(c) === least);
    const color = pool[Math.floor(random() * pool.length)];
    if (color == null) continue;
    colors[id] = color;
    counts.set(color, least + 1);
  }
  return colors;
}

export function orchIndexes(orch = {}) {
  const workers = {}, heads = {}, tabs = {}, workspaces = new Set();
  for (const run of orch.runs ?? []) {
    if (run.workspace) workspaces.add(run.workspace);
    if (run.head_terminal) heads[run.head_terminal] = run;
    for (const w of run.workers ?? []) if (w.terminal) workers[w.terminal] = w;
    if (run.tab) tabs[run.tab] = true;
  }
  return { workers, heads, tabs, workspaces, enabled: orch.orch === true, lastModel: orch.lastModel ?? {},
    terminals: Object.fromEntries((orch.terminals ?? []).map(t => [t.address, t])) };
}

export const isHeadPane = (pane, orchIndex = {}) =>
  !!(orchIndex.heads?.[pane.terminal] || (orchIndex.enabled && orchIndex.terminals?.[pane.terminal]));
const programName = pane => pane.program?.name || pane.app || pane.mod || "Terminal";
export function paneName(pane, indexInTab = 0, orchIndex = {}, aliases = {}) {
  const alias = aliases[aliasKey("pane", pane.terminal)];
  if (alias) return alias;
  const worker = orchIndex.workers?.[pane.terminal];
  if (worker) return (worker.label || worker.name || "worker").toLowerCase();
  // Only active runs identify heads; vanilla panes retain program names.
  if (isHeadPane(pane, orchIndex)) return "head";
  return programName(pane).toLowerCase();
}

export function paneSub(pane, orchIndex = {}, indexInTab = 0) {
  const worker = orchIndex.workers?.[pane.terminal];
  const terminal = orchIndex.terminals?.[pane.terminal];
  // Session-resolved terminal metadata wins over the worker launch catalog.
  const last = orchIndex.lastModel?.[pane.terminal];
  const program = pane.program;
  const nonAgent = program?.shell || program?.agent === false ||
    ["shell", "program", "zsh", "bash", "sh", "fish"].includes(program?.key?.toLowerCase()) ||
    /(?:^|\/)(?:shell|program)\.svg$/i.test(program?.icon ?? "");
  const usable = info => info?.model && !nonAgent && info.programKey === program?.key;
  const info = usable(terminal) ? terminal : usable(last) ? last : usable(worker) ? worker : null;
  const model = info?.model ? [info.model, info.effort].filter(Boolean).join("-").replace(/\s+/g, "-") : "";
  // Status is the row's colored dot; the text line carries only the model or the pane's position.
  return (model || (indexInTab === 0 ? "main" : `sub ${indexInTab}`)).toLowerCase();
}

// Remote ids keep the complete machine prefix (machine names may contain '/').
const idOf = value => typeof value === "string" ? value : value?.id;
const machinePrefix = value => {
  const id = idOf(value) ?? "";
  return id.slice(0, Math.max(0, id.lastIndexOf("/")));
};
export function canMoveTab({ tab, panes = [], orchIndex = {}, fromSpace, toSpace, sourceOnly = false }) {
  const id = idOf(tab), from = idOf(fromSpace), to = idOf(toSpace);
  const refuse = reason => ({ ok: false, reason });
  if (!id || !from || !to) return refuse("The tab or space is no longer available.");
  if (orchIndex.tabs?.[id]) return refuse("Tabs hosting an active orch run cannot be moved.");
  const ps = panes.filter(p => p.tab === id);
  if (ps.some(p => orchIndex.workers?.[p.terminal])) return refuse("Tabs containing orch worker terminals cannot be moved.");
  if (ps.some(p => !p.terminal)) return refuse("Tabs containing mod panes cannot be moved.");
  if (!ps.length) return refuse("The tab has no terminal panes to move.");
  if (sourceOnly) return { ok: true };
  if (from === to) return refuse("The tab is already in this space.");
  if (machinePrefix(from) !== machinePrefix(to)) return refuse("Tabs cannot be moved between machines.");
  return { ok: true };
}
export function moveTabPlan(tab, panes, toSpaceId) {
  const terminals = panes.filter(p => p.tab === idOf(tab)).map(p => p.terminal);
  return [
    ...terminals.map(terminal => ({ command: "terminal.park", args: { terminal } })),
    { command: "space.select", args: { id: toSpaceId } },
    ...terminals.map((terminal, i) => ({ command: "terminal.keep", args: { terminal, place: i ? "right" : "tab" } })),
  ];
}

// Actions omit the target id so callers can attach their space/tab id or alias key.
export function renameAction(kind, original, value, named = false) {
  const name = value.trim();
  // Original is the prefilled custom name (named), alias, or displayed auto name.
  // An untouched auto name must remain automatic, just like an untouched custom name.
  if (name === original) return null;
  if (kind === "space" || kind === "tab") return { command: `${kind}.rename`, args: { name } };
  return { alias: kind, value: name || null };
}

// true means folded. Explicit stored values always override these defaults.
// Everything starts open; only a fold the user made is remembered.
export function foldDefault(_kind, _id, _activeSpaceId) {
  return false;
}
export function pruneFolded(folded = {}, liveIds) {
  const live = new Set(liveIds);
  return Object.fromEntries(Object.entries(folded).filter(([id]) => live.has(id)));
}

export function buildTree({ machines = [], spaces = [], panes = [], orch = {}, aliases = {},
  folded = {}, activeSpaceId, hub, nexus } = {}) {
  activeSpaceId ??= spaces.map(e => e.w ?? e).find(s => s.active)?.id;
  const index = orchIndexes(orch), result = [];
  // Accept shipped ordered() entries ({w,i,g,tree}) or explicit {parentId}.
  let parent = null;
  const entries = spaces.map((entry, i) => {
    const s = entry.w ?? entry;
    if (!entry.tree) parent = s.id;
    return { ...s, git: entry.g ?? s.git, order: entry.i ?? i,
      parentId: s.parentId ?? (entry.tree ? parent : null), tree: entry.tree };
  });
  const names = [null, ...new Set([...machines.map(m => m.name), ...entries.map(s => s.machine)]
    .filter(name => name != null))].sort((a, b) => a === null ? -1 : b === null ? 1 : a.localeCompare(b));
  const emit = (kind, id, depth, fields) => {
    const key = fields.key ?? (fields.hub ? "hub-entry" : kind === "machine" ? machineId(id) : rowId(kind, id));
    const row = { kind, id, key, depth, guide: "", foldable: kind !== "pane",
      open: !(folded[key] ?? foldDefault(kind, id, activeSpaceId)), ...fields };
    result.push(row); return row;
  };
  const childrenOf = s => entries.filter(c => c.parentId === s.id);
  const visible = (s, visiting = new Set()) => {
    if (visiting.has(s)) return false;
    const tabs = s.tabs ?? [];
    if (s.machine == null || !tabs.length || tabs.some(tab => !tab.settled)) return true;
    const next = new Set(visiting).add(s);
    return childrenOf(s).some(child => visible(child, next));
  };
  const addSpace = (s, depth, guide = "", sectionColorKey = s.id, sectionDepth = depth, ancestors = new Set()) => {
    if (ancestors.has(s)) return;
    const next = new Set(ancestors).add(s);
    const tabStatus = tab => {
      const ps = panes.filter(p => p.tab === tab.id);
      return aggregateStatus(ps.length ? ps.map(p => p.status) : [tab.status]);
    };
    const statuses = (s.tabs ?? []).map(tabStatus);
    const row = emit("space", s.id, depth, { sectionColorKey, sectionDepth, name: s.name, status: aggregateStatus(statuses.length ? statuses : [s.status]), guide,
      active: s.id === activeSpaceId, data: s });
    const children = childrenOf(s).filter(child => !next.has(child) && visible(child, next));
    const tabs = row.open ? (s.tabs ?? []).filter(tab => s.machine == null || !tab.settled) : [];
    tabs.forEach((tab, ti) => {
      const ps = panes.filter(p => p.tab === tab.id);
      const tr = emit("tab", tab.id, depth + 1, { sectionColorKey, sectionDepth, name: tab.name, data: tab, space: s.id,
        guide: ti === tabs.length - 1 && !children.length ? "└" : "├", count: ps.length,
        status: tabStatus(tab), active: !hub?.active && !!tab.active && s.id === activeSpaceId });
      if (!tr.open) return;
      ps.forEach((pane, pi) => emit("pane", pane.pane, depth + 2, { sectionColorKey, sectionDepth,
        name: paneName(pane, pi, index, aliases), head: isHeadPane(pane, index) && !index.workers[pane.terminal], sub: paneSub(pane, index, pi),
        orch: !!(index.workers[pane.terminal] || index.heads[pane.terminal]),
        data: pane, terminal: pane.terminal, status: pane.status, active: !!pane.focused && s.id === activeSpaceId,
        guide: pi === ps.length - 1 ? "└" : "├" }));
    });
    children.forEach((child, i) => addSpace(child, depth + 1, i === children.length - 1 ? "└" : "├", sectionColorKey, sectionDepth, next));
  };
  names.forEach(name => {
    const data = machines.find(m => (m.name ?? null) === name) ?? { name, layout: "ready" };
    const row = emit("machine", name, 0, { name: aliases[aliasKey("machine", name ?? "local")] || name || "This computer", data });
    if (row.open) {
      if (name === null && hub) {
        emit("space", "nexus-entry", 1, { hub: true, nexus: true, key: "nexus-entry", name: "NEXUS", data: {},
          foldable: false, active: !!nexus?.open, last: nexus?.last ?? null, sectionColorKey: "nexus", sectionDepth: 1 });
        emit("space", "hub-entry", 1, { hub: true, name: `hub · ${hub.heads?.length ?? 0}`, count: hub.heads?.length ?? 0, data: {}, foldable: false,
          active: !!hub.active, sectionColorKey: "hub", sectionDepth: 1 });
        for (const head of hub.heads ?? []) emit("pane", `hub:${head.address}`, 2, { hub: true,
          key: `hub-head:${head.address}`, name: `${head.spaceName || "Space"} · ${head.tabName || "Terminal"}`,
          spaceName: head.spaceName || "Space", tabName: head.tabName || "Terminal",
          sub: "", terminal: head.address,
          data: panes.find(p => p.terminal === head.address) ?? {}, status: hubRowStatus(head, panes),
          foldable: false, active: !!hub.active && hub.terminal === head.address, sectionColorKey: "hub", sectionDepth: 1 });
      }
      entries.filter(s => (s.machine ?? null) === name && !s.parentId && visible(s)).forEach(s => addSpace(s, 1));
    }
  });
  return result;
}
