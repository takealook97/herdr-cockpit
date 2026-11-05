// Labels are authoritative; argv fallback supports older herdr-hud versions.
export function observerFor(info = {}) {
  const label = info.labels?.['hub.observer'];
  if (typeof label === 'string') return label;
  const argv = info.argv ?? [];
  if (Array.isArray(argv) && argv.includes('attach') && argv.includes('--observe'))
    return argv.at(-1) ?? '';
  return null;
}

// The dedicated Claude Code voice terminal is never a Head.
export const isVoiceTerminal = (info = {}) => Boolean(info?.labels?.['nexus.voice']);

// HUD terminals are agent-only. Keep full remote addresses and exclude all workers.
export function headsFrom(hud = {}, panes = [], spaces = []) {
  const workers = new Set((hud.runs ?? []).flatMap(r => (r.workers ?? []).map(w => w.terminal)));
  const agents = new Map((hud.terminals ?? []).filter(t => observerFor(t) === null && !isVoiceTerminal(t)).map(t => [t.address, t]));
  const seen = new Set(), heads = [];
  for (const space of spaces) {
    const tabs = [...(space.tabs ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const tab of tabs) for (const pane of panes.filter(p => p.tab === tab.id)) {
      const address = pane.terminal, info = agents.get(address);
      if (!address || seen.has(address) || !info || workers.has(address) || observerFor(pane) !== null || isVoiceTerminal(pane)) continue;
      seen.add(address);
      heads.push({ address, tabName: tab.name, spaceName: space.name, status: pane.status ?? 'idle',
        machine: space.machine ?? null, space: space.id, tab: tab.id, model: info.model, effort: info.effort });
    }
  }
  return heads;
}

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

export const gridShape = n => ({ rows: n <= 2 ? 1 : 2, cols: Math.ceil(n / (n <= 2 ? 1 : 2)) });
export const zoomToggle = (zoom, address) => address && zoom !== address ? address : null;
export function neighbor(heads, address, direction) {
  const i = heads.findIndex(h => h.address === address);
  if (i < 0) return heads[0]?.address;
  const { cols } = gridShape(heads.length), row = Math.floor(i / cols), col = i % cols;
  const next = direction === 'left' ? (col > 0 ? i - 1 : i)
    : direction === 'right' ? (col + 1 < cols ? i + 1 : i)
    : direction === 'up' ? (row > 0 ? i - cols : i)
    : direction === 'down' ? i + cols : i;
  return heads[next]?.address ?? address;
}
export const findNode = (node, id) => !node ? null : node.id === id ? node
  : (node.children ?? []).map(n => findNode(n, id)).find(Boolean);
export function replaceNode(node, id, replacement) {
  if (!node) return node;
  if (node.id === id) return replacement;
  return node.children ? { ...node, children: node.children.map(n => replaceNode(n, id, replacement)) } : node;
}
export function withStackActive(tree, id, active) {
  const stack = findNode(tree, id);
  return stack ? replaceNode(tree, id, { ...stack, active }) : tree;
}
export function gridFor(heads, zoom, focusedAddress) {
  const shown = zoom ? heads.filter(h => h.address === zoom) : heads;
  const cell = h => ({ id: `hub-cell-${h.address}`, type: 'column', background: 'background',
    border: { width: 1, color: h.address === focusedAddress ? 'accent' : 'border' }, radius: 10,
    children: [{ id: `hub-head-${h.address}`, type: 'block', size: { px: 30 },
      content: { mod: 'hub-head', props: { address: h.address, tabName: h.tabName, spaceName: h.spaceName, space: h.space, tab: h.tab } } },
    { id: `hub-terminal-${h.address}`, type: 'block', content: { terminal: h.address } }] });
  const { rows, cols } = gridShape(shown.length);
  return { id: 'hub-grid', type: 'column', padding: 8, gap: 8,
    children: shown.length ? Array.from({ length: rows }, (_, r) => ({ id: `hub-row-${r}`, type: 'row', gap: 8,
      children: shown.slice(r * cols, (r + 1) * cols).map(cell) }))
      : [{ id: 'hub-empty', type: 'block', content: { mod: 'hub-head', props: { empty: true } } }] };
}
