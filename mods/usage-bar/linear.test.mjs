import test from 'node:test';
import assert from 'node:assert/strict';
import { VISIBLE_KEYS, readVisible, toggleVisible } from './prefs.js';
import { groupIssues, dueBadge, projectShort, priorityLevel, badgeState, isLinearURL, errorText, statusLine } from './linear.js';

test('visibility defaults, malformed inputs and immutable toggles', () => {
  const defaults = { codex: true, claude: true, gemini: true, linear: true, system: true };
  assert.deepEqual(VISIBLE_KEYS, Object.keys(defaults));
  for (const bad of [undefined, null, [], 'claude', 0, { codex: 0, claude: 'false', other: false }]) {
    assert.deepEqual(readVisible(bad), defaults);
  }
  const stored = Object.freeze({ codex: false, linear: true, other: 'ignored' });
  const toggled = toggleVisible(stored, 'linear');
  assert.deepEqual(toggled, { ...defaults, codex: false, linear: false });
  assert.equal(stored.linear, true);
  assert.deepEqual(toggleVisible(toggled, 'other'), toggled);
});

test('open issues group by status name and sort by due date, priority and recent update', () => {
  const issue = (identifier, status_type, overrides) => Object.freeze({ identifier, status_type, ...overrides });
  const data = Object.freeze([
    issue('none', 'started', { priority: 0 }),
    issue('old', 'started', { due_date: '2026-11-20', priority: 2, updated_at: '2026-11-13T00:00:00Z' }),
    issue('backlog', 'backlog', { status: 'Backlog' }),
    issue('later', 'started', { due_date: '2026-11-22', priority: 1 }),
    issue('due', 'started', { due_date: '2026-11-19' }),
    issue('blocked', 'started', { status: 'BLOCKED', due_date: '2026-11-21' }),
    issue('review', 'started', { status: 'In Review' }),
    issue('recent', 'started', { due_date: '2026-11-20', priority: 2, updated_at: '2026-11-14T00:00:00Z' }),
    issue('urgent', 'started', { due_date: '2026-11-20', priority: 1 }),
    issue('no-priority', 'started', { due_date: '2026-11-20', priority: 0 }),
    issue('low', 'started', { priority: 4 }),
    issue('triage', 'triage', { status: 'Triage' }),
    issue('ready', 'unstarted', { status: 'A Ready' }),
    issue('todo', 'unstarted', { status: 'Todo' }),
    issue('testing', 'started', { status: 'Testing' }),
    issue('blocked-review', 'started', { status: 'BLOCKED review' }),
    issue('done', 'completed'),
    issue('canceled', 'canceled'),
    issue('unknown', 'blocked', { status: 'Blocked' }),
  ]);
  const groups = groupIssues(data);
  assert.deepEqual(groups.map(({ type, title, issues }) => [type, title, issues.map(row => row.identifier)]), [
    ['blocked', 'BLOCKED', ['blocked']],
    ['blocked', 'BLOCKED review', ['blocked-review']],
    ['review', 'In Review', ['review']],
    ['started', 'In Progress', ['due', 'urgent', 'recent', 'old', 'no-priority', 'later', 'low', 'none']],
    ['started', 'Testing', ['testing']],
    ['unstarted', 'Todo', ['todo']],
    ['unstarted', 'A Ready', ['ready']],
    ['backlog', 'Backlog', ['backlog']],
    ['triage', 'Triage', ['triage']],
  ]);
  assert.equal(new Set(groups.map(group => group.key)).size, groups.length);
  assert.deepEqual(groupIssues(null), []);
});

test('Backlog comes before other backlog status names, including 구체화 중', () => {
  const rows = ['구체화 중', 'A Ideas', 'Backlog'].map(status => ({ status_type: 'backlog', status }));
  const [first, ...rest] = groupIssues(rows);
  assert.equal(first.title, 'Backlog');
  assert.deepEqual(new Set(rest.map(group => group.title)), new Set(['A Ideas', '구체화 중']));
});

test('missing and empty status names use their type titles', () => {
  for (const [status_type, title] of [
    ['started', 'In Progress'], ['unstarted', 'Todo'], ['backlog', 'Backlog'], ['triage', 'Triage'],
  ]) {
    const rows = [{ status_type }, { status_type, status: '' }, { status_type, status: title }];
    const [group, extra] = groupIssues(rows);
    assert.equal(group.title, title);
    assert.equal(group.type, status_type);
    assert.deepEqual(group.issues, rows);
    assert.equal(extra, undefined);
  }
});

test('due badges count calendar days across DST and honor the urgency boundary', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // This is still March 13 locally, the day before the clock moves forward.
    const now = new Date('2027-03-14T07:00:00Z');
    for (const [date, text, tone] of [
      ['2027-03-18', 'D-5', 'dim'],
      ['2027-03-17', 'D-4', 'dim'],
      ['2027-03-16', 'D-3', 'warn'],
      ['2027-03-14', 'D-1', 'warn'],
      ['2027-03-13', 'Today', 'warn'],
      ['2027-03-10', '3d over', 'crit'],
    ]) assert.deepEqual(dueBadge(date, now), { text, tone });
    for (const date of [null, 'invalid', '2027-02-30', '2027-3-13', '2027-03-13T00:00:00Z']) {
      assert.equal(dueBadge(date, now), null);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('badge counts open issues and alerts on blocked or overdue work', () => {
  const now = new Date(2026, 10, 19, 12);
  const todo = { status_type: 'unstarted', due_date: '2026-11-19' };
  const completed = { status_type: 'completed', due_date: '2026-11-18' };
  assert.deepEqual(badgeState([todo, completed], now), { count: 1, alert: false });
  assert.deepEqual(badgeState([{ ...todo, due_date: '2026-11-18' }], now), { count: 1, alert: true });
  assert.deepEqual(badgeState([{ status_type: 'started', status: 'Blocked' }], now), { count: 1, alert: true });
  assert.deepEqual(badgeState([
    { status_type: 'started', status: 'In Review' }, { status_type: 'backlog', status: 'Blocked' },
  ], now), { count: 2, alert: false });
  assert.deepEqual(badgeState(undefined, now), { count: 0, alert: false });
});

test('projects, priorities and issue links use the mod display formats', () => {
  assert.equal(projectShort('Company / Country /  Project '), 'Project');
  assert.equal(projectShort('Project'), 'Project');
  assert.equal(projectShort(null), '');
  assert.deepEqual([0, undefined, 1, 2, 3, 4, 5, '__proto__'].map(priorityLevel),
    ['none', 'none', 'urgent', 'high', 'medium', 'low', 'none', 'none']);
  assert.equal(isLinearURL('https://linear.app/team/issue/X-1'), true);
  for (const bad of [null, 'http://linear.app/', 'https://linear.app', 'https://linear.app.evil.test/', 'https://linear.app@evil.test/']) {
    assert.equal(isLinearURL(bad), false);
  }
});

test('connection status and public errors use fixed copy', () => {
  assert.equal(statusLine({ connected: true, source: 'api_key', user: { name: 'Viewer' } }), 'API key · Viewer');
  const mcp = { connected: true, source: 'claude_mcp', expires_at: '2026-11-19T05:00:00Z' };
  assert.equal(statusLine(mcp, new Date('2026-11-19T00:15:00Z')), 'Claude Code connection · expires in 5h');
  assert.equal(statusLine({ ...mcp, expires_at: null }), 'Claude Code connection');
  assert.equal(statusLine({ connected: false }), 'Not connected');
  const expected = {
    not_connected: 'Connect Linear in settings',
    expired: 'Claude Code Linear session expired — use Linear in Claude Code once, or add an API key',
    forbidden: 'Linear denied access',
    invalid_key: 'That API key was rejected',
    store_failed: "Couldn't save the key",
    helper: 'herdr-hud unavailable',
  };
  for (const [code, message] of Object.entries(expected)) assert.equal(errorText(code), message);
  for (const code of ['network', 'bad_response', 'busy', 'private diagnostic']) assert.equal(errorText(code), "Couldn't load Linear issues");
});
