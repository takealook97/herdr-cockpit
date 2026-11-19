import { div } from 'gpui-kit';
import { h_flex, v_flex, Switch, Input } from 'gpui-base';
import { props, shared, setShared, theme, closeOverlay, openOverlay } from 'herdr';
import { VISIBLE_KEYS, readVisible, toggleVisible } from './prefs.js';
import { groupIssues, dueBadge, projectShort, priorityGlyph, isLinearURL, errorText, statusLine } from './linear.js';

const PANEL_WIDTH = { linear: 440, settings: 320 };
const LABELS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', linear: 'Linear', system: 'CPU · RAM' };
const VISIBLE_KEY = 'usage-bar.visible';

export function openPanel(panel, point) {
  const width = PANEL_WIDTH[panel];
  const spec = { mod: 'usage-bar', kind: 'popup', width, props: { panel } };
  if (Number.isFinite(point?.x)) spec.at = { x: Math.max(8, point.x - width + 24), y: 48 };
  openOverlay(spec);
}

function dismiss() {
  closeOverlay(props().overlay);
}

export function dismissOnEscape(event, cx) {
  if (event.key === 'escape') {
    dismiss();
    cx.stop_propagation();
  }
}

function panelRoot(view, t, panel) {
  return v_flex().id(`${panel}-panel`).track_focus(view.handle).on_key_down(dismissOnEscape)
    .w_full().min_w(0).p(12).gap(8).bg(t.popover).text_size(12).text_color(t.foreground);
}

function action(t, id, label, onClick, disabled = false) {
  const button = h_flex().id(id).h(26).flex_none().items_center().px(6).rounded(4)
    .text_color(disabled ? t.dim : t.foreground).bg(t.raised).child(label);
  if (!disabled) button.cursor_pointer().hover(s => s.bg(t.hover)).on_click(onClick);
  return button;
}

function heading(text) {
  return div().min_w(0).truncate().font_semibold().child(text);
}

function issueRow(t, issue, now) {
  const due = dueBadge(issue.due_date, now);
  const project = projectShort(issue.project);
  const row = h_flex().id('issue-' + issue.identifier).min_h(38).flex_none().items_center()
    .px(6).py(3).gap(6).rounded(4)
    .child(div().w(14).flex_none().text_color(issue.priority === 1 ? t.blocked : t.dim).child(priorityGlyph(issue.priority)))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().min_w(0).items_center().gap(6)
        .child(div().flex_none().text_color(t.dim).child(issue.identifier))
        .child(div().min_w(0).truncate().child(issue.title)))
      .child(div().min_w(0).truncate().text_color(t.dim).text_size(11).child(project)))
    .when(!!due, node => node.child(div().flex_none().text_size(11)
      .text_color(t[{ dim: 'dim', warn: 'working', crit: 'blocked' }[due.tone]]).child(due.text)));
  if (isLinearURL(issue.url)) row.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_event, cx) => {
    cx.open_url(issue.url);
    dismiss();
  });
  return row;
}

export function linearPanel(view) {
  const t = theme(), now = new Date();
  const { issues: snapshot, status, issueError, statusError } = view.linearSnapshot();
  const org = status?.org;
  const matchingOrg = !snapshot || (snapshot.source === status?.source &&
    (!snapshot.org_url || snapshot.org_url === org?.url));
  const orgName = matchingOrg ? org?.name : null;
  const orgURL = snapshot?.org_url ?? (matchingOrg ? org?.url : null);
  const error = issueError ?? (snapshot ? snapshot.error : status?.error ?? statusError);

  const root = panelRoot(view, t, 'linear').max_h(520)
    .child(h_flex().min_w(0).items_center().gap(6)
      .child(heading(orgName ? `My issues · ${orgName}` : 'My issues').flex_1())
      .child(action(t, 'linear-refresh', 'Refresh', (_event, cx) => view.readLinear('issues', cx, true)))
      .when(isLinearURL(orgURL), el => el.child(action(t, 'linear-open', 'Open in Linear', (_event, cx) => {
        cx.open_url(orgURL.replace(/\/$/, '') + '/my-issues/assigned');
      }))));

  if (error === 'not_connected') return root.child(action(t, 'linear-settings', errorText(error), () => {
    dismiss();
    openPanel('settings');
  }));
  if (error) root.child(div().text_color(t.blocked).child(errorText(error)));
  if (!snapshot || error === 'expired') return root;
  const groups = groupIssues(snapshot.issues);
  if (!groups.length) {
    if (!error) root.child(div().text_color(t.dim).child('No open issues'));
    return root;
  }

  return root.child(v_flex().id('linear-issue-list').min_h(0).max_h(462).gap(6).overflow_y_scroll()
    .opacity(snapshot.stale || error ? 0.6 : 1)
    .children(groups.map(group => v_flex().gap(2).flex_none()
      .child(div().px(6).font_semibold().text_color(t.dim).child(`${group.title} (${group.issues.length})`))
      .children(group.issues.map(issue => issueRow(t, issue, now))))));
}

export function settingsPanel(view) {
  const t = theme(), visible = readVisible(shared(VISIBLE_KEY));
  const { status, statusError } = view.linearSnapshot();
  const busy = view.linearBusy;
  const error = view.linearActionError ?? statusError ?? (status?.error === 'not_connected' ? null : status?.error);
  return panelRoot(view, t, 'settings')
    .child(heading('Top bar'))
    .children(VISIBLE_KEYS.map(key => h_flex().h(26).items_center().justify_between()
      .child(div().child(LABELS[key]))
      .child(Switch.new('visible-' + key).checked(visible[key]).tab_index(0)
        .flex().items_center().w(32).h(18).px(3).rounded(9).cursor_pointer()
        .bg(visible[key] ? t.accent : t.border)
        .child(div().size(12).rounded(6).bg(visible[key] ? t.accent_foreground : t.dim))
        .when(visible[key], el => el.justify_end())
        .on_click(() => {
          setShared('usage-bar.visible', toggleVisible(shared(VISIBLE_KEY), key));
        }))))
    .child(heading('Linear').pt(4).border_t(1).border_color(t.border))
    .child(div().text_color(t.dim).child(status ? statusLine(status) : 'Checking connection…'))
    .when(!!error, el => el.child(div().text_color(t.blocked).child(errorText(error))))
    .child(h_flex().min_w(0).items_center().gap(6)
      .child(h_flex().flex_1().min_w(0).on_key_down(dismissOnEscape)
        .child(Input.new(view.input).w_full().h(26).px(6).rounded(4)
          .bg(t.input).text_color(t.foreground).border(1).border_color(t.border)))
      .child(action(t, 'linear-connect', busy ? 'Working…' : 'Connect', (_event, cx) => view.changeLinear('connect', cx), busy)))
    .child(h_flex().gap(6)
      .child(action(t, 'linear-create-key', 'Create API key', (_event, cx) => {
        cx.open_url('https://linear.app/settings/account/security');
      }))
      .when(status?.source === 'api_key', el => el.child(action(t, 'linear-disconnect', 'Disconnect',
        (_event, cx) => view.changeLinear('disconnect', cx), busy))));
}
