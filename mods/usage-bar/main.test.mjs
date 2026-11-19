import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as format from './format.js';
import * as linear from './linear.js';
import { LinearDetails } from './linear-detail.js';
import * as prefs from './prefs.js';

// Real HUD fixture shape, with Gemini added. No network or app state is used.
const fixture = {
  sys: { cpu_pct: 23.4, mem_used_bytes: 23730000000, mem_total_bytes: 38654705664 },
  usage: { accounts: [
    { provider: 'codex', home: '/work', id: 'work', label: 'work@example.invalid', plan: 'prolite', five_hour: null,
      weekly: { used_pct: 9, resets_at: '2026-11-04T15:37:06+09:00' },
      coupons: { available: 2, next_expires_at: '2026-11-30T00:00:00+09:00' }, terminals: ['t2w'], stale: false, error: '' },
    { provider: 'claude', home: '', id: 'default', label: 'me', plan: 'max',
      five_hour: { used_pct: 34, resets_at: '2026-11-03T15:10:00+09:00' },
      weekly: { used_pct: 81, resets_at: '2026-11-10T10:59:59+09:00' },
      coupons: { available: 3, next_expires_at: '2026-12-10T22:00:00Z' }, terminals: ['t2t'], stale: true, error: 'HTTP 429' },
    { provider: 'gemini', id: 'agy', label: '',
      five_hour: { used_pct: 12, resets_at: '2026-11-03T15:10:00+09:00' },
      weekly: { used_pct: 34, resets_at: '2026-11-10T10:59:59+09:00' } },
  ] },
};

function element(kind) {
  const target = { kind, nodes: [], style: {} };
  const proxy = new Proxy(target, { get(obj, key) {
    if (key in obj) return obj[key];
    return (...args) => {
      if (key === 'child') obj.nodes.push(args[0]);
      else if (key === 'children') obj.nodes.push(...args[0]);
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else obj.style[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}
const strip = code => code.replace(/^import .*;\n/gm, '').replace(/export default /g, '').replace(/export /g, '');
const div = () => element('div'), h_flex = () => element('row'), v_flex = () => element('column');
const source = filename => strip(readFileSync(new URL(filename, import.meta.url), 'utf8'));
const controls = kind => ({ new: id => element(kind).id(id) });
const evaluate = (filename, deps, result) =>
  new Function(...Object.keys(deps), `${source(filename)}; return ${result};`)(...Object.values(deps));
const ui = evaluate('./ui.js', { div, h_flex, v_flex, Button: controls('button'), ...format },
  '{cell, groupLabel, systemRow, iconButton, linearButton, openLinearKeySettings}');
const walk = node => typeof node === 'object' ? [node, ...node.nodes.flatMap(walk)] : [node];
const text = node => walk(node).filter(value => typeof value === 'string');
const byID = (node, id) => walk(node).find(value => value?.style?.id === id);

const org = { name: 'Example', url: 'https://linear.app/example' };
const issue = { identifier: 'TEST-1', title: 'An assigned issue', url: org.url + '/issue/TEST-1',
  status: 'Blocked', status_type: 'started', priority: 1, project: 'Example / Test Project', due_date: '2000-01-01' };
const statusReply = { connected: true, source: 'claude_mcp', org, expires_at: '2099-07-10T12:00:00Z', error: null };
const issuesReply = { source: 'claude_mcp', issues: [issue], org_url: org.url, stale: false, error: null };
const apiKeyStatus = { ...statusReply, source: 'api_key', user: { name: 'First Viewer' }, expires_at: null };
const nextAPIKeyStatus = { ...apiKeyStatus, user: { name: 'Second Viewer' } };
const apiKeyIssues = { ...issuesReply, source: 'api_key' };
const unavailable = { code: 127, stdout: '' };
const reply = (data, code = 0, stderr = '') => ({ code, stdout: JSON.stringify(data), stderr });
const linearCalls = h => h.calls.filter(call => call.args[3] === 'linear').map(call => call.args.slice(4));
const click = (tree, id, cx) => byID(tree, id).style.on_click({}, cx);

function harness({ panel, machine, store = new Map(), initialResponse } = {}) {
  const state = {
    spaces: [{ id: 's1', active: true, machine, tabs: [{ id: 'tb1' }] }],
    panes: [{ tab: 'tb1', terminal: 't2t' }, { tab: 'tb1', terminal: 't2w' },
      { tab: 'tb1', terminal: 'remote/t9' }, { tab: 'tb1', terminal: null }, { tab: 'other', terminal: 't99' }],
    agents: [{ space: 's1', address: 't2t', status: 'working' }],
  };
  const calls = [], tasks = [], timers = [], intervals = [];
  const overlays = [], closed = [], urls = [], writes = [];
  const fallback = args => args[1] === 'linear' ? reply(args[2] === 'status' ? statusReply : issuesReply)
    : reply(args[1] === 'sys' ? fixture.sys : fixture.usage);
  let respond = initialResponse ?? fallback;
  let stopped = 0;
  const cx = {
    timer: {
      after(ms, fn) { const job = { ms, fn, canceled: false, cancel() { this.canceled = true; } }; timers.push(job); return job; },
      every(ms, fn) { intervals.push({ ms, fn }); },
    },
    spawn(fn) { const task = fn(cx); tasks.push(task); return task; },
    notify() {}, stop_propagation() { stopped++; },
    focus_handle: () => ({ focus() {}, release() {} }),
    open_url(url) { urls.push(url); },
  };
  const InputState = { new(options) {
    let value = '';
    const handlers = {};
    return { options, handlers, set_masked(masked) { this.masked = masked; },
      value: () => value, set_value(next) { value = next; },
      on(event, handler) { handlers[event] = handler; }, release() { value = ''; } };
  } };
  const deps = { View: class {}, LinearDetails, div, h_flex, v_flex, Switch: controls('switch'), InputState,
    Input: { new: input => element('input').input(input) },
    exec: async (cmd, args, ...options) => {
      calls.push({ cmd, args, opts: options[0], options });
      return respond(cmd === 'sh' ? ['hud', ...args.slice(3)] : args);
    },
    spaces: () => state.spaces, panes: () => state.panes, agents: () => state.agents,
    theme: () => new Proxy({}, { get: (_obj, prop) => prop }), ...format, ...ui, ...prefs, ...linear,
    props: () => panel ? { panel, overlay: panel + '-overlay' } : {},
    openOverlay: spec => overlays.push(spec), closeOverlay: id => closed.push(id),
    shared: key => store.get(key), setShared: (key, value) => { store.set(key, value); writes.push(key); } };
  const panels = evaluate('./panels.js', deps, '{linearPanel, settingsPanel, openPanel}');
  const UsageBar = evaluate('./main.js', { ...deps, ...panels }, 'UsageBar');
  const view = new UsageBar();
  view.init({}, cx);
  return { view, cx, state, calls, timers, intervals, overlays, closed, urls, store, writes, fallback,
    stopped: () => stopped,
    respond(fn) { respond = fn; },
    async flush() { while (tasks.length) await Promise.all(tasks.splice(0)); },
    tick(ms) {
      const jobs = timers.filter(job => job.ms === ms && !job.canceled);
      for (const job of jobs) { job.canceled = true; job.fn(cx); }
    },
  };
}

test('poll intervals and selected account arguments', async () => {
  const h = harness(); await h.flush();
  assert.deepEqual(h.intervals.map(job => job.ms), [1000, 60000, 1800000]);
  assert.deepEqual(h.calls.map(call => ['hud', ...call.args.slice(3)]).filter(args => args[1] === 'usage'), [['hud', 'usage', '--selected', '--max-age', '45s']]);
});

test('provider cards show compact weekly usage, coupon text and stale opacity', async () => {
  const h = harness(); await h.flush();
  const tree = h.view.render(h.cx), labels = text(tree);
  assert.deepEqual(byID(tree, 'groups').nodes.map(node => node.style.id), ['account-codex', 'account-claude', 'account-gemini']);
  assert.deepEqual(tree.nodes.map(node => node.style.id), ['groups', undefined, 'linear', 'system', 'gear']);
  assert.ok(['codex', 'claude', 'gemini', '2 resets', 'work'].every(label => labels.includes(label)));
  assert.ok(!labels.some(label => /5h|Week|max|prolite|default|⚠|🎟|@/.test(label)));
  const codex = byID(tree, 'account-codex');
  assert.equal(codex.nodes[0].nodes[1].style.min_w, undefined); // cells hug their content
  assert.equal(codex.nodes[0].nodes[2].style.min_w, undefined);
  assert.equal(byID(tree, 'account-claude').nodes[0].style.opacity, 0.6);
  assert.ok(text(byID(tree, 'account-claude')).includes('3 resets'));
  assert.ok(!text(byID(tree, 'account-gemini')).some(label => label.includes('resets')));
  assert.equal(byID(tree, 'account-gemini').nodes[0].nodes[0].nodes.length, 1);
  assert.ok(walk(tree).some(node => node?.style?.w === 28 && node?.style?.h === 2));
  const fullWidth = 24 + 40 + 38 + 110 + 178 +
    3 * (format.labelWidth(true) + format.cellWidth('weekly') + 16 + 2 + 8) + 20 + 2 * (format.cellWidth('coupon') + 8);
  h.view.width = fullWidth - 1;
  assert.ok(!walk(h.view.render(h.cx)).some(node => node?.style?.w === 28 && node?.style?.h === 2));
  h.view.width = fullWidth - (36 + 3 * 32) - 1;
  assert.ok(!text(h.view.render(h.cx)).includes('work'));
  h.view.byMachine[''].usage.accounts[0].weekly = null;
  h.view.byMachine[''].usage.accounts[0].coupons = undefined;
  const missing = byID(h.view.render(h.cx), 'account-codex').nodes[0];
  assert.deepEqual(text(missing.nodes[1]), ['—', '']);
  assert.deepEqual(text(missing.nodes[2]), ['—', '']);
});

test('space switches do not trigger usage refresh', async () => {
  const h = harness(); await h.flush();
  const count = h.calls.length;
  h.state.spaces[0].id = 's2';
  h.view.render(h.cx); h.tick(0); h.tick(1000); await h.flush();
  assert.equal(h.calls.length, count);
});

test('working completion transitions debounce reads for two seconds', async () => {
  for (const status of ['done', 'idle', 'blocked']) {
    const h = harness(); await h.flush(); h.tick(1000); await h.flush();
    h.state.agents[0].status = status;
    const count = h.calls.length;
    h.view.render(h.cx); h.tick(0);
    assert.equal(h.calls.length, count);
    assert.ok(h.timers.some(job => job.ms === 2000 && !job.canceled));
    h.tick(2000); await h.flush();
    assert.equal(h.calls.length, count + 1);
    assert.ok(!h.calls.at(-1).args.includes('--refresh'));
  }
});

test('completion bursts cancel previous debounce and ignore agents in other spaces', async () => {
  const h = harness(); await h.flush();
  h.state.agents[0].status = 'done'; h.view.render(h.cx); h.tick(0);
  const first = h.timers.at(-1);
  h.state.agents[0].status = 'working'; h.view.render(h.cx); h.tick(0);
  h.state.agents[0].status = 'blocked'; h.view.render(h.cx); h.tick(0);
  assert.equal(first.canceled, true);
  assert.equal(h.timers.filter(job => job.ms === 2000 && !job.canceled).length, 1);
  const count = h.timers.length;
  h.state.agents.push({ space: 'other', address: 't99', status: 'done' });
  h.view.render(h.cx);
  assert.equal(h.timers.length, count);
});

test('failures show placeholders and partial errors preserve only the same account', async () => {
  const h = harness(); await h.flush(); h.tick(1000); await h.flush();
  h.respond(() => ({ code: 1, stdout: '' }));
  h.view.refresh('usage', h.cx); await h.flush();
  assert.equal(h.view.byMachine[''].usage, null);
  assert.equal(h.view.byMachine[''].stale.usage, true);
  assert.equal(byID(h.view.render(h.cx), 'account-codex').nodes[0].style.opacity, 0.6);
  h.respond(() => ({ code: 0, stdout: JSON.stringify(fixture.usage) }));
  h.view.refresh('usage', h.cx); await h.flush();
  h.respond(() => ({ code: 0, stdout: JSON.stringify({ accounts: [{ ...fixture.usage.accounts[0], weekly: null, error: 'offline' }] }) }));
  h.view.refresh('usage', h.cx); await h.flush();
  assert.equal(h.view.byMachine[''].usage.accounts[0].weekly.used_pct, 9);
  assert.equal(h.view.byMachine[''].usage.accounts[0].stale, true);
  h.respond(() => ({ code: 0, stdout: JSON.stringify({ accounts: [{ provider: 'codex', id: 'different', home: '/work', error: 'offline' }] }) }));
  h.view.refresh('usage', h.cx); await h.flush();
  assert.equal(h.view.byMachine[''].usage.accounts[0].weekly, undefined);
});

test('machine switches show cached readings immediately and debounce remote reads', async () => {
  const h = harness(); await h.flush();
  h.state.spaces[0].machine = 'workstation';
  assert.ok(!text(h.view.render(h.cx)).includes('work'));
  h.tick(0); h.tick(300); await h.flush();
  const remote = h.calls.slice(-2);
  assert.deepEqual(remote.map(call => [call.cmd, call.opts, call.args.slice(2)]), [
    ['sh', { on: 'workstation' }, ['hud', 'sys']],
    ['sh', { on: 'workstation' }, ['hud', 'usage', '--selected', '--max-age', '45s']],
  ]);
  h.state.spaces[0].machine = '';
  assert.ok(text(h.view.render(h.cx)).includes('work'));
  h.tick(0);
  h.state.spaces[0].machine = 'workstation';
  assert.ok(text(h.view.render(h.cx)).includes('work'));
});

test('provider and system cards have visible borders and wider separation', async () => {
  const h = harness(); await h.flush();
  const tree = h.view.render(h.cx);
  for (const id of ['account-codex', 'account-claude', 'account-gemini', 'system']) {
    const card = byID(tree, id);
    assert.equal(card.style.border, 1);
    assert.equal(card.style.border_color, 'muted66');
  }
  assert.equal(tree.style.gap, 10);
  assert.equal(byID(tree, 'groups').style.gap, 10);
});

test('settings switches apply immediately and persist across bar instances', async () => {
  const bar = harness(), settings = harness({ panel: 'settings', store: bar.store });
  await Promise.all([bar.flush(), settings.flush()]);
  const popup = settings.view.render(settings.cx);
  assert.ok(['Codex', 'Claude', 'Gemini', 'Linear', 'CPU · RAM'].every(label => text(popup).includes(label)));
  for (const key of prefs.VISIBLE_KEYS) {
    assert.equal(byID(popup, 'visible-' + key).style.checked, true);
    click(popup, 'visible-' + key, settings.cx);
  }
  assert.deepEqual(settings.store.get('usage-bar.visible'),
    { codex: false, claude: false, gemini: false, linear: false, system: false });
  assert.deepEqual(bar.view.render(bar.cx).nodes.map(node => node.style.id), [undefined, 'gear']);
  assert.equal(byID(settings.view.render(settings.cx), 'visible-codex').style.checked, false);

  const restarted = harness({ store: settings.store });
  await restarted.flush();
  assert.deepEqual(restarted.view.render(restarted.cx).nodes.map(node => node.style.id), [undefined, 'gear']);
  const startup = [['status'], ['issues', '--max-age', '60s']];
  assert.deepEqual(linearCalls(restarted), []);
  restarted.intervals.find(job => job.ms === 1800000).fn(restarted.cx);
  restarted.store.set('usage-bar.linear-rev', 1);
  restarted.view.render(restarted.cx); restarted.tick(0); await restarted.flush();
  assert.deepEqual(linearCalls(restarted), []);
  click(popup, 'visible-linear', settings.cx);
  assert.ok(byID(restarted.view.render(restarted.cx), 'linear'));
  restarted.intervals.find(job => job.ms === 1800000).fn(restarted.cx);
  assert.deepEqual(linearCalls(restarted), []);
  restarted.tick(0); await restarted.flush();
  restarted.view.render(restarted.cx); restarted.tick(0); await restarted.flush();
  assert.deepEqual(linearCalls(restarted), startup);
});

test('right-hand cards fit at 320 pixels, with providers clipped inside their group', async () => {
  const h = harness(); await h.flush();
  h.view.width = 320;
  const tree = h.view.render(h.cx);
  const groups = byID(tree, 'groups');
  assert.equal(groups.style.min_w, 0);
  assert.equal(groups.style.overflow_hidden.length, 0);
  assert.equal(groups.style.max_w, 2);
  assert.equal(byID(tree, 'gear').style.w, 38);
  assert.deepEqual(tree.nodes.slice(-3).map(node => node.style.id), ['linear', 'system', 'gear']);
});

test('bar buttons open popups at the mouse anchor and omit it for keyboard activation', async () => {
  const h = harness(); await h.flush();
  const tree = h.view.render(h.cx);
  for (const [id, panel, width, x] of [['linear', 'linear', 440, 260], ['gear', 'settings', 320, 950]]) {
    byID(tree, id).style.on_mouse_down[1]({ position: { x, y: 32 } }, h.cx);
    click(tree, id, h.cx);
    assert.deepEqual(h.overlays.at(-1), { mod: 'usage-bar', kind: 'popup', width, props: { panel },
      at: { x: Math.max(8, x - width + 24), y: 48 } });
  }
  assert.equal(h.stopped(), 2);
  byID(tree, 'gear').style.on_mouse_down[1]({ position: { x: 950 } }, h.cx);
  byID(tree, 'gear').style.on_key_down({ key: 'enter' }, h.cx);
  click(tree, 'gear', h.cx);
  assert.deepEqual(h.overlays.at(-1), { mod: 'usage-bar', kind: 'popup', width: 320, props: { panel: 'settings' } });
});

test('popup initialization stays local and starts no bar timers', async () => {
  for (const [panel, expected] of [['linear', [['issues', '--max-age', '60s'], ['status']]], ['settings', [['status']]]]) {
    const store = new Map([['usage-bar.visible', { linear: false }]]);
    const h = harness({ panel, machine: 'remote', store }); await h.flush();
    assert.equal(h.intervals.length, 0);
    assert.equal(h.timers.length, 0);
    assert.equal(h.calls.length, expected.length);
    assert.deepEqual(linearCalls(h), expected);
    assert.ok(h.calls.every(call => call.options.length === 0));
    const externalRev = (store.get('usage-bar.linear-rev') ?? 0) + 1;
    store.set('usage-bar.linear-rev', externalRev);
    h.view.render(h.cx); h.tick(0); await h.flush();
    assert.deepEqual(linearCalls(h).slice(expected.length),
      panel === 'linear' ? [['status'], ['issues', '--max-age', '60s']] : [['status']]);
    assert.equal(store.get('usage-bar.linear-rev'), externalRev);
  }

  const bar = harness({ machine: 'remote' }); await bar.flush();
  bar.intervals.find(job => job.ms === 1800000).fn(bar.cx);
  await bar.flush();
  assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s'], ['issues', '--max-age', '60s']]);
  for (const call of bar.calls.filter(call => call.args[3] === 'linear')) {
    assert.equal(call.cmd, 'sh');
    assert.deepEqual(call.args.slice(0, 4), ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud', 'linear']);
    assert.equal(call.options.length, 0);
  }
});

test('refresh drops older helper completions and makes the bar re-read after render', async () => {
  let finishInitial;
  const store = new Map();
  const bar = harness({ store }); await bar.flush();
  const popup = harness({ store, panel: 'linear', initialResponse: args => args[2] === 'issues'
    ? new Promise(resolve => { finishInitial = resolve; }) : reply(statusReply) });
  popup.respond(args => args[2] === 'issues' ? reply({ ...issuesReply, issues: [{ ...issue, title: 'New title' }] }) : reply(statusReply));
  click(popup.view.render(popup.cx), 'linear-refresh', popup.cx);
  // Let the refresh finish first without waiting on the initial issues request.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(linearCalls(popup), [['issues', '--max-age', '60s'], ['status'], ['issues', '--refresh']]);
  assert.equal(store.get('usage-bar.linear-rev'), 1);
  assert.deepEqual(popup.writes, ['usage-bar.linear-seen', 'usage-bar.linear-rev']);
  finishInitial(reply(issuesReply)); await popup.flush();
  const labels = text(popup.view.render(popup.cx));
  assert.ok(labels.includes('New title'));
  assert.ok(!labels.includes(issue.title));

  let finishBarRead;
  bar.respond(args => args[2] === 'issues'
    ? new Promise(resolve => { finishBarRead = resolve; }) : bar.fallback(args));
  assert.ok(text(byID(bar.view.render(bar.cx), 'linear')).includes('1'));
  assert.equal(linearCalls(bar).length, 2);
  bar.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(linearCalls(bar).slice(2), [['status'], ['issues', '--max-age', '60s']]);
  assert.ok(text(byID(bar.view.render(bar.cx), 'linear')).includes('1'));
  finishBarRead(reply({ ...issuesReply, issues: [] }));
  await bar.flush();
  assert.ok(text(byID(bar.view.render(bar.cx), 'linear')).includes('0'));
});

test('a successful dropdown read updates the bar count without a revision loop', async () => {
  const store = new Map();
  const bar = harness({ store }); await bar.flush();
  const newerIssues = { ...issuesReply, issues: [issue, { ...issue, identifier: 'TEST-2' }] };
  let finishStatus;
  const popup = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? new Promise(resolve => { finishStatus = resolve; }) : reply(newerIssues) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get('usage-bar.linear-rev'), 1);
  finishStatus(reply(statusReply));
  await popup.flush();
  assert.ok(text(popup.view.render(popup.cx)).includes(org.name));
  assert.deepEqual(popup.writes, ['usage-bar.linear-seen', 'usage-bar.linear-open-rev', 'usage-bar.linear-rev']);
  const button = () => byID(bar.view.render(bar.cx), 'linear');
  assert.ok(text(button()).includes('1'));
  bar.respond(args => args[2] === 'issues' ? reply(newerIssues) : bar.fallback(args));
  bar.tick(0); await bar.flush();
  assert.ok(text(button()).includes('2'));
  popup.view.render(popup.cx);
  bar.tick(0);
  popup.tick(0);
  await Promise.all([bar.flush(), popup.flush()]);
  assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s'], ['issues', '--max-age', '60s']]);
  assert.deepEqual(linearCalls(popup), [['issues', '--max-age', '60s'], ['status']]);
  assert.equal(store.get('usage-bar.linear-rev'), 1);
});

test('the unread border clears on open and dropdown dots persist through refresh', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map();
  const bar = harness({ store }); await bar.flush();
  const button = () => byID(bar.view.render(bar.cx), 'linear');
  const second = { ...issue, identifier: 'TEST-2' };
  const third = { ...issue, identifier: 'TEST-3' };
  const fourth = { ...issue, identifier: 'TEST-4' };
  const withIssues = (...issues) => reply({ ...issuesReply, issues });
  assert.deepEqual(store.get(seenKey), { account: org.url, ids: ['TEST-1'] });
  assert.equal(button().style.border, 1);
  assert.equal(button().style.border_color, 'muted66');
  assert.equal(button().style.tooltip, 'Assigned Linear issues');

  bar.respond(args => args[2] === 'issues' ? withIssues(issue, second) : bar.fallback(args));
  const poll = bar.intervals.find(job => job.ms === 1800000);
  poll.fn(bar.cx); await bar.flush();
  assert.equal(button().style.tooltip, '1 new issue');

  // Reading the key also updates the badge without making another Linear request.
  store.set(seenKey, { account: org.url, ids: ['TEST-1', 'TEST-2'] });
  assert.equal(button().style.tooltip, 'Assigned Linear issues');
  assert.equal(linearCalls(bar).length, 3);

  store.set(seenKey, { account: org.url, ids: ['TEST-1'] });
  bar.respond(args => args[2] === 'issues' ? withIssues(issue, second, third) : bar.fallback(args));
  poll.fn(bar.cx); await bar.flush();
  assert.equal(button().style.border, 1.5);
  assert.equal(button().style.border_color, 'accent');
  assert.equal(button().style.tooltip, '2 new issues');
  assert.ok(button().nodes.some(node => node.style.bg === 'blocked'));
  assert.deepEqual(store.get(seenKey), { account: org.url, ids: ['TEST-1'] });

  const popup = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? reply(statusReply) : withIssues(second, third) });
  await popup.flush();
  const render = () => popup.view.render(popup.cx);
  const dot = id => byID(render(), 'issue-' + id).nodes[0].style;
  assert.deepEqual(store.get(seenKey), { account: org.url, ids: ['TEST-2', 'TEST-3'] });
  assert.equal(button().style.tooltip, 'Assigned Linear issues');
  assert.equal(button().style.border_color, 'muted66');
  assert.equal(dot('TEST-2').bg, 'accent');
  assert.equal(dot('TEST-3').size, 6);

  popup.respond(args => args[2] === 'issues' ? withIssues(second, third, fourth) : popup.fallback(args));
  click(render(), 'linear-refresh', popup.cx);
  await popup.flush();
  assert.equal(dot('TEST-2').bg, 'accent');
  assert.equal(dot('TEST-4').bg, 'accent');
  assert.deepEqual(store.get(seenKey), { account: org.url, ids: ['TEST-2', 'TEST-3', 'TEST-4'] });

  popup.view.close();
  const reopened = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? reply(statusReply) : withIssues(second, third, fourth) });
  await reopened.flush();
  const reserved = byID(reopened.view.render(reopened.cx), 'issue-TEST-2').nodes[0].style;
  assert.equal(reserved.size, 6);
  assert.equal(reserved.bg, undefined);
});

test('an error with cached issues leaves the seen set and opening revision intact', async () => {
  const seen = { account: org.url, ids: [] };
  const store = new Map([['usage-bar.linear-seen', seen]]);
  const popup = harness({ store, panel: 'linear', initialResponse: args => reply(args[2] === 'status'
    ? statusReply : { ...issuesReply, error: 'network', stale: true }) });
  await popup.flush();
  assert.deepEqual(popup.writes, []);
  assert.equal(store.get('usage-bar.linear-seen'), seen);
  assert.ok(byID(popup.view.render(popup.cx), 'issue-TEST-1'));
});

test('the first successful bar read of a different account replaces the unread baseline', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map([[seenKey, { account: 'https://linear.app/prior', ids: ['OLD-1'] }]]);
  const bar = harness({ store }); await bar.flush();
  assert.deepEqual(store.get(seenKey), { account: org.url, ids: ['TEST-1'] });
  assert.deepEqual(bar.writes, [seenKey]);
  assert.equal(byID(bar.view.render(bar.cx), 'linear').style.tooltip, 'Assigned Linear issues');
});

test('Linear groups issues and toggles inline details without opening an external URL', async () => {
  let finishDetail;
  const h = harness({ panel: 'linear', machine: 'remote', initialResponse: args => {
    if (args[2] === 'status') return reply(statusReply);
    if (args[2] === 'issue') return new Promise(resolve => { finishDetail = resolve; });
    return reply({ ...issuesReply, issues: [issue, { ...issue, identifier: 'TEST-2', url: null }] });
  } });
  await h.flush();
  const panel = h.view.render(h.cx), labels = text(panel);
  const [header, divider] = panel.nodes;
  assert.deepEqual(text(header), ['My issues', 'Example', '2', '↻']);
  assert.equal(byID(header, 'linear-refresh').style.tooltip, 'Refresh');
  assert.equal(byID(header, 'linear-open'), undefined);
  assert.equal(divider.style.h, 1);
  assert.equal(divider.style.bg, 'border');
  assert.ok(['Blocked', '!', 'TEST-1', issue.title, 'Test Project'].every(label => labels.includes(label)));
  assert.equal(panel.style.max_h, 520);
  const list = byID(panel, 'linear-issue-list');
  assert.deepEqual(list.style.overflow_y_scroll, []);
  assert.equal(list.style.gap, 10);
  assert.deepEqual(text(list.nodes[0].nodes[0]), ['Blocked', '2']);
  assert.ok(labels.some(label => /d over$/.test(label)));
  click(panel, 'issue-TEST-1', h.cx);
  assert.deepEqual(h.calls.at(-1), {
    cmd: 'sh', args: ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud', 'linear', 'issue', 'TEST-1'],
    opts: undefined, options: [],
  });
  const rendered = () => h.view.render(h.cx);
  const detail = () => byID(rendered(), 'issue-detail-TEST-1');
  assert.equal(byID(rendered(), 'issue-TEST-1').style.bg, 'raised');
  assert.deepEqual(text(detail()), ['Loading…']);
  const longLine = 'A wrapped line '.repeat(25).trimEnd();
  finishDetail(reply({ source: 'claude_mcp', issue: { ...issue, assignee: 'Fixture Owner',
    labels: ['Customer', 'Follow-up'], description: '# Summary\n' + longLine + '\n**Next**' }, error: null }));
  await h.flush();
  const expanded = detail();
  assert.deepEqual(text(expanded), [
    'Blocked', '·', 'Urgent', '·', '2000-01-01', '·', 'Fixture Owner',
    'Example / Test Project', 'Customer', 'Follow-up', 'Summary', longLine, 'Next',
  ]);
  assert.equal(expanded.nodes[0].nodes[4].style.text_color, 'blocked');
  assert.equal(expanded.nodes[2].nodes[0].style.bg, 'raised');
  assert.equal(expanded.nodes[2].nodes[0].style.rounded, 4);
  assert.deepEqual(expanded.nodes[4].style.whitespace_normal, []);
  assert.equal(expanded.nodes[4].style.truncate, undefined);
  const rows = byID(rendered(), 'linear-issue-list').nodes[0].nodes;
  assert.deepEqual(rows.slice(1).map(node => node.style.id), ['issue-TEST-1', 'issue-detail-TEST-1', 'issue-TEST-2']);

  click(rendered(), 'issue-TEST-1', h.cx);
  assert.equal(detail(), undefined);
  click(rendered(), 'issue-TEST-2', h.cx);
  finishDetail(reply({ source: 'claude_mcp', issue: { ...issue, identifier: 'TEST-2', description: null }, error: null }));
  await h.flush();
  assert.ok(text(byID(rendered(), 'issue-detail-TEST-2')).includes('No description'));
  assert.deepEqual(h.urls, []);
  assert.deepEqual(h.closed, []);
  rendered().style.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.closed, ['linear-overlay']);
});

test('Linear issue rows render project lines, priority indicators and due pill tones', async () => {
  const now = new Date();
  const date = days => new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days))
    .toISOString().slice(0, 10);
  const rows = [
    issue,
    { ...issue, identifier: 'TEST-2', project: null, priority: 2, due_date: date(2) },
    { ...issue, identifier: 'TEST-3', project: ' ', priority: 3, due_date: date(7) },
    { ...issue, identifier: 'TEST-4', project: '', priority: 4, due_date: null },
    { ...issue, identifier: 'TEST-5', project: null, priority: 0, due_date: null },
  ];
  const h = harness({ panel: 'linear', initialResponse: args => args[2] === 'status' ? reply(statusReply) :
    reply({ ...issuesReply, issues: rows }) });
  await h.flush();
  const panel = h.view.render(h.cx);
  const withProject = byID(panel, 'issue-TEST-1');
  const singleLine = byID(panel, 'issue-TEST-2');
  assert.equal(withProject.style.min_h, 40);
  assert.deepEqual(withProject.nodes[3].nodes.map(text), [[issue.title], ['Test Project']]);
  assert.equal(singleLine.style.h, 30);
  assert.deepEqual(singleLine.nodes[3].nodes, [issue.title]);
  assert.equal(singleLine.nodes[2].style.w, 58);

  for (const [index, label, filled] of [[1, 'High', 3], [2, 'Medium', 2], [3, 'Low', 1], [4, 'No priority', 0]]) {
    const box = byID(panel, 'priority-' + rows[index].identifier);
    assert.equal(box.style.tooltip, label);
    assert.deepEqual(box.nodes.map(bar => bar.style.h), [5, 8, 11]);
    assert.deepEqual(box.nodes.map(bar => bar.style.bg),
      [...Array(filled).fill('foreground'), ...Array(3 - filled).fill('dim')]);
  }
  const urgent = byID(panel, 'priority-TEST-1');
  assert.equal(urgent.style.tooltip, 'Urgent');
  assert.equal(urgent.style.bg, 'blocked');
  assert.deepEqual(text(urgent), ['!']);

  for (const [id, color, bg] of [
    ['TEST-1', 'blocked', 'blocked26'], ['TEST-2', 'working', 'working26'], ['TEST-3', 'dim', 'raised'],
  ]) {
    const pill = byID(panel, 'issue-' + id).nodes[4];
    assert.equal(pill.style.h, 18);
    assert.equal(pill.style.text_color, color);
    assert.equal(pill.style.bg, bg);
  }
  assert.equal(byID(panel, 'issue-TEST-4').nodes.length, 4);
});

test('Linear panel handles connection, expiry, stale, empty and helper errors', async () => {
  for (const [error, expected] of [
    ['not_connected', 'Connect Linear in settings'],
    ['expired', 'Claude Code Linear session expired — use Linear in Claude Code once, or add an API key'],
    ['network', "Couldn't load Linear issues"],
    ['forbidden', 'Linear denied access'],
    [null, 'No open issues'],
    ['helper', 'herdr-hud unavailable'],
  ]) {
    const h = harness({ panel: 'linear', initialResponse: args => {
      if (args[2] === 'status') return reply(statusReply);
      if (error === 'helper') throw new Error('private diagnostic');
      return reply({ ...issuesReply, error, stale: error === 'network', issues: error === null ? [] : [issue] });
    } });
    await h.flush();
    const tree = h.view.render(h.cx);
    assert.ok(text(tree).includes(expected));
    if (error === 'not_connected') {
      assert.equal(byID(tree, 'linear-issue-list'), undefined);
      click(tree, 'linear-settings', h.cx);
      assert.deepEqual(h.closed, ['linear-overlay']);
      assert.deepEqual(h.overlays.at(-1)?.props, { panel: 'settings' });
    } else if (error === 'expired' || error === 'helper') {
      assert.equal(byID(tree, 'linear-issue-list'), undefined);
    } else if (error === 'network' || error === 'forbidden') {
      assert.equal(byID(tree, 'linear-issue-list').style.opacity, 0.6);
      assert.ok(text(tree).includes(issue.title));
    }
  }
});

test('helper launch failure keeps the last Linear list and shows the error above it', async () => {
  const h = harness({ panel: 'linear' }); await h.flush();
  h.respond(args => args[2] === 'issues' ? { code: 127, stdout: '', stderr: 'private diagnostic' } : h.fallback(args));
  click(h.view.render(h.cx), 'linear-refresh', h.cx);
  await h.flush();
  const tree = h.view.render(h.cx), labels = text(tree);
  const errorIndex = labels.indexOf('herdr-hud unavailable');
  assert.ok(errorIndex >= 0 && errorIndex < labels.indexOf('TEST-1'));
  assert.equal(byID(tree, 'linear-issue-list').style.opacity, 0.6);
  assert.ok(!labels.includes('private diagnostic'));
  assert.equal(byID(tree, 'linear-open'), undefined);
  assert.deepEqual(h.urls, []);

  h.respond(args => args[2] === 'issues'
    ? reply({ ...issuesReply, org_url: null, issues: [], error: 'network' }) : h.fallback(args));
  click(tree, 'linear-refresh', h.cx);
  await h.flush();
  const fetchError = h.view.render(h.cx);
  assert.ok(text(fetchError).includes("Couldn't load Linear issues"));
  assert.equal(byID(fetchError, 'linear-issue-list'), undefined);

  h.respond(h.fallback);
  click(fetchError, 'linear-refresh', h.cx);
  await h.flush();
  const recovered = h.view.render(h.cx);
  assert.ok(!text(recovered).includes('herdr-hud unavailable'));
  assert.equal(byID(recovered, 'linear-issue-list').style.opacity, 1);
});

test('unparsable Linear poll output keeps the bar count and alert and dims the count', async () => {
  const h = harness(); await h.flush();
  h.respond(args => args[2] === 'issues' ? { code: 1, stdout: 'garbage' } : h.fallback(args));
  h.intervals.find(job => job.ms === 1800000).fn(h.cx);
  await h.flush();
  const button = byID(h.view.render(h.cx), 'linear');
  const count = button.nodes.find(node => text(node).includes('1'));
  assert.equal(count?.style.opacity, 0.6);
  assert.ok(button.nodes.some(node => node.style.bg === 'blocked'));
});

test('a failed status read keeps the last connection in settings and shows the helper error', async () => {
  const h = harness({ panel: 'settings' }); await h.flush();
  h.respond(() => { throw new Error('private diagnostic'); });
  h.store.set('usage-bar.linear-rev', 1);
  h.view.render(h.cx); h.tick(0); await h.flush();
  const labels = text(h.view.render(h.cx));
  assert.ok(labels.some(label => label.startsWith('Claude Code connection')));
  assert.ok(labels.includes('herdr-hud unavailable'));
  assert.ok(!labels.includes('private diagnostic'));
});

test('masked settings input clears immediately and failed connect uses the JSON error', async () => {
  const h = harness({ panel: 'settings' }); await h.flush();
  assert.equal(h.view.input.masked, true);
  assert.equal(h.view.input.options.placeholder, 'lin_api_…');
  assert.equal(byID(h.view.render(h.cx), 'linear-disconnect'), undefined);
  let complete;
  h.respond(args => args[2] === 'connect'
    ? new Promise(resolve => { complete = resolve; }) : h.fallback(args));
  const key = 'synthetic-test-key';
  h.view.input.set_value(key);
  h.view.input.handlers.submit({}, h.cx);
  assert.equal(h.view.input.value(), '');
  assert.deepEqual(linearCalls(h).at(-1), ['connect', '--key', key]);
  complete(reply({ error: 'invalid_key' }, 1, 'private stderr diagnostic'));
  await h.flush();
  const tree = h.view.render(h.cx);
  assert.ok(text(tree).includes('That API key was rejected'));
  assert.ok(!text(tree).some(label => label.includes('private') || label.includes(key)));
  assert.equal(h.store.get('usage-bar.linear-rev'), 1);
  assert.equal(h.store.get('usage-bar.linear-account-rev'), 1);
  assert.equal(h.store.size, 2);
  assert.deepEqual(linearCalls(h).at(-1), ['status']);
  click(tree, 'linear-create-key', h.cx);
  assert.deepEqual(h.urls, ['https://linear.app/settings/account/security']);
  tree.style.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.closed, ['settings-overlay']);
});

test('Disconnect is offered for an API key and re-reads status for the fallback', async () => {
  const h = harness({ panel: 'settings', initialResponse: () => reply(apiKeyStatus) });
  await h.flush();
  const tree = h.view.render(h.cx);
  assert.ok(text(tree).includes('API key · First Viewer'));
  h.respond(() => reply(statusReply));
  click(tree, 'linear-disconnect', h.cx);
  await h.flush();
  assert.deepEqual(linearCalls(h), [['status'], ['disconnect'], ['status']]);
  assert.equal(h.store.get('usage-bar.linear-rev'), 1);
  assert.equal(h.store.get('usage-bar.linear-account-rev'), 1);
  assert.equal(byID(h.view.render(h.cx), 'linear-disconnect'), undefined);
});

test('connect clears another popup before its new status arrives and discards in-flight reads', async () => {
  let finishOldRead;
  let finishStatus;
  const store = new Map([['usage-bar.linear-account-rev', 4], ['usage-bar.linear-rev', 9]]);
  const popup = harness({ panel: 'linear', store, initialResponse: args =>
    reply(args[2] === 'status' ? apiKeyStatus : apiKeyIssues) });
  const settings = harness({ panel: 'settings', store });
  await Promise.all([popup.flush(), settings.flush()]);
  assert.ok(byID(popup.view.render(popup.cx), 'issue-TEST-1'));
  popup.respond(args => args[2] === 'issues'
    ? new Promise(resolve => { finishOldRead = resolve; }) : reply(statusReply));
  popup.view.readLinear('issues', popup.cx);

  settings.respond(() => reply(nextAPIKeyStatus));
  settings.view.input.set_value(' synthetic-test-key ');
  click(settings.view.render(settings.cx), 'linear-connect', settings.cx);
  await settings.flush();
  assert.deepEqual(linearCalls(settings), [['status'], ['connect', '--key', 'synthetic-test-key'], ['status']]);
  assert.ok(text(settings.view.render(settings.cx)).includes('API key · Second Viewer'));
  assert.equal(store.get('usage-bar.linear-account-rev'), 5);
  assert.equal(store.get('usage-bar.linear-rev'), 11);

  const assertNoOldSnapshot = () => {
    const tree = popup.view.render(popup.cx);
    assert.equal(byID(tree, 'issue-TEST-1'), undefined);
    assert.equal(byID(tree, 'linear-open'), undefined);
    assert.deepEqual(text(tree.nodes[0]), ['My issues', '0', '↻']);
  };
  assertNoOldSnapshot();
  finishOldRead(reply(apiKeyIssues));
  await popup.flush();
  popup.respond(args => args[2] === 'status' ? new Promise(resolve => { finishStatus = resolve; }) : unavailable);
  popup.tick(0);
  assertNoOldSnapshot();
  finishStatus(reply(nextAPIKeyStatus));
  await popup.flush();
  assert.equal(byID(popup.view.render(popup.cx), 'issue-TEST-1'), undefined);
});

test('failed reads after connect cannot restore issues or status in open popups', async () => {
  const store = new Map();
  const initialResponse = args => reply(args[2] === 'status' ? apiKeyStatus : apiKeyIssues);
  const popup = harness({ panel: 'linear', store, initialResponse });
  await popup.flush();
  const settings = harness({ panel: 'settings', store, initialResponse });
  const otherSettings = harness({ panel: 'settings', store, initialResponse });
  await Promise.all([settings.flush(), otherSettings.flush()]);
  assert.ok(byID(popup.view.render(popup.cx), 'issue-TEST-1'));
  assert.ok(text(otherSettings.view.render(otherSettings.cx)).includes('API key · First Viewer'));
  settings.respond(args => args[2] === 'connect' ? reply(nextAPIKeyStatus) : unavailable);
  popup.respond(() => unavailable);
  otherSettings.respond(() => unavailable);
  settings.view.input.set_value('synthetic-test-key');
  click(settings.view.render(settings.cx), 'linear-connect', settings.cx);
  await settings.flush();
  popup.view.render(popup.cx);
  otherSettings.view.render(otherSettings.cx);
  popup.tick(0);
  otherSettings.tick(0);
  await Promise.all([popup.flush(), otherSettings.flush()]);
  const tree = popup.view.render(popup.cx);
  assert.equal(byID(tree, 'issue-TEST-1'), undefined);
  assert.equal(byID(tree, 'linear-open'), undefined);
  assert.ok(text(tree).includes('herdr-hud unavailable'));
  assert.ok(!text(otherSettings.view.render(otherSettings.cx)).includes('API key · First Viewer'));
  assert.ok(text(otherSettings.view.render(otherSettings.cx)).includes('Checking connection…'));
});

test('the account revision clears the bar count when its initial status is unknown', async () => {
  const bar = harness({ initialResponse: args => {
    if (args[1] === 'linear') return args[2] === 'status' ? unavailable : reply(apiKeyIssues);
    return reply(args[1] === 'sys' ? fixture.sys : fixture.usage);
  } });
  await bar.flush();
  const badge = () => text(byID(bar.view.render(bar.cx), 'linear'));
  assert.ok(badge().includes('1'));
  bar.respond(args => args[2] === 'status' ? reply(nextAPIKeyStatus) : unavailable);
  bar.store.set('usage-bar.linear-account-rev', 1);
  assert.ok(badge().includes('—'));
  bar.tick(0);
  await bar.flush();
  assert.ok(badge().includes('—'));
});

test('the hidden bar invalidates its account snapshot without reading until re-enabled', async () => {
  const bar = harness();
  await bar.flush();
  const badge = () => text(byID(bar.view.render(bar.cx), 'linear'));
  assert.ok(badge().includes('1'));
  bar.store.set('usage-bar.visible', { linear: false });
  bar.view.render(bar.cx);
  bar.tick(0);
  bar.store.set('usage-bar.linear-account-rev', 1);
  bar.store.set('usage-bar.linear-rev', 1);
  bar.view.render(bar.cx);
  bar.tick(0);
  assert.equal(bar.view.linearSnapshot().issues, null);
  assert.equal(bar.view.linearSnapshot().status, null);
  assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s']]);

  bar.respond(() => unavailable);
  bar.store.set('usage-bar.visible', { linear: true });
  assert.ok(badge().includes('—'));
  bar.tick(0);
  await bar.flush();
  assert.ok(badge().includes('—'));
  assert.deepEqual(linearCalls(bar).slice(2), [['status'], ['issues', '--max-age', '60s']]);
});

test('busy replies preserve issues and connection status and show the generic error', async () => {
  const store = new Map();
  const popup = harness({ panel: 'linear', store });
  await popup.flush();
  const settings = harness({ panel: 'settings', store });
  await settings.flush();
  const busyReply = args => reply(args[2] === 'issues'
    ? { issues: [], source: null, error: 'busy' }
    : { connected: false, source: null, error: 'busy' }, 1);
  popup.writes.length = 0;
  popup.respond(busyReply);
  settings.respond(busyReply);
  click(popup.view.render(popup.cx), 'linear-refresh', popup.cx);
  await popup.flush();
  assert.deepEqual(popup.writes, ['usage-bar.linear-rev']);
  const tree = popup.view.render(popup.cx);
  assert.ok(byID(tree, 'issue-TEST-1'));
  assert.equal(byID(tree, 'linear-open'), undefined);
  assert.equal(byID(tree, 'linear-issue-list').style.opacity, 0.6);
  assert.ok(text(tree).includes("Couldn't load Linear issues"));
  settings.view.render(settings.cx);
  settings.tick(0);
  await settings.flush();
  const labels = text(settings.view.render(settings.cx));
  assert.ok(labels.some(label => label.startsWith('Claude Code connection')));
  assert.ok(labels.includes("Couldn't load Linear issues"));

  popup.respond(args => args[2] === 'status' ? busyReply(args) : popup.fallback(args));
  store.set('usage-bar.linear-rev', 3);
  popup.view.render(popup.cx);
  popup.tick(0);
  await popup.flush();
  const statusBusy = popup.view.render(popup.cx);
  assert.ok(byID(statusBusy, 'issue-TEST-1'));
  assert.equal(byID(statusBusy, 'linear-issue-list').style.opacity, 0.6);
  assert.ok(text(statusBusy).includes("Couldn't load Linear issues"));
});

test('disconnected status removes old issues even if the in-flight issues read finishes later', async () => {
  const h = harness({ panel: 'linear' }); await h.flush();
  let finishIssues;
  h.respond(args => args[2] === 'status'
    ? reply({ connected: false, source: null, org: null, error: 'not_connected' })
    : new Promise(resolve => { finishIssues = resolve; }));
  h.store.set('usage-bar.linear-rev', (h.store.get('usage-bar.linear-rev') ?? 0) + 1);
  h.view.render(h.cx); h.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  const assertDisconnected = () => {
    const tree = h.view.render(h.cx);
    assert.ok(text(tree).includes('Connect Linear in settings'));
    assert.equal(byID(tree, 'linear-issue-list'), undefined);
    assert.equal(byID(tree, 'linear-open'), undefined);
  };
  assertDisconnected();
  finishIssues(reply(issuesReply));
  await h.flush();
  assertDisconnected();
});

test('a different viewer on the same source clears the issues retained from an earlier revision', async () => {
  const firstStatus = { ...statusReply, source: 'api_key', user: { name: 'First Viewer' } };
  const h = harness({ panel: 'linear', initialResponse: args => args[2] === 'status'
    ? reply(firstStatus) : reply({ ...issuesReply, source: 'api_key' }) });
  await h.flush();
  h.respond(args => args[2] === 'status'
    ? reply({ ...firstStatus, user: { name: 'Second Viewer' } }) : { code: 127, stdout: '' });
  h.store.set('usage-bar.linear-rev', (h.store.get('usage-bar.linear-rev') ?? 0) + 1);
  const pending = h.view.render(h.cx);
  assert.ok(byID(pending, 'issue-TEST-1'));
  h.tick(0); await h.flush();
  assert.equal(byID(h.view.render(h.cx), 'issue-TEST-1'), undefined);
});


test('Linear dropdown source has no external navigation', () => {
  for (const file of ['./panels.js', './main.js', './linear-detail.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /\bopen_url\b/);
  }
});

test('Linear details reuse a successful read for 60 seconds and clear on Refresh', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const h = harness({ panel: 'linear' }); await h.flush();
  h.respond(args => args[2] === 'issue'
    ? reply({ issue: { ...issue, description: 'Cached detail' }, error: null }) : h.fallback(args));
  const render = () => h.view.render(h.cx);
  const toggle = () => click(render(), 'issue-TEST-1', h.cx);
  const detailCalls = () => linearCalls(h).filter(([kind]) => kind === 'issue');
  toggle(); await h.flush();
  assert.deepEqual(detailCalls(), [['issue', 'TEST-1']]);
  now += 59999;
  toggle(); toggle(); await h.flush();
  assert.ok(text(render()).includes('Cached detail'));
  assert.equal(detailCalls().length, 1);
  now++;
  toggle(); toggle(); await h.flush();
  assert.equal(detailCalls().length, 2);
  click(render(), 'linear-refresh', h.cx);
  assert.equal(byID(render(), 'issue-detail-TEST-1'), undefined);
  await h.flush();
  toggle(); await h.flush();
  assert.equal(detailCalls().length, 3);
});

test('switching rows drops the previous Linear detail reply and shows in-place errors', async () => {
  const second = { ...issue, identifier: 'TEST-2' };
  const h = harness({ panel: 'linear', initialResponse: args => args[2] === 'status' ? reply(statusReply)
    : reply({ ...issuesReply, issues: [issue, second] }) });
  await h.flush();
  const pending = new Map();
  h.respond(args => new Promise(resolve => pending.set(args[3], resolve)));
  const render = () => h.view.render(h.cx);
  click(render(), 'issue-TEST-1', h.cx);
  click(render(), 'issue-TEST-2', h.cx);
  assert.equal(byID(render(), 'issue-detail-TEST-1'), undefined);
  pending.get('TEST-2')(reply({ issue: null, error: 'not_found' }));
  pending.get('TEST-1')(reply({ issue: { ...issue, description: 'Late stale issue' }, error: null }));
  await h.flush();
  const error = byID(render(), 'issue-detail-TEST-2').nodes[0];
  assert.deepEqual(text(error), ['Issue not found']);
  assert.equal(error.style.text_color, 'blocked');
  assert.ok(!text(render()).includes('Late stale issue'));
  click(render(), 'issue-TEST-1', h.cx);
  assert.deepEqual(linearCalls(h).slice(-3), [['issue', 'TEST-1'], ['issue', 'TEST-2'], ['issue', 'TEST-1']]);
  pending.get('TEST-1')(reply({ issue: null, error: 'bad_request' }, 2));
  await h.flush();
  assert.ok(text(render()).includes('Invalid issue id'));
});

test('account revision drops a pending detail and invalidates the popup cache', async () => {
  const second = { ...issue, identifier: 'TEST-2' };
  const fallback = args => args[2] === 'status' ? reply(statusReply)
    : reply({ ...issuesReply, issues: [issue, second] });
  const h = harness({ panel: 'linear', initialResponse: fallback }); await h.flush();
  let finishOldDetail;
  h.respond(args => {
    if (args[2] !== 'issue') return fallback(args);
    if (args[3] === 'TEST-2') return new Promise(resolve => { finishOldDetail = resolve; });
    return reply({ issue: { ...issue, description: 'First account' }, error: null });
  });
  const render = () => h.view.render(h.cx);
  click(render(), 'issue-TEST-1', h.cx);
  await h.flush();
  click(render(), 'issue-TEST-2', h.cx);
  h.store.set('usage-bar.linear-account-rev', 1);
  assert.equal(byID(render(), 'issue-detail-TEST-2'), undefined);
  h.respond(args => args[2] === 'issue'
    ? reply({ issue: { ...issue, description: 'Second account' }, error: null }) : fallback(args));
  h.tick(0);
  finishOldDetail(reply({ issue: { ...second, description: 'Old pending detail' }, error: null }));
  await h.flush();
  assert.ok(!text(render()).includes('Old pending detail'));
  assert.equal(byID(render(), 'issue-detail-TEST-2'), undefined);
  click(render(), 'issue-TEST-1', h.cx);
  await h.flush();
  assert.ok(text(render()).includes('Second account'));
  assert.deepEqual(linearCalls(h).filter(([kind]) => kind === 'issue'),
    [['issue', 'TEST-1'], ['issue', 'TEST-2'], ['issue', 'TEST-1']]);
});
