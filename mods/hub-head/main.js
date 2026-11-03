import { View, div, svg, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { panes, props, run, shared, theme, home } from 'herdr';

const folder = cwd => !cwd ? '' : cwd === home() ? '~' : cwd.startsWith(home() + '/') ? '~' + cwd.slice(home().length) : cwd;
export default class HubHead extends View {
  render() {
    const t = theme(), p = props() ?? {};
    if (p.empty) return div().size_full().p(20).text_size(12).text_color(t.dim).child('No Head terminals');
    const head = (shared('hub.heads') ?? []).find(h => h.address === p.address) ?? p;
    const pane = panes().find(item => item.terminal === p.address);
    const program = pane?.program;
    const pic = !program?.icon ? null : program.tint ? svg(program.icon).size(14).flex_none().text_color(t.dim)
      : image(program.icon).w(14).h(14).flex_none();
    return h_flex().id(`hub-header-${p.address}`).size_full().px(10).gap(8).items_center()
      .bg(t.background).border_b(1).border_color(t.border).text_size(12)
      .on_click(() => run('pane.focus', { terminal: p.address }))
      .when(Boolean(pic), el => el.child(pic))
      .child(div().flex_none().max_w(260).truncate().font_medium().text_color(t.foreground)
        .child(`${head.spaceName || 'Space'} · ${head.tabName || 'Terminal'}`))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(pane?.cwd)));
  }
}
