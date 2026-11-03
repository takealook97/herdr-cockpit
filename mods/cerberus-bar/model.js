// HUD terminals are agent-only. Keep full remote addresses and never infer a
// Head from a name: every orch worker is excluded, including finished workers.
export function headsFrom(hudPanes = {}, panes = [], spaces = []) {
  const workers = new Set((hudPanes.runs ?? []).flatMap(r => (r.workers ?? []).map(w => w.terminal)));
  const agents = new Set((hudPanes.terminals ?? []).map(t => t.address));
  const seen = new Set(), heads = [];
  for (const space of spaces) {
    const tabs = [...(space.tabs ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const tab of tabs) for (const pane of panes.filter(p => p.tab === tab.id)) {
      const address = pane.terminal;
      if (!address || seen.has(address) || !agents.has(address) || workers.has(address)) continue;
      seen.add(address);
      heads.push({ address, tabName: tab.name, spaceName: space.name, status: pane.status ?? 'idle',
        machine: space.machine ?? null, space: space.id, tab: tab.id });
    }
  }
  return heads;
}

export const aggregateStatus = heads => ['blocked', 'working', 'done', 'idle']
  .find(status => heads.some(h => h.status === status)) ?? 'idle';
export const cellOrder = heads => heads.map(h => h.address);
export const selectedHeads = (heads, excluded = []) => heads.filter(h => !excluded.includes(h.address));
export const toggleTarget = (excluded, address) => excluded.includes(address)
  ? excluded.filter(a => a !== address) : [...excluded, address];
export const broadcastSignature = (text, targets) => JSON.stringify([text, cellOrder(targets)]);
export const sendArgs = (address, text) => ['send', address, text];

// Poll each machine's local helper. Only its unqualified addresses gain a prefix.
export function mergeHuds(snapshots) {
  const qualify = (machine, address) => !address || !machine || address.includes('/') ? address : `${machine}/${address}`;
  return {
    terminals: snapshots.flatMap(({ machine, data }) => (data.terminals ?? [])
      .map(t => ({ ...t, address: qualify(machine, t.address) }))),
    runs: snapshots.flatMap(({ machine, data }) => (data.runs ?? []).map(r => ({ ...r,
      head_terminal: qualify(machine, r.head_terminal),
      workers: (r.workers ?? []).map(w => ({ ...w, terminal: qualify(machine, w.terminal) })) }))),
  };
}

const block = (id, content, extra = {}) => ({ id, type: 'block', content, ...extra });
const group = (id, type, children, extra = {}) => ({ id, type, children, gap: 4, resizable: false, ...extra });
function cell(head, index, focus) {
  const h = typeof head === 'string' ? { address: head, tabName: head, spaceName: '', status: 'idle' } : head;
  const id = `cerberus-cell-${index}`;
  return group(id, 'column', [
    block(`${id}-header`, { mod: 'cerberus-cell', props: { ...h, focus: h.address === focus } }, { size: { px: 26 } }),
    block(`${id}-terminal`, { terminal: h.address }),
  ], { gap: 0, min: 0, border: { width: 1, color: h.status === 'blocked' ? 'blocked' : 'border' } });
}

// n is also accepted for geometry tests. Pages are contiguous slices of the
// stable space/tab/pane order. Focus is an address (or an index for n input).
export function gridFor(headsOrN, focus = null, page = 0) {
  const heads = typeof headsOrN === 'number'
    ? Array.from({ length: headsOrN }, (_, i) => `head-${i}`) : headsOrN;
  const address = h => typeof h === 'string' ? h : h.address;
  if (typeof focus === 'number') focus = address(heads[focus]);
  const pages = Math.max(1, Math.ceil(heads.length / 9));
  const current = Math.max(0, Math.min(pages - 1, page));
  const visible = heads.slice(current * 9, current * 9 + 9);
  if (!visible.length) return block('cerberus-empty', { mod: 'cerberus-cell', props: { empty: true } });
  const cells = visible.map((h, i) => cell(h, current * 9 + i, focus));
  const at = visible.findIndex(h => address(h) === focus);
  if (at !== -1 && cells.length > 1) return group('cerberus-grid', 'row', [
    { ...cells[at], size: { weight: 2 } },
    group('cerberus-rest', 'column', cells.filter((_, i) => i !== at), { size: { weight: 1 }, min: 0 }),
  ]);
  if (cells.length <= 3) return group('cerberus-grid', 'row', cells);
  const columns = cells.length === 4 ? 2 : 3;
  const rows = [];
  for (let i = 0; i < cells.length; i += columns)
    rows.push(group(`cerberus-row-${i / columns}`, 'row', cells.slice(i, i + columns), { min: 0 }));
  return group('cerberus-grid', 'column', rows);
}
