import { View, div, svg, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { panes, props, run, shared, setShared, theme, home, focused } from 'herdr';

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
    // Layout terminal blocks get no focus border, so the header shows which cell has the keyboard.
    const active = focused()?.terminal === p.address;
    return h_flex().id(`hub-header-${p.address}`).size_full().px(10).gap(8).items_center()
      .bg(active ? t.raised : t.background).border_b(1).border_color(active ? t.accent : t.border)
      .border_t(2).text_size(12).hover(s => s.bg(t.hover))
      .when(!active, el => el.border_color(t.border).opacity(0.85))
      .when(active, el => el.border_color(t.accent))
      .on_click(() => run('pane.focus', { terminal: p.address }))
      .when(Boolean(pic), el => el.child(pic))
      .child(div().flex_none().max_w(260).truncate().font_medium().text_color(active ? t.foreground : t.muted)
        .child(`${head.tabName || 'Terminal'} · ${head.spaceName || 'Space'}`))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(pane?.cwd)))
      .child(div().id(`hub-source-${p.address}`).p(3).rounded(4).text_color(t.dim)
        .tooltip('Go to source').hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          setShared('hub.source', { address: p.address, space: head.space, tab: head.tab });
          run('space-tree.source');
        }).child(svg('mods/hub-head/source.svg').size(14)));
  }
}
