import { View, div } from 'gpui-kit';
import { exec, spaces, machines, panes, shared, setShared, openOverlay, closeOverlay, nextCommand, props, run } from 'herdr';
import { headsFrom, mergeHuds, gridFor } from './model.js';

// A zero-height layout block keeps the command receiver resident. A mod.open
// copy only forwards to it, so there is exactly one polling/overlay owner.
export default class Cerberus extends View {
  init(_p, cx) {
    this.launcher = !!props()?.overlay;
    if (this.launcher) {
      run('cerberus.toggle');
      closeOverlay(props().overlay);
      return;
    }
    this.snapshots = new Map();
    this.heads = [];
    this.overlay = null;
    this.signature = '';
    setShared('cerberus.open', false);
    setShared('cerberus.sending', false);
    setShared('cerberus.stale', true);
    this.refresh(cx);
    cx.timer.every(3000, cx => this.refresh(cx));
    cx.timer.every(250, cx => this.sync(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'toggle') this.toggle(cx);
        else if (command === 'close') this.hide();
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async cx => {
      const names = [...new Set([null, ...machines().map(m => m.name), ...spaces().map(s => s.machine ?? null)])];
      const results = await Promise.all(names.map(async machine => {
        try {
          const result = await exec('sh', ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud', 'panes'], { on: machine || undefined });
          if (result.code !== 0) throw new Error('helper unavailable');
          const data = JSON.parse(result.stdout);
          if (data.error || !Array.isArray(data.terminals) || !Array.isArray(data.runs)) throw new Error('incomplete metadata');
          this.snapshots.set(machine, { machine, data });
          return true;
        } catch { return false; }
      }));
      for (const machine of this.snapshots.keys()) if (!names.includes(machine)) this.snapshots.delete(machine);
      this.polling = false;
      setShared('cerberus.stale', results.some(ok => !ok));
      this.sync(cx);
      cx.notify();
    });
  }

  sync(cx) {
    this.heads = headsFrom(mergeHuds([...this.snapshots.values()]), panes(), spaces());
    const serialized = JSON.stringify(this.heads);
    if (serialized !== this.headsSerialized) {
      this.headsSerialized = serialized;
      setShared('cerberus.heads', this.heads);
    }
    if (!this.overlay) return;
    if (this.closeRequested && !shared('cerberus.sending')) { this.hide(); return; }
    const view = { focus: shared('cerberus.focus') ?? null, page: shared('cerberus.page') ?? 0 };
    // Status changes update live cell headers; blocked borders require a rebuild.
    const signature = JSON.stringify([this.heads.map(({ status, ...h }) => ({ ...h, blocked: status === 'blocked' })), view]);
    if (signature === this.signature) {
      this.rebuildTimer?.cancel(); this.pendingSignature = null; return;
    }
    if (shared('cerberus.sending') || signature === this.pendingSignature) return;
    this.rebuildTimer?.cancel();
    this.pendingSignature = signature;
    this.rebuildTimer = cx.timer.after(1000, cx => {
      if (!this.overlay || shared('cerberus.sending')) { this.pendingSignature = null; return; }
      this.show(); cx.notify();
    });
  }

  show() {
    this.closeRequested = false;
    const focus = shared('cerberus.focus') ?? null;
    const pages = Math.max(1, Math.ceil(this.heads.length / 9));
    const page = Math.min(pages - 1, Math.max(0, shared('cerberus.page') ?? 0));
    if (page !== shared('cerberus.page')) setShared('cerberus.page', page);
    this.signature = JSON.stringify([this.heads.map(({ status, ...h }) => ({ ...h, blocked: status === 'blocked' })), { focus, page }]);
    this.pendingSignature = null;
    if (this.overlay) closeOverlay(this.overlay);
    this.overlay = openOverlay({ kind: 'window', key: 'cerberus', frame: 'none', width: 0.96, height: 0.92,
      layout: { id: 'cerberus', type: 'column', gap: 4, padding: 4, background: 'canvas', resizable: false,
        children: [
          { id: 'cerberus-bar', type: 'block', size: { px: 44 }, content: { mod: 'cerberus-bar' } },
          gridFor(this.heads, focus, page),
        ] } });
    setShared('cerberus.open', true);
  }
  hide(force = false) {
    if (!force && shared('cerberus.sending')) { this.closeRequested = true; return; }
    this.closeRequested = false;
    this.rebuildTimer?.cancel();
    this.pendingSignature = null;
    if (this.overlay) closeOverlay(this.overlay);
    this.overlay = null;
    setShared('cerberus.open', false);
  }
  toggle(cx) {
    if (this.overlay) this.hide();
    else { this.sync(cx); this.show(); }
  }
  close() { if (!this.launcher) this.hide(true); }
  render() { return div().id('cerberus-controller').size_full(); }
}
