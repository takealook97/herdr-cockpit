import test from 'node:test';
import assert from 'node:assert/strict';
import { VISIBLE_KEYS, readVisible, toggleVisible } from './prefs.js';
import { groupIssues, dueBadge, projectShort, priorityLevel, priorityName, plainDescription, badgeState, seenAccount, unreadIds, nextSeen, errorText, statusLine } from './linear.js';

test('unread tracking baselines new accounts and compares only current open issue identifiers', () => {
  const account = seenAccount({ org: { url: 'https://linear.app/fixture' }, source: 'api_key', user: { name: 'Viewer A' } });
  assert.equal(account, 'api_key|https://linear.app/fixture|Viewer A');
  assert.equal(seenAccount({ org: null, source: 'api_key', user: { name: 'Viewer A' } }), null);
  assert.equal(seenAccount({ org: { url: 'https://linear.app/fixture' }, source: 'api_key' }), null);
  assert.equal(seenAccount({ source: null }), null);
  assert.equal(seenAccount(undefined), null);
  const issue = (identifier, status_type = 'unstarted') => ({ identifier, status_type, title: 'Fixture title' });
  const current = [issue('TEST-3'), issue('TEST-2'), issue('TEST-2'), issue('TEST-4', 'completed')];
  const before = nextSeen([issue('TEST-2'), issue('TEST-1')], account);
  assert.deepEqual(unreadIds(current, undefined, account), new Set());
  assert.deepEqual(unreadIds(current, before, 'another-account'), new Set());
  assert.deepEqual(unreadIds(current, before, account), new Set(['TEST-3']));
  assert.deepEqual(nextSeen(current, account), { account, ids: ['TEST-2', 'TEST-3'] });
  const tooMany = Array.from({ length: 501 }, (_, i) => issue(`TEST-${501 - i}`));
  assert.deepEqual(nextSeen(tooMany, account).ids, tooMany.map(row => row.identifier).sort().slice(0, 500));
});

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

test('projects and priorities use the mod display formats', () => {
  assert.equal(projectShort('Company / Country /  Project '), 'Project');
  assert.equal(projectShort('Project'), 'Project');
  assert.equal(projectShort(null), '');
  assert.deepEqual([0, undefined, 1, 2, 3, 4, 5, '__proto__'].map(priorityLevel),
    ['none', 'none', 'urgent', 'high', 'medium', 'low', 'none', 'none']);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(priorityName),
    ['No priority', 'Urgent', 'High', 'Medium', 'Low', 'No priority']);
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
    not_found: 'Issue not found',
    bad_request: 'Invalid issue id',
  };
  for (const [code, message] of Object.entries(expected)) assert.equal(errorText(code), message);
  for (const code of ['network', 'bad_response', 'busy', 'private diagnostic']) assert.equal(errorText(code), "Couldn't load Linear issues");
});


test('plain description strips supported Markdown, preserves line breaks and caps text', () => {
  const md = [
    '  ## Summary', '![diagram](https://example.invalid/diagram_(a).png) and [notes](https://example.invalid/notes)',
    '> **Important** __detail__ with `code`', '- first', '  + second', '* third', '3. fourth',
    '', '  ', '', 'Last paragraph  ',
  ].join('\r\n');
  assert.equal(plainDescription(md), [
    'Summary', '[image] and notes', 'Important detail with code', '• first', '• second', '• third', '• fourth',
    '', 'Last paragraph',
  ].join('\n'));
  assert.equal(plainDescription('   > `   '), '');
  assert.equal(plainDescription(null), '');
  assert.equal(plainDescription('😀😀z', 2), '😀😀…');
  assert.equal(plainDescription('a'.repeat(1500)), 'a'.repeat(1500));
  assert.equal(plainDescription('a'.repeat(1501)), 'a'.repeat(1500) + '…');
});
