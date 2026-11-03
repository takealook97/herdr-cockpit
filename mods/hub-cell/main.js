import { View, div } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { props, panes, theme, shared, setShared, run } from 'herdr';

export default class HubCell extends View {
  render() {
    const p = props() ?? {}, t = theme();
    if (p.empty) return h_flex().size_full().items_center().justify_center().text_size(13)
      .text_color(t.dim).child('No Head terminals. Start an agent in a space.');
    const live = panes().find(pane => pane.terminal === p.address);
    const head = (shared('hub.heads') ?? []).find(h => h.address === p.address) ?? p;
    const status = live?.status ?? head.status ?? 'idle';
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id(`header-${p.address ?? 'preview'}`).h(26).w_full().min_w(0).px(8).gap(6).items_center()
      .bg(t.chrome).text_color(t.foreground).text_size(12)
      .when(status === 'blocked', el => el.border(1).border_color(t.blocked))
      .child(div().size(6).flex_none().rounded(3).bg(t[status] ?? t.idle))
      .child(h_flex().id('select-head').flex_1().min_w(0).gap(6).items_center().cursor_pointer()
        .tooltip('Go to this Head’s tab').on_mouse_down('left', stop)
        .on_click(() => {
          run('space-tree.hub-close');
          if (head.space) run('space.select', { id: head.space });
          if (head.tab) run('tab.select', { id: head.tab });
        })
        .child(div().min_w(0).truncate().font_semibold().child(head.tabName ?? 'Head'))
        .child(div().min_w(0).truncate().text_color(t.dim).child(head.spaceName ?? '')))
      .child(div().id('focus-head').flex_none().size(20).text_color(t.muted).cursor_pointer()
        .tooltip(p.focus ? 'Restore grid' : 'Focus this Head').on_mouse_down('left', stop)
        .on_click(() => setShared('hub.focus', p.focus ? null : p.address))
        .child(p.focus ? '↙' : '↗'));
  }
}
