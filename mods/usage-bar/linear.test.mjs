import test from 'node:test';
import assert from 'node:assert/strict';
import { VISIBLE_KEYS, readVisible, toggleVisible } from './prefs.js';
import { groupIssues, dueBadge, projectShort, priorityGlyph, badgeState, isLinearURL, errorText, statusLine } from './linear.js';

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

test('open issues group by state and sort by due date, priority and recent update', () => {
  const issue = (identifier, status_type, overrides) => Object.freeze({ identifier, status_type, ...overrides });
  const data = Object.freeze([
    issue('none', 'started', { priority: 0 }),
    issue('old', 'started', { due_date: '2026-11-20', priority: 2, updated_at: '2026-11-13T00:00:00Z' }),
    issue('backlog', 'backlog', { status: 'Blocked' }),
    issue('later', 'started', { due_date: '2026-11-22', priority: 1 }),
    issue('due', 'started', { due_date: '2026-11-19' }),
    issue('blocked', 'started', { status: 'BLOCKED' }),
    issue('recent', 'started', { due_date: '2026-11-20', priority: 2, updated_at: '2026-11-14T00:00:00Z' }),
    issue('urgent', 'started', { due_date: '2026-11-20', priority: 1 }),
    issue('no-priority', 'started', { due_date: '2026-11-20', priority: 0 }),
    issue('low', 'started', { priority: 4 }),
    issue('triage', 'triage'),
    issue('todo', 'unstarted'),
    issue('done', 'completed'),
    issue('canceled', 'canceled'),
  ]);
  assert.deepEqual(groupIssues(data).map(({ title, issues }) => [title, issues.map(row => row.identifier)]), [
    ['Blocked', ['blocked']],
    ['In Progress', ['due', 'urgent', 'recent', 'old', 'no-priority', 'later', 'low', 'none']],
    ['Todo', ['todo']],
    ['Backlog', ['backlog']],
    ['Triage', ['triage']],
  ]);
  assert.deepEqual(groupIssues([data[2]]).map(group => group.key), ['backlog']);
  assert.deepEqual(groupIssues(null), []);
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
  assert.deepEqual(badgeState(undefined, now), { count: 0, alert: false });
});

test('projects, priorities and issue links use the mod display formats', () => {
  assert.equal(projectShort('Company / Country /  Project '), 'Project');
  assert.equal(projectShort('Project'), 'Project');
  assert.equal(projectShort(null), '');
  assert.deepEqual([0, 1, 2, 3, 4, 5, '__proto__'].map(priorityGlyph), ['–', '!', '↑', '→', '↓', '–', '–']);
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
  for (const code of ['network', 'bad_response', 'private diagnostic']) assert.equal(errorText(code), "Couldn't load Linear issues");
});
