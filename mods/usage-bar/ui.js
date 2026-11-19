import { div } from 'gpui-kit';
import { h_flex, v_flex, Button } from 'gpui-base';
import { pctColorRole, labelWidth, LINEAR_WIDTH, GEAR_WIDTH } from './format.js';

export function roleColor(t, pct) {
  return t[{ ok: 'foreground', warn: 'working', crit: 'blocked' }[pctColorRole(pct)]];
}
export function progress(t, pct, width) {
  return div().w(width).h(2).flex_none().rounded(1).bg(t.border)
    .child(div().h(2).w(`${Math.max(0, Math.min(100, pct))}%`).rounded(1).bg(roleColor(t, pct)));
}
export function cell(t, { label, value, detail = '', pct, color, detailColor, hideBar }) {
  const missing = value === '—';
  return v_flex().flex_none().justify_center().gap(1)
    .child(h_flex().h(16).items_center().gap(4).text_size(12)
      .child(div().font_semibold().text_color(color ?? (pct === undefined ? t.dim : roleColor(t, pct))).child(value))
      .when(pct !== undefined && !hideBar, el => el.child(progress(t, pct, 28))))
    .child(div().h(15).text_size(10.5).text_color(detailColor ?? t.dim).child(missing ? '' : detail));
}
export function groupLabel(t, account, compact) {
  return v_flex().flex_none().max_w(labelWidth(!compact)).justify_center().gap(1)
    .child(h_flex().h(16).items_center().text_size(12).font_semibold().text_color(t.foreground)
      .child(div().truncate().child(account.provider)))
    .when(!compact && !!account.label, el => el.child(div().h(15).text_size(10.5)
      .text_color(t.dim).truncate().child(account.label)));
}
export function systemRow(t, label, pct, detail, hideBar) {
  const known = Number.isFinite(pct);
  // Fixed columns keep the card from resizing as the digits change every second.
  return h_flex().flex_none().items_center().gap(4).text_size(10.8)
    .child(div().w(28).flex_none().text_color(t.dim).child(label))
    .child(h_flex().w(32).flex_none().justify_end().font_semibold().text_color(known ? roleColor(t, pct) : t.dim)
      .child(known ? `${Math.round(pct)}%` : '—'))
    .when(!hideBar, el => el.child(known ? progress(t, pct, 32) : div().w(32).flex_none()))
    .child(h_flex().w(56).flex_none().justify_end().text_color(t.dim).child(detail));
}

function buttonCard(t, id, tooltip) {
  return Button.new(id).h(38).flex().flex_none().items_center().justify_center().gap(5)
    .tab_index(0)
    .rounded(6).bg(t.chrome).border(1).border_color(t.muted + '66').cursor_pointer()
    .text_color(t.foreground).hover(s => s.bg(t.hover)).tooltip(tooltip);
}

export function iconButton(t, id, glyph, tooltip) {
  return buttonCard(t, id, tooltip).w(GEAR_WIDTH).text_size(22).justify_center().child(glyph);
}

export function linearButton(t, { count, alert, connected, stale }) {
  const label = connected === false ? 'Connect' : count ?? '—';
  return buttonCard(t, 'linear', 'Assigned Linear issues').w(LINEAR_WIDTH).text_size(12)
    .child(div().text_color(t.accent).child('◆'))
    .child(div().font_semibold().child('Linear'))
    .child(div().opacity(stale ? 0.6 : 1).text_color(connected && count !== null ? t.foreground : t.dim).child(String(label)))
    .when(alert, el => el.child(div().size(5).rounded(3).bg(t.blocked)));
}

export function openLinearKeySettings(cx) {
  cx.open_url('https://linear.app/settings/account/security');
}
