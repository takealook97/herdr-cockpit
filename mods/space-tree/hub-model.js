// Labels are authoritative; argv fallback supports older herdr-hud versions.
export function observerFor(info = {}) {
  const label = info.labels?.['hub.observer'];
  if (typeof label === 'string') return label;
  const argv = info.argv ?? [];
  if (Array.isArray(argv) && argv.includes('attach') && argv.includes('--observe'))
    return argv.at(-1) ?? '';
  return null;
}

export function hubSpace(spaces = [], remembered) {
  const local = spaces.filter(s => !s.machine);
  return local.find(s => s.id === remembered) ?? local.find(s => s.name === 'hub');
}

// HUD terminals are agent-only. Keep full remote addresses and exclude all workers.
export function headsFrom(hud = {}, panes = [], spaces = [], hubId) {
  const workers = new Set((hud.runs ?? []).flatMap(r => (r.workers ?? []).map(w => w.terminal)));
  const agents = new Map((hud.terminals ?? []).filter(t => observerFor(t) === null).map(t => [t.address, t]));
  const seen = new Set(), heads = [];
  for (const space of spaces) {
    if (space.id === hubId) continue;
    const tabs = [...(space.tabs ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const tab of tabs) for (const pane of panes.filter(p => p.tab === tab.id)) {
      const address = pane.terminal, info = agents.get(address);
      if (!address || seen.has(address) || !info || workers.has(address) || observerFor(pane) !== null) continue;
      seen.add(address);
      heads.push({ address, tabName: tab.name, spaceName: space.name, status: pane.status ?? 'idle',
        machine: space.machine ?? null, space: space.id, tab: tab.id, model: info.model, effort: info.effort });
    }
  }
  return heads;
}

// Only hubPanes may become destructive actions. Callers supply the hub tab's panes.
export function planHub({ heads = [], hubPanes = [], observers = [] } = {}) {
  const wanted = new Set(heads.map(h => typeof h === 'string' ? h : h.address));
  const info = new Map(observers.map(t => [t.address ?? t.terminal, t]));
  const present = new Set(), remove = [], seeds = [];
  for (const pane of hubPanes) {
    if (!pane.terminal) continue;
    const target = observerFor(info.get(pane.terminal) ?? pane);
    if (target === null) { seeds.push(pane.terminal); continue; }
    if (!wanted.has(target) || present.has(target)) remove.push(pane.terminal);
    else present.add(target);
  }
  return { add: [...wanted].filter(address => !present.has(address)), remove,
    ...(present.size && seeds.length ? { killSeed: seeds[0] } : {}) };
}

export const observerArgs = (space, tab, address) => [
  'run', '--keep', '--bg', '--json', '--no-parent',
  '--label', `herdr.space=${space}`, '--label', `herdr.tab=${tab}`,
  '--label', `hub.observer=${address}`, '--', 'hc', 'attach', '--observe', '--history', '2000', address,
];

// Poll each machine's local helper. Only unqualified addresses gain a prefix.
export function mergeHuds(snapshots) {
  const qualify = (machine, address) => !address || !machine || address.includes('/') ? address : `${machine}/${address}`;
  return {
    orch: snapshots.some(({ data }) => data.orch === true),
    terminals: snapshots.flatMap(({ machine, data }) => (data.terminals ?? [])
      .map(t => ({ ...t, address: qualify(machine, t.address) }))),
    runs: snapshots.flatMap(({ machine, data }) => (data.runs ?? []).map(r => ({ ...r,
      head_terminal: qualify(machine, r.head_terminal), workspace: qualify(machine, r.workspace), tab: qualify(machine, r.tab),
      workers: (r.workers ?? []).map(w => ({ ...w, terminal: qualify(machine, w.terminal) })) }))),
  };
}
