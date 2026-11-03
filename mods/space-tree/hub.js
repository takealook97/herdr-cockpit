import { spaces, panes, shared, setShared, layout, run } from 'herdr';
import { headsFrom, mergeHuds, gridFor, findNode, replaceNode } from './hub-model.js';

// Owned by the always-shown space tree; this is not a separate mod copy.
export default class Hub {
  init(_p, cx) {
    this.snapshots = new Map();
    this.heads = [];
    this.signature = '';
    setShared('hub.open', false);
    setShared('hub.sending', false);
    setShared('hub.stale', true);
    cx.timer.every(250, cx => this.sync(cx));
  }

  sync(cx) {
    this.heads = headsFrom(mergeHuds([...this.snapshots.values()]), panes(), spaces());
    const serialized = JSON.stringify(this.heads);
    if (serialized !== this.headsSerialized) {
      this.headsSerialized = serialized;
      setShared('hub.heads', this.heads);
    }
    const stack = findNode(layout(), 'work-stack');
    const open = stack?.active === 'hub-view';
    if (shared('hub.open') !== open) setShared('hub.open', open);
    if (!open) { this.rebuildTimer?.cancel(); this.pendingSignature = null; return; }
    if (this.closeRequested && !shared('hub.sending')) { this.hide(); return; }
    const view = { focus: shared('hub.focus') ?? null, page: shared('hub.page') ?? 0 };
    // Status changes update live cell headers; blocked borders require a rebuild.
    const signature = JSON.stringify([this.heads.map(({ status, ...h }) => ({ ...h, blocked: status === 'blocked' })), view]);
    if (signature === this.signature) {
      this.rebuildTimer?.cancel(); this.pendingSignature = null; return;
    }
    if (shared('hub.sending') || signature === this.pendingSignature) return;
    this.rebuildTimer?.cancel();
    this.pendingSignature = signature;
    this.rebuildTimer = cx.timer.after(1000, cx => {
      if (findNode(layout(), 'work-stack')?.active !== 'hub-view' || shared('hub.sending')) { this.pendingSignature = null; return; }
      this.updateGrid(); cx.notify();
    });
  }

  updateGrid() {
    const tree = layout();
    if (!findNode(tree, 'work-stack') || !findNode(tree, 'hub-grid')) return;
    const focus = shared('hub.focus') ?? null;
    const pages = Math.max(1, Math.ceil(this.heads.length / 9));
    const page = Math.min(pages - 1, Math.max(0, shared('hub.page') ?? 0));
    if (page !== shared('hub.page')) setShared('hub.page', page);
    this.signature = JSON.stringify([this.heads.map(({ status, ...h }) => ({ ...h, blocked: status === 'blocked' })), { focus, page }]);
    this.pendingSignature = null;
    const next = replaceNode(tree, 'hub-grid', [gridFor(this.heads, focus, page)]);
    if (next !== tree) run('layout.set', { layout: next });
  }
  show() {
    if (!findNode(layout(), 'work-stack')) {
      setShared('hub.unavailable', 'Hub requires the cockpit work-stack layout.');
      return;
    }
    setShared('hub.unavailable', null);
    this.closeRequested = false;
    this.updateGrid();
    run('layout.select', { stack: 'work-stack', child: 'hub-view' });
    setShared('hub.open', true);
  }
  hide(force = false) {
    if (!force && shared('hub.sending')) { this.closeRequested = true; return; }
    this.closeRequested = false;
    this.rebuildTimer?.cancel();
    this.pendingSignature = null;
    if (findNode(layout(), 'work-stack')?.active === 'hub-view')
      run('layout.select', { stack: 'work-stack', child: 'work-normal' });
    setShared('hub.open', false);
  }
  toggle(cx) {
    if (findNode(layout(), 'work-stack')?.active === 'hub-view') this.hide();
    else { this.sync(cx); this.show(); }
  }
  close() { this.rebuildTimer?.cancel(); }
}
