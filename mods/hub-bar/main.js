import { View, div } from 'gpui-kit';
import { h_flex, Input, InputState } from 'gpui-base';
import { theme, shared, setShared, hc, run, notify } from 'herdr';
import { selectedHeads, toggleTarget, broadcastSignature, sendArgs } from './model.js';

export default class HubBar extends View {
  init(_p, cx) {
    this.input = InputState.new({ placeholder: 'Message selected Heads…' });
    this.input.on('change', (_e, cx) => { this.confirmation = null; cx.notify(); });
    this.input.on('submit', (_e, cx) => this.send(cx));
    this.busy = false;
    this.confirmation = null;
  }
  targets() { return selectedHeads(shared('hub.heads') ?? [], shared('hub.excluded') ?? []); }
  send(cx) {
    if (this.busy) return;
    if (shared('hub.stale')) {
      notify({ title: 'Head metadata is unavailable', body: 'Wait for a successful refresh before broadcasting.', level: 'warning' });
      return;
    }
    const text = this.input.value(), targets = this.targets();
    if (!text.trim() || !targets.length) return;
    const signature = broadcastSignature(text, targets);
    if (targets.length > 1 && this.confirmation !== signature) {
      this.confirmation = signature;
      cx.notify();
      return;
    }
    this.confirmation = null;
    this.busy = true;
    setShared('hub.sending', true);
    cx.notify();
    cx.spawn(async cx => {
      // Snapshot targets and text at confirmation. Never shell-interpolate text,
      // force past a blocked prompt, or retry a partially successful broadcast.
      const results = await Promise.all(targets.map(async head => {
        try {
          const result = await hc(sendArgs(head.address, text));
          return result.code === 0 ? null : head.tabName;
        } catch { return head.tabName; }
      }));
      const failed = results.filter(name => name !== null);
      this.busy = false;
      setShared('hub.sending', false);
      if (!failed.length && this.input.value() === text) this.input.set_value('');
      notify({ title: failed.length ? 'Broadcast incomplete' : 'Message sent',
        body: failed.length ? `Failed: ${failed.join(', ')}. Some Heads may have received it; retry individually.` : `${targets.length} Head${targets.length === 1 ? '' : 's'}`,
        level: failed.length ? 'warning' : 'success' });
      cx.notify();
    });
  }
  close() { this.input?.release(); setShared('hub.sending', false); }
  render() {
    const t = theme(), heads = shared('hub.heads') ?? [], excluded = shared('hub.excluded') ?? [];
    const targets = this.targets(), pages = Math.max(1, Math.ceil(heads.length / 9));
    const page = Math.min(pages - 1, shared('hub.page') ?? 0);
    const armed = this.confirmation === broadcastSignature(this.input.value(), targets);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, title, action) => div().id(id).h(28).flex_none().px(8).rounded(4).cursor_pointer()
      .text_color(t.foreground).bg(t.raised).tooltip(title).on_mouse_down('left', stop).on_click(action).child(label);
    return h_flex().id('hub-bar').size_full().min_w(0).px(10).gap(8).items_center().bg(t.chrome).text_size(12)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child('hub'))
      .child(h_flex().id('head-chips').flex_1().min_w(0).gap(4).items_center().overflow_x_scroll()
        .children(heads.map(head => h_flex().id(`chip-${head.address}`).h(26).flex_none().px(6).gap(5).items_center()
          .rounded(4).bg(excluded.includes(head.address) ? t.chrome : t.selected).cursor_pointer()
          .opacity(excluded.includes(head.address) ? 0.45 : 1).tooltip(`${head.spaceName} · ${head.address}: click to toggle broadcast`)
          .on_mouse_down('left', stop).on_click((_e, cx) => {
            if (this.busy) return;
            setShared('hub.excluded', toggleTarget(shared('hub.excluded') ?? [], head.address));
            this.confirmation = null; cx.notify();
          })
          .child(div().size(6).rounded(3).bg(t[head.status] ?? t.idle))
          .child(div().text_color(t.foreground).child(head.tabName)))))
      .when(!!shared('hub.unavailable'), el => el.child(div().text_color(t.blocked).child(shared('hub.unavailable'))))
      .when(!!shared('hub.stale'), el => el.child(div().text_color(t.blocked).tooltip('Broadcast paused: Head metadata unavailable').child('⚠')))
      .when(pages > 1, el => el
        .child(button('previous-page', '‹', 'Previous page', () => { setShared('hub.focus', null); setShared('hub.page', (page + pages - 1) % pages); }))
        .child(div().text_color(t.dim).child(`${page + 1}/${pages}`))
        .child(button('next-page', '›', 'Next page', () => { setShared('hub.focus', null); setShared('hub.page', (page + 1) % pages); })))
      .child(div().w(260).min_w(100).h(28).flex_none().on_mouse_down('left', stop)
        .on_key_down((e, cx) => { if (e.key === 'escape') { this.confirmation = null; cx.stop_propagation(); cx.notify(); } })
        .child(Input.new(this.input).size_full().text_size(12).bg(t.input).text_color(t.foreground)))
      .child(button('send', this.busy ? 'Sending…' : armed ? `Confirm ${targets.length}` : `Send (${targets.length})`,
        armed ? 'Send this message to all selected Heads; Esc cancels' : 'Send text and Enter; multiple Heads require confirmation', (_e, cx) => this.send(cx)))
      .child(button('close', '×', 'Close hub', () => run('space-tree.hub-close')));
  }
}
