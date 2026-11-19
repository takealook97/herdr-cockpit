const DAY = 86400000;
const SEEN_LIMIT = 500;
const STATUS_TITLES = new Map([
  ['started', 'In Progress'],
  ['unstarted', 'Todo'],
  ['backlog', 'Backlog'],
  ['triage', 'Triage'],
]);
const GROUP_ORDER = ['blocked', 'review', ...STATUS_TITLES.keys()];

export function groupType(issue) {
  const type = issue?.status_type;
  if (type === 'started') {
    if (/blocked/i.test(issue.status)) return 'blocked';
    if (/review/i.test(issue.status)) return 'review';
  }
  return STATUS_TITLES.has(type) ? type : null;
}

function preferredTitle({ type, title }) {
  return (type === 'backlog' || type === 'unstarted') && title === STATUS_TITLES.get(type);
}

function dueDay(due) {
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return Infinity;
  const date = new Date(due + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().startsWith(due) ? +date / DAY : Infinity;
}

const priority = value => [1, 2, 3, 4].includes(value) ? value : 5;
const updated = issue => Date.parse(issue.updated_at) || 0;

export function groupIssues(issues) {
  const grouped = new Map();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const type = groupType(issue);
    if (!type) continue;
    const title = typeof issue.status === 'string' && issue.status.trim()
      ? issue.status : STATUS_TITLES.get(issue.status_type);
    const key = `${type}:${title}`;
    if (!grouped.has(key)) grouped.set(key, { key, title, type, issues: [] });
    grouped.get(key).issues.push(issue);
  }
  const groups = [...grouped.values()];
  for (const { issues: rows } of groups) {
    rows.sort((a, b) => dueDay(a.due_date) - dueDay(b.due_date) ||
      priority(a.priority) - priority(b.priority) || updated(b) - updated(a));
  }
  return groups.sort((a, b) => GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type) ||
    Number(preferredTitle(b)) - Number(preferredTitle(a)) || a.title.localeCompare(b.title));
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

export function priorityLevel(value) {
  return ['urgent', 'high', 'medium', 'low', 'none'][priority(value) - 1];
}

export function priorityName(value) {
  return ['Urgent', 'High', 'Medium', 'Low', 'No priority'][priority(value) - 1];
}

export function badgeState(issues, now = new Date()) {
  const open = (Array.isArray(issues) ? issues : []).filter(issue => groupType(issue));
  return {
    count: open.length,
    alert: open.some(issue => groupType(issue) === 'blocked' || dueBadge(issue.due_date, now)?.tone === 'crit'),
  };
}

export function seenAccount(snapshot) {
  return snapshot?.org_url || snapshot?.source || null;
}

function openIdentifiers(issues) {
  return (Array.isArray(issues) ? issues : [])
    .filter(issue => groupType(issue) && typeof issue.identifier === 'string' && issue.identifier)
    .map(issue => issue.identifier);
}

export function unreadIds(issues, seen, account) {
  if (!account || seen?.account !== account || !Array.isArray(seen.ids)) return new Set();
  const known = new Set(seen.ids);
  return new Set(openIdentifiers(issues).filter(id => !known.has(id)));
}

export function nextSeen(issues, account) {
  return { account, ids: [...new Set(openIdentifiers(issues))].sort().slice(0, SEEN_LIMIT) };
}

export function plainDescription(md, max = 1500) {
  if (typeof md !== 'string') return '';
  const plain = md
    .replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '[image]')
    .replace(/\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/^[ \t]*(?:>[ \t]*)+/gm, '')
    .replace(/^[ \t]*#+[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '• ')
    .replace(/\*\*|__|`/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n')
    .trim();
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : plain;
}

const errors = new Map([
  ['not_connected', 'Connect Linear in settings'],
  ['expired', 'Claude Code Linear session expired — use Linear in Claude Code once, or add an API key'],
  ['forbidden', 'Linear denied access'],
  ['invalid_key', 'That API key was rejected'],
  ['store_failed', "Couldn't save the key"],
  ['helper', 'herdr-hud unavailable'],
  ['not_found', 'Issue not found'],
  ['bad_request', 'Invalid issue id'],
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
