import { spaces, panes, terminals, focused, shared, setShared, layout, run, exec, notify } from 'herdr';
import { headsFrom, mergeHuds, gridFor, findNode, replaceNode, withStackActive, neighbor, zoomToggle } from './hub-model.js';

const plainLayout = () => JSON.parse(JSON.stringify(layout() ?? null));
// Host arguments have a 16-level limit; send the layout as a CLI JSON string.
const SET_LAYOUT = 'b="$HOME/.local/bin/herdr-app"; if [ -x "$b" ]; then exec "$b" do layout.set "$1"; fi; ' +
  'for a in /Applications/Herdr.app "$HOME/Applications/Herdr.app"; do ' +
  '[ -x "$a/Contents/MacOS/Herdr" ] && exec -a herdr-app "$a/Contents/MacOS/Herdr" do layout.set "$1"; done; exit 127';
function setLayout(tree) {
  return exec('/bin/bash', ['-c', SET_LAYOUT, 'hub', JSON.stringify({ layout: tree })]).then(result => {
    if (result.code !== 0) throw new Error(result.stderr?.trim() || `layout.set exited ${result.code}`);
  });
}
const reportError = error => notify({ title: 'hub', body: String(error?.message ?? error), level: 'error', timeout: 6000 });

export default class Hub {
  init(_p, cx) {
    this.snapshots = new Map(); this.heads = []; this.signature = '';
    this.zoomed = null; this.request = 0;
    cx.timer.every(250, cx => this.sync(cx));
  }
  focusedTerminal() { return focused()?.terminal; }
  source(cx) {
    this.sourceAfter = shared("hub.source");
    if (!this.sourceAfter) return;
    setShared("hub.source", null);
    this.hide(cx);
  }
  active() { return !!shared('hub.open'); }
  sync(cx) {
    if (this.closed) return;
    const hud = mergeHuds([...this.snapshots.values()]);
    const core = new Map(terminals().map(t => [t.address, t]));
    hud.terminals = hud.terminals.map(t => ({ ...core.get(t.address), ...t }));
    this.heads = headsFrom(hud, panes(), spaces());
    const serialized = JSON.stringify(this.heads);
    if (serialized !== this.headsSerialized) { this.headsSerialized = serialized; setShared('hub.heads', this.heads); }
    if (this.zoomed && !this.heads.some(h => h.address === this.zoomed)) this.zoomed = null;
    if (!this.active()) return;
    const signature = JSON.stringify([this.heads.map(h => [h.address, h.tabName, h.spaceName, h.space, h.tab]), this.zoomed]);
    if (signature === this.signature) {
      this.rebuildTimer?.cancel(); this.pendingSignature = null; return;
    }
    if (signature === this.pendingSignature) return;
    this.rebuildTimer?.cancel(); this.pendingSignature = signature;
    this.rebuildTimer = cx.timer.after(500, cx => { this.pendingSignature = null; this.apply(cx); });
  }
  apply(cx, focusAddress) {
    this.rebuildTimer?.cancel(); this.pendingSignature = null;
    // Serialize writes and reread shared state after each await so rapid toggle/zoom
    // cannot let an earlier CLI response reopen a now-hidden hub.
    this.request++;
    if (focusAddress) this.focusAfter = focusAddress;
    if (this.writing) return;
    this.writing = true;
    cx.spawn(async cx => {
      try {
        let applied;
        do {
          applied = this.request;
          if (this.closed) break;
          const open = this.active(), tree = plainLayout();
          if (!findNode(tree, 'work-stack') || !findNode(tree, 'hub-grid')) throw new Error('Hub requires the cockpit work-stack layout.');
          const signature = JSON.stringify([this.heads.map(h => [h.address, h.tabName, h.spaceName, h.space, h.tab]), this.zoomed]);
          const next = withStackActive(replaceNode(tree, 'hub-grid', gridFor(this.heads, this.zoomed)), 'work-stack', open ? 'hub-view' : 'work-normal');
          await setLayout(next);
          if (this.closed) break;
          if (applied !== this.request) continue;
          this.signature = signature;
          run('layout.select', { stack: 'work-stack', child: open ? 'hub-view' : 'work-normal' });
          run(open ? 'layout.hide' : 'layout.show', { id: 'tabs' });
          if (open && this.focusAfter) run('pane.focus', { terminal: this.focusAfter });
          this.focusAfter = null;
          if (!open && this.sourceAfter) {
            const source = this.sourceAfter; this.sourceAfter = null;
            run('space.select', { id: source.space });
            run('tab.select', { id: source.tab });
            run('pane.focus', { terminal: source.address });
          }
        } while (applied !== this.request);
      } catch (error) { this.signature = ''; reportError(error); }
      finally { this.writing = false; cx.notify(); }
    });
  }
  open(cx, address) {
    if (this.closed) return;
    if (address && this.zoomed && address !== this.zoomed) this.zoomed = null;
    setShared('hub.open', true); this.sync(cx);
    this.apply(cx, address ?? this.heads.find(h => h.address === focused()?.terminal)?.address ?? this.heads[0]?.address);
  }
  hide(cx) {
    if (!this.active()) return;
    setShared('hub.open', false); this.zoomed = null;
    this.rebuildTimer?.cancel(); this.pendingSignature = null;
    this.apply(cx);
  }
  toggle(cx) { if (this.active()) this.hide(cx); else this.open(cx); }
  go(direction) {
    if (!this.active()) { run('pane.go', { direction }); return; }
    const shown = this.zoomed ? this.heads.filter(h => h.address === this.zoomed) : this.heads;
    const address = neighbor(shown, focused()?.terminal, direction);
    if (address) run('pane.focus', { terminal: address });
  }
  zoom(cx) {
    if (!this.active()) { run('pane.zoom'); return; }
    const address = focused()?.terminal;
    if (!this.heads.some(h => h.address === address)) return;
    this.zoomed = zoomToggle(this.zoomed, address); this.apply(cx, address);
  }
  close() { this.closed = true; this.rebuildTimer?.cancel(); }
}
