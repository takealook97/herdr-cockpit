const DAY = 86400000;
const GROUPS = [
  ['blocked', 'Blocked'],
  ['started', 'In Progress'],
  ['unstarted', 'Todo'],
  ['backlog', 'Backlog'],
  ['triage', 'Triage'],
];

function groupKey(issue) {
  if (issue.status_type === 'started' && /blocked/i.test(issue.status)) return 'blocked';
  return issue.status_type === 'blocked' ? null : issue.status_type;
}

function dueDay(due) {
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return Infinity;
  const date = new Date(due + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().startsWith(due) ? +date / DAY : Infinity;
}

const priority = value => [1, 2, 3, 4].includes(value) ? value : 5;
const updated = issue => Date.parse(issue.updated_at) || 0;

export function groupIssues(issues) {
  const grouped = new Map(GROUPS.map(([key]) => [key, []]));
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue) grouped.get(groupKey(issue))?.push(issue);
  }
  return GROUPS.flatMap(([key, title]) => {
    const rows = grouped.get(key);
    rows.sort((a, b) => dueDay(a.due_date) - dueDay(b.due_date) ||
      priority(a.priority) - priority(b.priority) || updated(b) - updated(a));
    return rows.length ? [{ key, title, issues: rows }] : [];
  });
}

export function dueBadge(due, now = new Date()) {
  const dueDate = dueDay(due);
  if (!Number.isFinite(dueDate)) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY;
  const days = dueDate - today;
  if (days < 0) return { text: `${-days}d over`, tone: 'crit' };
  if (days === 0) return { text: 'Today', tone: 'warn' };
  return { text: `D-${days}`, tone: days <= 3 ? 'warn' : 'dim' };
}

export function projectShort(name) {
  return typeof name === 'string' ? name.split(' / ').at(-1).trim() : '';
}

export function priorityGlyph(value) {
  return ['!', '↑', '→', '↓', '–'][priority(value) - 1];
}

export function badgeState(issues, now = new Date()) {
  const open = (Array.isArray(issues) ? issues : []).filter(issue => issue && GROUPS.some(([key]) => key === groupKey(issue)));
  return {
    count: open.length,
    alert: open.some(issue => groupKey(issue) === 'blocked' || dueBadge(issue.due_date, now)?.tone === 'crit'),
  };
}

export function isLinearURL(url) {
  return typeof url === 'string' && url.startsWith('https://linear.app/');
}

const errors = new Map([
  ['not_connected', 'Connect Linear in settings'],
  ['expired', 'Claude Code Linear session expired — use Linear in Claude Code once, or add an API key'],
  ['forbidden', 'Linear denied access'],
  ['invalid_key', 'That API key was rejected'],
  ['store_failed', "Couldn't save the key"],
  ['helper', 'herdr-hud unavailable'],
]);

export function errorText(code) {
  return errors.get(code) ?? "Couldn't load Linear issues";
}

export function statusLine(status, now = new Date()) {
  if (!status?.connected) return 'Not connected';
  if (status.source === 'api_key') return status.user?.name ? `API key · ${status.user.name}` : 'API key';
  if (status.source === 'claude_mcp') {
    const expiry = Date.parse(status.expires_at);
    const hours = Math.max(0, Math.ceil((expiry - now) / 3600000));
    return Number.isFinite(hours) ? `Claude Code connection · expires in ${hours}h` : 'Claude Code connection';
  }
  return 'Not connected';
}
