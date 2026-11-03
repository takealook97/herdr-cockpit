import { spaces, panes, terminals, shared, setShared, hc, run, exec } from 'herdr';
import { headsFrom, mergeHuds, hubSpace, planHub, observerArgs, observerFor } from './hub-model.js';

// The always-shown space tree owns one manager; creation is strictly user driven.
export default class Hub {
  init(_p, cx) {
    this.snapshots = new Map();
    this.heads = [];
    this.pending = new Map();
    this.killing = new Map();
    this.renamed = new Set();
    this.seedRemoved = new Set(shared('hub.seedRemoved') ?? []);
    setShared('hub.stale', true);
    cx.timer.every(250, cx => this.sync(cx));
  }
  space() { return hubSpace(spaces(), shared('hub.space')); }
  active() { return !!this.space()?.active; }

  sync(cx) {
    if (this.closed) return;
    const space = this.space();
    const current = spaces().find(s => s.active);
    if (current && current.id !== space?.id) this.previous = current.id;
    if (space) {
      if (shared('hub.space') !== space.id) setShared('hub.space', space.id);
      if (this.creating) {
        this.creating = false;
        run('space.move', { id: space.id, index: 1 });
      }
    }
    const hud = mergeHuds([...this.snapshots.values()]);
    const core = new Map(terminals().map(t => [t.address, t]));
    hud.terminals = hud.terminals.map(t => ({ ...core.get(t.address), ...t }));
    this.heads = headsFrom(hud, panes(), spaces(), space?.id);
    const serialized = JSON.stringify(this.heads);
    if (serialized !== this.headsSerialized) {
      this.headsSerialized = serialized;
      setShared('hub.heads', this.heads);
    }
    if (space && this.wantOpen) {
      this.wantOpen = false;
      run('space.select', { id: space.id });
    }
    if (space && !shared('hub.stale')) this.reconcile(space, cx);
    cx.notify();
  }

  reconcile(space, cx) {
    if (this.busy) return;
    const tab = [...(space.tabs ?? [])].sort((a, b) => a.index - b.index)[0];
    if (!tab) return;
    if (!tab.name && !this.renamed.has(tab.id)) {
      this.renamed.add(tab.id);
      run('tab.rename', { id: tab.id, name: 'hub' });
    }
    const hubPanes = panes().filter(p => p.tab === tab.id);
    // Core terminal metadata includes shells, which the agent-only HUD omits.
    const metadata = new Map(mergeHuds([...this.snapshots.values()]).terminals.map(t => [t.address, t]));
    for (const info of terminals()) metadata.set(info.address, info);
    const plan = planHub({ heads: this.heads, hubPanes, observers: [...metadata.values()] });
    const now = Date.now();
    for (const [address, expires] of this.pending) if (!plan.add.includes(address) || expires < now) this.pending.delete(address);
    for (const [terminal, expires] of this.killing) if (!hubPanes.some(p => p.terminal === terminal) || expires < now) this.killing.delete(terminal);
    const remove = [...plan.remove];
    if (plan.killSeed && !this.seedRemoved.has(space.id)) {
      remove.push(plan.killSeed);
      this.seedRemoved.add(space.id);
      setShared('hub.seedRemoved', [...this.seedRemoved]);
    }
    for (const terminal of remove) if (!this.killing.has(terminal)) {
      this.killing.set(terminal, now + 10000);
      run('terminal.kill', { terminal });
    }
    this.layout(space, tab, hubPanes, metadata, !plan.add.length && !remove.length && !this.killing.size, cx);
    const add = plan.add.filter(address => !this.pending.has(address));
    if (!add.length) return;
    this.busy = true;
    for (const address of add) this.pending.set(address, now + 10000);
    cx.spawn(async cx => {
      try {
        for (const address of add) {
          if (this.closed || this.space()?.id !== space.id) break;
          try {
            const result = await hc(observerArgs(space.id, tab.id, address));
            if (result.code !== 0) this.pending.delete(address);
          } catch { this.pending.delete(address); }
        }
      } finally { this.busy = false; cx.notify(); }
    });
  }

  layout(space, tab, hubPanes, metadata, ready, cx) {
    const order = this.heads.flatMap(head => hubPanes.filter(p =>
      observerFor(metadata.get(p.terminal) ?? p) === head.address).map(p => p.terminal));
    // Pane traversal order changes when the grid is written; only the set matters.
    const signature = JSON.stringify([space.id, tab.id, this.heads.map(h => h.address),
      hubPanes.map(p => p.terminal ?? p.pane).sort(), order]);
    if (signature !== this.layoutSignature) {
      this.layoutSignature = signature;
      this.layoutApplied = null;
      this.layoutPending = null;
    }
    if (!ready) { this.layoutPending = null; return; }
    if (this.layoutPending || this.layoutApplied === signature) return;
    const request = { signature };
    this.layoutPending = request;
    cx.timer.after(500, cx => {
      if (this.layoutPending !== request) return;
      this.layoutPending = null;
      if (this.closed || this.busy || shared('hub.stale') || this.space()?.id !== space.id) return;
      this.layoutApplied = signature;
      cx.spawn(async () => {
        try {
          await exec('sh', ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud',
            'hub-layout', '--space', space.id, '--tab', tab.id, '--order', order.join(',')]);
        } catch { /* Try again only when the observer set or head order changes. */ }
      });
    });
  }

  open(cx) {
    this.wantOpen = true;
    this.sync(cx);
    if (!this.space() && !this.creating) {
      this.creating = true;
      // run is fire-and-forget; the live spaces snapshot supplies the new ids.
      run('space.new', { name: 'hub' });
    }
  }
  hide() {
    this.wantOpen = false;
    const target = spaces().find(s => s.id === this.previous && s.id !== this.space()?.id)
      ?? spaces().find(s => s.id !== this.space()?.id);
    if (this.active() && target) run('space.select', { id: target.id });
  }
  toggle(cx) { if (this.active()) this.hide(); else this.open(cx); }
  close() { this.closed = true; }
}
