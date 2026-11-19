import { div } from 'gpui-kit';
import { h_flex, v_flex, Switch, Input } from 'gpui-base';
import { props, shared, setShared, theme, closeOverlay, openOverlay } from 'herdr';
import { VISIBLE_KEYS, readVisible, toggleVisible } from './prefs.js';
import { groupIssues, groupType, dueBadge, projectShort, priorityLevel, priorityName, plainDescription, errorText, statusLine } from './linear.js';
import { openLinearKeySettings } from './ui.js';

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

function headerButton(t, id, glyph, label, onClick) {
  return h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(4)
    .text_size(14).text_color(t.dim).cursor_pointer().tooltip(label).accessibility_label(label)
    .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(glyph);
}

const PRIORITY_BARS = { high: 3, medium: 2, low: 1, none: 0 };

function priorityBox(t, issue) {
  const level = priorityLevel(issue.priority);
  const box = h_flex().id('priority-' + issue.identifier).size(14).flex_none()
    .justify_center().tooltip(priorityName(issue.priority));
  if (level === 'urgent') {
    return box.items_center().rounded(3).bg(t.blocked).text_color('#fffaf0')
      .text_size(10).font_bold().child('!');
  }
  return box.items_end().gap(1.5).children([5, 8, 11].map((height, index) => {
    const bar = div().w(3).h(height);
    return index < PRIORITY_BARS[level] ? bar.bg(t.foreground) : bar.bg(t.dim).opacity(0.3);
  }));
}

function statusMark(t, type) {
  const mark = div().size(10).flex_none().rounded(5);
  if (type === 'blocked') return mark.bg(t.blocked);
  if (type === 'review') {
    return mark.flex().items_center().border(1.5).border_color(t.working)
      .child(div().w(3.5).h(7).rounded_l(3.5).bg(t.working));
  }
  const color = type === 'started' ? t.working : type === 'triage' ? t.accent : t.dim;
  return mark.border(1).border_color(color).when(type === 'backlog', el => el.opacity(0.5));
}

function duePill(t, due) {
  const color = t[{ crit: 'blocked', warn: 'working', dim: 'dim' }[due.tone]];
  return h_flex().h(18).px(6).rounded(4).items_center().flex_none().text_size(11)
    .text_color(color).bg(due.tone === 'dim' ? t.raised : color + '26').child(due.text);
}

function issueRow(t, issue, now, view, expanded) {
  const due = dueBadge(issue.due_date, now);
  const project = projectShort(issue.project);
  const title = div().min_w(0).truncate().child(issue.title);
  const row = h_flex().id('issue-' + issue.identifier).flex_none().items_center()
    .px(6).gap(8).rounded(4).cursor_pointer()
    .when(expanded, el => el.bg(t.raised))
    .when(!expanded, el => el.hover(s => s.bg(t.hover)))
    .on_click((_event, cx) => view.toggleLinearDetail(issue.identifier, cx))
    .child(priorityBox(t, issue))
    .child(div().w(58).flex_none().text_size(11).text_color(t.dim).child(issue.identifier));
  if (project) {
    row.min_h(40).child(v_flex().flex_1().min_w(0).child(title)
      .child(div().min_w(0).truncate().text_color(t.dim).text_size(11).child(project)));
  } else {
    row.h(30).child(title.flex_1());
  }
  if (due) row.child(duePill(t, due));
  return row;
}

function issueDetail(t, identifier, group, data, now) {
  const block = v_flex().id('issue-detail-' + identifier).w_full().min_w(0)
    .pl(94).pr(6).pt(4).pb(8).gap(5);
  if (!data) return block.child(div().text_color(t.dim).child('Loading…'));
  if (data.error) return block.child(div().text_color(t.blocked).child(errorText(data.error)));

  const issue = data.issue;
  const due = dueBadge(issue.due_date, now);
  const status = issue.status || group.title;
  const type = groupType(issue) ?? (issue.status_type || group.type);
  const dot = () => div().text_color(t.dim).child('·');
  const meta = h_flex().items_center().flex_wrap().gap(5)
    .child(h_flex().items_center().gap(5).child(statusMark(t, type)).child(div().child(status)))
    .child(dot()).child(div().child(priorityName(issue.priority)));
  if (due) meta.child(dot()).child(duePill(t, { ...due, text: issue.due_date }));
  if (issue.assignee) meta.child(dot()).child(div().min_w(0).whitespace_normal().child(issue.assignee));
  block.child(meta);
  if (issue.project) block.child(div().min_w(0).whitespace_normal().text_color(t.dim).child(issue.project));
  if (issue.labels?.length) block.child(h_flex().flex_wrap().gap(4).children(issue.labels.map(label =>
    div().min_w(0).px(6).py(2).rounded(4).bg(t.raised).text_size(11).whitespace_normal().child(label))));
  const description = plainDescription(issue.description);
  if (!description) return block.child(div().text_color(t.dim).child('No description'));
  return block.children(description.split('\n').map(line =>
    line ? div().w_full().min_w(0).whitespace_normal().child(line) : div().h(8)));
}

export function linearPanel(view) {
  const t = theme(), now = new Date();
  const { issues: snapshot, status, issueError, statusError, details } = view.linearSnapshot();
  const org = status?.org;
  const matchingOrg = !snapshot || (snapshot.source === status?.source &&
    (!snapshot.org_url || snapshot.org_url === org?.url));
  const orgName = matchingOrg ? org?.name : null;
  const error = issueError ?? (statusError === 'busy' ? statusError : null) ??
    (snapshot ? snapshot.error : status?.error ?? statusError);
  const groups = groupIssues(snapshot?.issues);
  const count = groups.reduce((total, group) => total + group.issues.length, 0);

  const root = panelRoot(view, t, 'linear').max_h(520)
    .child(h_flex().min_w(0).items_center().gap(6)
      .child(heading('My issues').flex_none())
      .when(!!orgName, el => el.child(div().min_w(0).truncate().text_color(t.dim).child(orgName)))
      .child(div().flex_none().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .child(headerButton(t, 'linear-refresh', '↻', 'Refresh', (_event, cx) => view.readLinear('issues', cx, true))))
    .child(div().w_full().h(1).flex_none().bg(t.border));

  if (error === 'not_connected') return root.child(action(t, 'linear-settings', errorText(error), () => {
    dismiss();
    openPanel('settings');
  }));
  if (error) root.child(div().text_color(t.blocked).child(errorText(error)));
  if (!snapshot || error === 'expired') return root;
  if (!groups.length) {
    if (!error) root.child(div().text_color(t.dim).child('No open issues'));
    return root;
  }

  return root.child(v_flex().id('linear-issue-list').min_h(0).max_h(462).gap(10).overflow_y_scroll()
    .opacity(snapshot.stale || error ? 0.6 : 1)
    .children(groups.map(group => v_flex().gap(2).flex_none()
      .child(h_flex().h(22).px(6).items_center().gap(6)
        .child(statusMark(t, group.type))
        .child(heading(group.title).text_color(t.foreground))
        .child(div().flex_none().text_color(t.dim).child(String(group.issues.length))))
      .children(group.issues.flatMap(issue => {
        const expanded = details?.expanded === issue.identifier;
        const row = issueRow(t, issue, now, view, expanded);
        return expanded ? [row, issueDetail(t, issue.identifier, group, details.data, now)] : [row];
      })))));
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
      .child(action(t, 'linear-create-key', 'Create API key', (_event, cx) => openLinearKeySettings(cx)))
      .when(status?.source === 'api_key', el => el.child(action(t, 'linear-disconnect', 'Disconnect',
        (_event, cx) => view.changeLinear('disconnect', cx), busy))));
}
