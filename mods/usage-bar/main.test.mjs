import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
  '{cell, groupLabel, systemRow, iconButton, linearButton, reportButton, openLinearKeySettings}');
const walk = node => typeof node === 'object' ? [node, ...node.nodes.flatMap(walk)] : [node];
const text = node => walk(node).filter(value => typeof value === 'string');
const byID = (node, id) => walk(node).find(value => value?.style?.id === id);

const org = { name: 'Example', url: 'https://linear.app/example' };
const issue = { identifier: 'TEST-1', title: 'An assigned issue', url: org.url + '/issue/TEST-1',
  status: 'Blocked', status_type: 'started', priority: 1, project: 'Example / Test Project', due_date: '2000-01-01' };
const statusReply = { connected: true, source: 'claude_mcp', org, user: { name: 'Viewer' },
  expires_at: '2099-07-10T12:00:00Z', error: null };
const disconnectedStatus = { connected: false, source: null, error: 'not_connected' };
const seenAccount = `claude_mcp|${org.url}|Viewer`;
const issuesReply = { source: 'claude_mcp', issues: [issue], org_url: org.url, stale: false, error: null };
const apiKeyStatus = { ...statusReply, source: 'api_key', user: { name: 'First Viewer' }, expires_at: null };
const nextAPIKeyStatus = { ...apiKeyStatus, user: { name: 'Second Viewer' } };
const apiKeyIssues = { ...issuesReply, source: 'api_key' };
const unavailable = { code: 127, stdout: '' };
const reply = (data, code = 0, stderr = '') => ({ code, stdout: JSON.stringify(data), stderr });
const linearExecs = h => h.calls.filter(call => call.args[3] === 'linear');
const linearCalls = h => linearExecs(h).map(call => call.args.slice(4));
const linearButton = h => byID(h.view.render(h.cx), 'linear');
const linearPoll = h => h.intervals.find(job => job.ms === 1800000).fn(h.cx);
const click = (tree, id, cx) => byID(tree, id).style.on_click({}, cx);

function harness({ panel, machine, popupMachine, store = new Map(), initialResponse } = {}) {
  const state = {
    spaces: [{ id: 's1', active: true, machine, tabs: [{ id: 'tb1' }] }],
    panes: [{ tab: 'tb1', terminal: 't2t' }, { tab: 'tb1', terminal: 't2w' },
      { tab: 'tb1', terminal: 'remote/t9' }, { tab: 'tb1', terminal: null }, { tab: 'other', terminal: 't99' }],
    agents: [{ space: 's1', address: 't2t', status: 'working' }],
  };
  const popupProps = panel ? { panel, overlay: panel + '-overlay', machine: popupMachine } : {};
  const calls = [], tasks = [], timers = [], intervals = [];
  const overlays = [], closed = [], urls = [], writes = [], runs = [];
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
      return respond(cmd === 'sh' ? ['hud', ...args.slice(3)] : args, options[0]);
    },
    spaces: () => state.spaces, panes: () => state.panes, agents: () => state.agents,
    theme: () => new Proxy({}, { get: (_obj, prop) => prop }), ...format, ...ui, ...prefs, ...linear,
    props: () => popupProps, run: (name, args) => { runs.push([name, args]); return null; },
    openOverlay: spec => overlays.push(spec), closeOverlay: id => closed.push(id),
    shared: key => store.get(key), setShared: (key, value) => { store.set(key, value); writes.push(key); } };
  const panels = evaluate('./panels.js', deps, '{linearPanel, settingsPanel, openPanel}');
  const UsageBar = evaluate('./main.js', { ...deps, ...panels }, 'UsageBar');
  const view = new UsageBar();
  view.init({}, cx);
  return { view, cx, state, popupProps, calls, timers, intervals, overlays, closed, urls, store, writes, runs, fallback,
    stopped: () => stopped,
    respond(fn) { respond = fn; },
    async flush() { while (tasks.length) await Promise.all(tasks.splice(0)); },
    tickIntervals(ms) {
      for (const job of intervals.filter(job => job.ms === ms)) job.fn(cx);
    },
    tick(ms) {
      const jobs = timers.filter(job => job.ms === ms && !job.canceled);
      for (const job of jobs) { job.canceled = true; job.fn(cx); }
    },
  };
}

test('poll intervals and selected account arguments', async () => {
  const h = harness(); await h.flush();
  assert.deepEqual(h.intervals.map(job => job.ms), [1000, 60000, 1800000, 60000]);
  assert.deepEqual(h.calls.map(call => ['hud', ...call.args.slice(3)]).filter(args => args[1] === 'usage'), [['hud', 'usage', '--selected', '--max-age', '45s']]);
});

test('provider cards show compact weekly usage, coupon text and stale opacity', async () => {
  const h = harness(); await h.flush(); h.view.width = 1400; // Report widens the full layout past the 1200 default
  const tree = h.view.render(h.cx), labels = text(tree);
  assert.deepEqual(byID(tree, 'groups').nodes.map(node => node.style.id), ['account-codex', 'account-claude', 'account-gemini']);
  assert.deepEqual(tree.nodes.map(node => node.style.id), ['groups', undefined, 'linear', 'report', 'system', 'gear']);
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
  const fullWidth = 24 + 50 + 38 + 110 + format.REPORT_WIDTH + 178 +
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
  assert.deepEqual(bar.view.render(bar.cx).nodes.map(node => node.style.id), [undefined, 'report', 'gear']);
  assert.equal(byID(settings.view.render(settings.cx), 'visible-codex').style.checked, false);

  const restarted = harness({ store: settings.store });
  await restarted.flush();
  assert.deepEqual(restarted.view.render(restarted.cx).nodes.map(node => node.style.id), [undefined, 'report', 'gear']);
  const startup = [['status'], ['issues', '--max-age', '60s']];
  assert.deepEqual(linearCalls(restarted), []);
  restarted.intervals.find(job => job.ms === 1800000).fn(restarted.cx);
  restarted.store.set('usage-bar.linear-rev', 1);
  restarted.view.render(restarted.cx); restarted.tick(0); await restarted.flush();
  assert.deepEqual(linearCalls(restarted), []);
  click(popup, 'visible-linear', settings.cx);
  assert.equal(linearButton(restarted), undefined);
  restarted.intervals.find(job => job.ms === 1800000).fn(restarted.cx);
  assert.deepEqual(linearCalls(restarted), []);
  restarted.tick(0); await restarted.flush();
  restarted.view.render(restarted.cx); restarted.tick(0); await restarted.flush();
  assert.deepEqual(linearCalls(restarted), startup);
  assert.ok(linearButton(restarted));
});

test('settings shows connection status beside the Linear switch and enables it only once connected', async () => {
  const visibleKey = 'usage-bar.visible';
  const hidden = { linear: false, codex: false };
  for (const [status, label] of [
    [statusReply, 'Connected · Example'],
    [{ ...statusReply, org: null }, 'Connected'],
    [disconnectedStatus, 'Not connected'],
  ]) {
    const store = new Map([[visibleKey, hidden]]);
    let finishStatus;
    const h = harness({ store, panel: 'settings', initialResponse: () =>
      new Promise(resolve => { finishStatus = resolve; }) });
    const inspect = expected => {
      const popup = h.view.render(h.cx);
      const toggle = byID(popup, 'visible-linear');
      const controls = walk(popup).find(node => node?.nodes?.includes(toggle));
      const [connection] = controls.nodes;
      assert.deepEqual(text(connection), [expected]);
      assert.equal(connection.style.text_color, 'dim');
      assert.equal(connection.style.text_size, 11);
      return toggle.style;
    };
    const assertDisabled = toggle => {
      assert.equal(toggle.opacity, 0.5);
      assert.equal(toggle.tooltip, 'Connect Linear below first');
      assert.equal(toggle.cursor_pointer, undefined);
      assert.equal(toggle.tab_index, undefined);
      toggle.on_click?.({}, h.cx);
      assert.equal(store.get(visibleKey), hidden);
      assert.deepEqual(h.writes, []);
    };
    assertDisabled(inspect('Checking…'));
    assert.deepEqual(linearCalls(h), [['status']]);

    finishStatus(reply(status));
    await h.flush();
    const toggle = inspect(label);
    if (status.connected) {
      assert.equal(toggle.opacity, undefined);
      toggle.on_click({}, h.cx);
      assert.equal(store.get(visibleKey).linear, true);
      assert.equal(store.get(visibleKey).codex, false);
    } else {
      assertDisabled(toggle);
    }
  }
});

test('settings can turn Linear off while disconnected or checking', async () => {
  const visibleKey = 'usage-bar.visible';
  let finishStatus;
  const h = harness({ panel: 'settings', initialResponse: () =>
    new Promise(resolve => { finishStatus = resolve; }) });
  const render = () => h.view.render(h.cx);
  click(render(), 'visible-linear', h.cx);
  assert.equal(h.store.get(visibleKey).linear, false);
  finishStatus(reply(disconnectedStatus));
  await h.flush();

  h.store.set(visibleKey, { linear: true });
  const tree = render();
  click(tree, 'visible-linear', h.cx);
  assert.equal(h.store.get(visibleKey).linear, false);
  // A second event on the previously visible switch still cannot turn it back on.
  click(tree, 'visible-linear', h.cx);
  assert.equal(h.store.get(visibleKey).linear, false);
  assert.equal(byID(render(), 'visible-linear').style.on_click, undefined);
});

test('right-hand cards fit at 320 pixels, with providers clipped inside their group', async () => {
  const h = harness(); await h.flush();
  h.view.width = 320;
  const tree = h.view.render(h.cx);
  const groups = byID(tree, 'groups');
  assert.equal(groups.style.min_w, 0);
  assert.equal(groups.style.overflow_hidden.length, 0);
  // Report's 92 px and its gap leave the providers no room at 320 px; the right-hand cards stay whole.
  assert.equal(groups.style.max_w, 0);
  assert.equal(byID(tree, 'gear').style.w, 38);
  assert.equal(byID(tree, 'report').style.w, format.REPORT_WIDTH);
  assert.deepEqual(tree.nodes.slice(-4).map(node => node.style.id), ['linear', 'report', 'system', 'gear']);
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
    for (const call of h.calls) assert.deepEqual(call.options, [{ on: undefined }]);
    const externalRev = (store.get('usage-bar.linear-rev') ?? 0) + 1;
    store.set('usage-bar.linear-rev', externalRev);
    h.view.render(h.cx); h.tick(0); await h.flush();
    assert.deepEqual(linearCalls(h).slice(expected.length),
      panel === 'linear' ? [['status'], ['issues', '--max-age', '60s']] : [['status']]);
    assert.equal(store.get('usage-bar.linear-rev'), externalRev);
  }
});

test('the bar routes status and issues to the active remote machine or local exec', async () => {
  for (const machine of ['R', undefined]) {
    const bar = harness({ machine }); await bar.flush();
    linearPoll(bar); await bar.flush();
    assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s'], ['issues', '--max-age', '60s']]);
    for (const call of linearExecs(bar)) {
      assert.equal(call.cmd, 'sh');
      assert.deepEqual(call.args.slice(0, 4), ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud', 'linear']);
      assert.deepEqual(call.options, [{ on: machine }]);
    }
  }
});

test('the bar retries unknown Linear status and fetches issues after it confirms the connection', async () => {
  const bar = harness({ initialResponse: args => args[1] === 'linear' ? unavailable : reply(fixture[args[1]]) });
  await bar.flush();
  assert.equal(linearButton(bar), undefined);
  assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s']]);

  let finishStatus;
  bar.respond(args => args[2] === 'status'
    ? new Promise(resolve => { finishStatus = resolve; }) : bar.fallback(args));
  bar.tickIntervals(60000);
  assert.deepEqual(linearCalls(bar).slice(2), [['status']]);
  bar.tickIntervals(60000);
  assert.deepEqual(linearCalls(bar).slice(2), [['status']]);
  finishStatus(reply(statusReply));
  await bar.flush();
  assert.deepEqual(linearCalls(bar).slice(2), [['status'], ['issues', '--max-age', '60s']]);
  assert.ok(text(linearButton(bar)).includes('1'));
});

test('the bar skips status retries after Linear is confirmed disconnected', async () => {
  const bar = harness({ initialResponse: args => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    return args[2] === 'status' ? reply(disconnectedStatus) : unavailable;
  } });
  await bar.flush();
  bar.tickIntervals(60000);
  await bar.flush();
  assert.deepEqual(linearCalls(bar), [['status'], ['issues', '--max-age', '60s']]);
});

test('Linear and settings popups do not retry unknown status on the minute', async () => {
  for (const panel of ['linear', 'settings']) {
    const popup = harness({ panel, initialResponse: () => unavailable });
    await popup.flush();
    const initialCalls = linearCalls(popup);
    popup.tickIntervals(60000);
    await popup.flush();
    assert.deepEqual(linearCalls(popup), initialCalls);
  }
});

test('hiding Linear gives provider cards the button width and gap', async () => {
  const connected = harness();
  const disconnected = harness({ initialResponse: args => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    return args[2] === 'status' ? reply(disconnectedStatus) : unavailable;
  } });
  await Promise.all([connected.flush(), disconnected.flush()]);
  for (const bar of [connected, disconnected]) bar.view.width = 1400;
  const shown = connected.view.render(connected.cx);
  const hidden = disconnected.view.render(disconnected.cx);
  assert.ok(byID(shown, 'linear'));
  assert.equal(byID(hidden, 'linear'), undefined);
  assert.equal(byID(hidden, 'groups').style.max_w - byID(shown, 'groups').style.max_w,
    format.LINEAR_WIDTH + shown.style.gap);
});

test('the bar hides Linear on a disconnected machine and shows it again on returning to a connected machine', async () => {
  const bar = harness({ machine: 'A', initialResponse: (args, { on }) => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    if (on === 'A') return reply(args[2] === 'status' ? statusReply : issuesReply);
    return args[2] === 'status' ? reply(disconnectedStatus) : unavailable;
  } });
  await bar.flush();
  assert.ok(text(linearButton(bar)).includes('1'));

  bar.state.spaces[0].machine = 'B';
  assert.equal(linearButton(bar), undefined);
  bar.tick(0);
  await bar.flush();
  assert.equal(linearButton(bar), undefined);

  bar.state.spaces[0].machine = 'A';
  assert.equal(linearButton(bar), undefined);
  bar.tick(0);
  await bar.flush();
  assert.ok(text(linearButton(bar)).includes('1'));
});

for (const kind of ['status', 'issues']) {
  test(`the bar shows Linear when the ${kind} reply reports an expired connection`, async () => {
    const bar = harness({ initialResponse: args => {
      if (args[1] !== 'linear') return reply(fixture[args[1]]);
      if (args[2] === kind) return reply({ ...disconnectedStatus, error: 'expired' });
      return unavailable;
    } });
    await bar.flush();
    assert.ok(linearButton(bar));
  });
}

test('the bar hides Linear while loading and shows it after a connected status reply', async () => {
  let finishStatus;
  const bar = harness({ initialResponse: args => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    if (args[2] === 'issues') return unavailable;
    return new Promise(resolve => { finishStatus = resolve; });
  } });
  assert.equal(linearButton(bar), undefined);
  finishStatus(reply(statusReply));
  await bar.flush();
  assert.ok(linearButton(bar));
});

test('the bar hides Linear when the helper fails before confirming a connection', async () => {
  for (const statusFailure of [unavailable, { code: 0, stdout: 'garbage' }]) {
    const bar = harness({ initialResponse: args => {
      if (args[1] !== 'linear') return reply(fixture[args[1]]);
      return args[2] === 'status' ? statusFailure : unavailable;
    } });
    await bar.flush();
    assert.equal(linearButton(bar), undefined);
  }
});

test('the first switched render hides the old Linear badge and late replies leave the new snapshot intact', async () => {
  const store = new Map([['usage-bar.linear-seen', { account: seenAccount, ids: [] }]]);
  const bar = harness({ machine: 'A', store }); await bar.flush();
  bar.respond(() => unavailable);
  linearPoll(bar); await bar.flush();
  const before = linearButton(bar);
  assert.deepEqual(text(before), ['◆', 'Linear', '1']);
  assert.equal(before.style.tooltip, '1 new issue');
  assert.equal(before.nodes[2].style.opacity, 0.6);
  assert.equal(before.nodes[3].style.bg, 'blocked');

  let finishA;
  bar.respond((args, { on }) => {
    if (on === 'A') return new Promise(resolve => { finishA = resolve; });
    return args[2] === 'status' ? reply(statusReply) : reply({ ...issuesReply, issues: [] });
  });
  linearPoll(bar);
  bar.state.spaces[0].machine = 'B';
  assert.equal(linearButton(bar), undefined);
  assert.deepEqual(linearExecs(bar).map(call => call.opts.on), ['A', 'A', 'A', 'A']);

  bar.tick(0);
  assert.deepEqual(linearExecs(bar).slice(-2).map(call => [call.args[4], call.opts.on]),
    [['status', 'B'], ['issues', 'B']]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(text(linearButton(bar)), ['◆', 'Linear', '0']);
  finishA(reply({ error: 'not_connected' }));
  await bar.flush();
  assert.deepEqual(text(linearButton(bar)), ['◆', 'Linear', '0']);
});

test('a poll before the Linear transition still routes to A and cannot seed A with B issues', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const bStatus = { ...statusReply, user: { name: 'B Viewer' } };
  const bIssue = { ...issue, identifier: 'B-1' };
  const bar = harness({ machine: 'A', initialResponse: args =>
    args[1] === 'linear' && args[2] === 'issues' ? unavailable :
      reply(args[2] === 'status' ? statusReply : fixture[args[1]]) });
  await bar.flush();
  assert.equal(bar.store.has(seenKey), false);

  let finishA;
  bar.respond((args, { on }) => {
    if (on === 'A') return new Promise(resolve => { finishA = resolve; });
    return reply(args[2] === 'status' ? bStatus : { ...issuesReply, issues: [bIssue] });
  });
  bar.state.spaces[0].machine = 'B';
  linearButton(bar);
  linearPoll(bar);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bar.store.has(seenKey), false);
  assert.deepEqual(linearExecs(bar).at(-1).opts, { on: 'A' });

  bar.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  finishA(reply(issuesReply));
  await bar.flush();
  assert.deepEqual(bar.store.get(seenKey), {
    v: 2, accounts: [{ account: linear.seenAccount(bStatus), ids: ['B-1'] }],
  });
  assert.deepEqual(bar.view.linearSnapshot().issues.issues, [bIssue]);
});

test('returning to A before the Linear transition runs preserves A and starts no extra reads', async () => {
  const bar = harness({ machine: 'A' }); await bar.flush();
  const original = bar.view.linearSnapshot();
  bar.state.spaces[0].machine = 'B';
  assert.equal(linearButton(bar), undefined);
  bar.state.spaces[0].machine = 'A';
  assert.ok(text(linearButton(bar)).includes('1'));
  bar.tick(0); await bar.flush();
  assert.equal(linearExecs(bar).length, 2);
  assert.equal(bar.view.linearSnapshot().status, original.status);
  assert.equal(bar.view.linearSnapshot().issues, original.issues);
});

test('Linear and settings overlay commands stay pinned after the active machine changes', async () => {
  const bar = harness({ machine: 'R' }); await bar.flush();
  const tree = bar.view.render(bar.cx);
  click(tree, 'linear', bar.cx);
  assert.deepEqual(bar.overlays.at(-1).props, { panel: 'linear', machine: 'R' });
  click(tree, 'gear', bar.cx);
  assert.deepEqual(bar.overlays.at(-1).props, { panel: 'settings', machine: 'R' });
  const popup = harness({ panel: 'linear', machine: 'R', popupMachine: bar.overlays[0].props.machine });
  await popup.flush();
  popup.state.spaces[0].machine = 'B';
  popup.popupProps.machine = 'B';
  popup.respond(args => reply(args[2] === 'issue' ? { issue } : { error: 'not_connected' }));
  click(popup.view.render(popup.cx), 'issue-TEST-1', popup.cx);
  await popup.flush();
  click(popup.view.render(popup.cx), 'linear-refresh', popup.cx);
  await popup.flush();
  click(popup.view.render(popup.cx), 'linear-settings', popup.cx);
  const handoff = popup.overlays.at(-1).props;
  assert.deepEqual(handoff, { panel: 'settings', machine: 'R' });
  const settings = harness({ panel: handoff.panel, popupMachine: handoff.machine,
    machine: 'B', initialResponse: args => reply(args[2] === 'disconnect' ? disconnectedStatus : apiKeyStatus) });
  await settings.flush();
  settings.view.input.set_value('synthetic-test-key');
  click(settings.view.render(settings.cx), 'linear-connect', settings.cx);
  await settings.flush();
  click(settings.view.render(settings.cx), 'linear-disconnect', settings.cx);
  await settings.flush();
  assert.deepEqual(linearCalls(popup), [['issues', '--max-age', '60s'], ['status'], ['issue', 'TEST-1'], ['issues', '--refresh']]);
  assert.deepEqual(linearCalls(settings), [['status'], ['connect', '--key', 'synthetic-test-key'], ['status'], ['disconnect'], ['status']]);
  for (const call of [...linearExecs(popup), ...linearExecs(settings)]) assert.deepEqual(call.opts, { on: 'R' });
});

test('connecting in settings pinned to A preserves the active B account’s unread baseline', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map();
  const bar = harness({ machine: 'B', store }); await bar.flush();
  const baseline = store.get(seenKey);
  const settings = harness({ panel: 'settings', popupMachine: 'A', machine: 'B', store,
    initialResponse: () => reply(apiKeyStatus) });
  await settings.flush();
  const newIssues = { ...issuesReply, issues: [issue, { ...issue, identifier: 'B-2' }] };
  bar.respond(args => reply(args[2] === 'status' ? statusReply : newIssues));
  linearPoll(bar); await bar.flush();
  assert.equal(linearButton(bar).style.tooltip, '1 new issue');

  settings.view.input.set_value('synthetic-test-key');
  click(settings.view.render(settings.cx), 'linear-connect', settings.cx);
  await settings.flush();
  assert.equal(store.get('usage-bar.linear-account-machine'), 'A');
  assert.deepEqual(settings.writes.slice(0, 2), ['usage-bar.linear-account-machine', 'usage-bar.linear-account-rev']);
  assert.equal(linearButton(bar), undefined);
  bar.tick(0); await bar.flush();
  assert.equal(linearButton(bar).style.tooltip, '1 new issue');
  assert.equal(store.get(seenKey), baseline);
});

test('settings must target the active machine to enable Linear, but can always turn it off', async () => {
  const visibleKey = 'usage-bar.visible';
  const store = new Map([[visibleKey, { linear: false }]]);
  const h = harness({ panel: 'settings', popupMachine: 'A', machine: 'A', store });
  await h.flush();
  const active = h.view.render(h.cx);
  assert.equal(typeof byID(active, 'visible-linear').style.on_click, 'function');
  h.state.spaces[0].machine = 'B';
  click(active, 'visible-linear', h.cx);
  assert.equal(store.get(visibleKey).linear, false);
  const disabled = byID(h.view.render(h.cx), 'visible-linear');
  assert.equal(disabled.style.on_click, undefined);
  assert.equal(disabled.style.tooltip, 'Open settings on this machine');
  store.set(visibleKey, { linear: true });
  click(h.view.render(h.cx), 'visible-linear', h.cx);
  assert.equal(store.get(visibleKey).linear, false);

  let finishConnect;
  h.respond(args => args[2] === 'connect'
    ? new Promise(resolve => { finishConnect = resolve; }) : reply(apiKeyStatus));
  h.state.spaces[0].machine = 'A';
  h.view.input.set_value('synthetic-test-key');
  click(h.view.render(h.cx), 'linear-connect', h.cx);
  h.state.spaces[0].machine = 'B';
  finishConnect(reply(apiKeyStatus));
  await h.flush();
  assert.equal(store.get(visibleKey).linear, false);
});

test('switching between machines preserves both accounts’ unread issues', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const profiles = {
    A: { status: statusReply, issues: [issue] },
    B: { status: { ...statusReply, user: { name: 'B Viewer' } }, issues: [{ ...issue, identifier: 'B-1' }] },
  };
  const respond = (args, { on }) => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    const { status, issues } = profiles[on];
    return reply(args[2] === 'status' ? status : { ...issuesReply, issues });
  };
  const bar = harness({ machine: 'A', initialResponse: respond }); await bar.flush();
  const switchTo = async machine => {
    bar.state.spaces[0].machine = machine;
    linearButton(bar); bar.tick(0); await bar.flush();
  };
  await switchTo('B');
  const baseline = bar.store.get(seenKey);
  assert.deepEqual(baseline.accounts, [
    { account: linear.seenAccount(profiles.B.status), ids: ['B-1'] }, { account: seenAccount, ids: ['TEST-1'] },
  ]);
  profiles.A.issues.push({ ...issue, identifier: 'A-2' });
  profiles.B.issues.push({ ...issue, identifier: 'B-2' }, { ...issue, identifier: 'B-3' });
  for (const [machine, tooltip] of [['A', '1 new issue'], ['B', '2 new issues'], ['A', '1 new issue']]) {
    await switchTo(machine);
    assert.equal(linearButton(bar).style.tooltip, tooltip);
    assert.equal(bar.store.get(seenKey), baseline);
  }
});

test('the settings connection label names a remote machine while loading, connected and disconnected', async () => {
  for (const machine of ['R', undefined]) {
    let finishStatus;
    const h = harness({ panel: 'settings', popupMachine: machine,
      initialResponse: () => new Promise(resolve => { finishStatus = resolve; }) });
    const verify = connection => {
      const labels = text(h.view.render(h.cx));
      assert.ok(labels.includes(connection));
      if (machine) assert.equal(labels[labels.indexOf(connection) + 1], 'on R');
      else assert.ok(!labels.some(label => label.startsWith('on ')));
    };
    verify('Checking…');
    finishStatus(reply(statusReply));
    await h.flush();
    verify('Connected · Example');
    h.respond(() => reply(disconnectedStatus));
    h.view.readLinear('status', h.cx);
    await h.flush();
    verify('Not connected');
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
  assert.deepEqual(linear.seenIds(store.get('usage-bar.linear-seen'), seenAccount), ['TEST-1']);
  finishStatus(reply(statusReply));
  await popup.flush();
  assert.ok(text(popup.view.render(popup.cx)).includes(org.name));
  assert.deepEqual(popup.writes, ['usage-bar.linear-open-rev', 'usage-bar.linear-rev', 'usage-bar.linear-seen']);
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

test('a dropdown opening retries the bar status it invalidated without another bump', async () => {
  const store = new Map();
  let finishFirstStatus;
  const bar = harness({ store, initialResponse: args => args[2] === 'status'
    ? new Promise(resolve => { finishFirstStatus = resolve; }) : reply(issuesReply) });
  const popup = harness({ store, panel: 'linear' });
  await popup.flush();
  assert.equal(store.get('usage-bar.linear-rev'), 1);

  bar.respond(bar.fallback);
  bar.view.render(bar.cx);
  bar.tick(0);
  finishFirstStatus(reply({ ...statusReply, org: null }));
  await bar.flush();
  bar.view.render(bar.cx);
  bar.tick(0);
  await bar.flush();
  assert.deepEqual(linearCalls(bar), [
    ['status'], ['issues', '--max-age', '60s'], ['status'], ['issues', '--max-age', '60s'],
  ]);
  assert.deepEqual(bar.view.linearStatus, statusReply);
  assert.equal(store.get('usage-bar.linear-rev'), 1);
});

test('an opening retries a discarded status even when the bar has an older status', async () => {
  const store = new Map();
  const bar = harness({ store });
  await bar.flush();
  let finishStatus;
  bar.respond(args => args[2] === 'status'
    ? new Promise(resolve => { finishStatus = resolve; }) : bar.fallback(args));
  store.set('usage-bar.linear-rev', 1);
  bar.view.render(bar.cx);
  bar.tick(0);

  const popup = harness({ store, panel: 'linear' });
  await popup.flush();
  finishStatus(reply({ ...statusReply, user: { name: 'Discarded reply' } }));
  await bar.flush();
  assert.deepEqual(bar.view.linearStatus, statusReply);

  const latestStatus = { ...statusReply, user: { name: 'Current Viewer' } };
  bar.respond(args => args[2] === 'status' ? reply(latestStatus) : bar.fallback(args));
  bar.view.render(bar.cx);
  bar.tick(0);
  await bar.flush();
  assert.deepEqual(linearCalls(bar).slice(-2), [['status'], ['issues', '--max-age', '60s']]);
  assert.deepEqual(bar.view.linearStatus, latestStatus);
  assert.equal(store.get('usage-bar.linear-rev'), 2);
});

test('the bar shows zero unread and leaves seen alone until status loads', async () => {
  const seen = { account: seenAccount, ids: [] };
  const store = new Map([['usage-bar.linear-seen', seen]]);
  let finishStatus;
  const bar = harness({ store, initialResponse: args => args[2] === 'status'
    ? new Promise(resolve => { finishStatus = resolve; }) : reply(issuesReply) });
  const button = () => byID(bar.view.render(bar.cx), 'linear');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(text(button()).includes('1'));
  assert.equal(button().style.tooltip, 'Assigned Linear issues');
  assert.equal(store.get('usage-bar.linear-seen'), seen);
  assert.deepEqual(bar.writes, []);

  finishStatus(reply(statusReply));
  await bar.flush();
  assert.equal(button().style.tooltip, '1 new issue');
});

test('a transient whoami failure preserves unread through recovery and the next dropdown open', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map();
  const bar = harness({ store });
  await bar.flush();
  const baseline = store.get(seenKey);
  assert.deepEqual(baseline, { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-1'] }] });
  const two = { ...issuesReply, issues: [issue, { ...issue, identifier: 'TEST-2' }] };
  const render = () => bar.view.render(bar.cx);
  const tooltip = () => byID(render(), 'linear').style.tooltip;
  const respond = status => bar.respond(args => reply(args[2] === 'status' ? status : two));

  respond(statusReply);
  bar.intervals.find(job => job.ms === 1800000).fn(bar.cx);
  await bar.flush();
  assert.equal(tooltip(), '1 new issue');

  for (const [rev, status] of [[1, { ...statusReply, user: null, org: null }], [2, statusReply]]) {
    respond(status);
    store.set('usage-bar.linear-rev', rev);
    render();
    bar.tick(0);
    await bar.flush();
    assert.equal(tooltip(), '1 new issue');
    assert.equal(store.get(seenKey), baseline);
    assert.deepEqual(bar.writes, [seenKey]);
  }

  const popup = harness({ store, panel: 'linear', initialResponse: args =>
    reply(args[2] === 'status' ? statusReply : two) });
  await popup.flush();
  assert.equal(byID(popup.view.render(popup.cx), 'issue-TEST-2').nodes[0].style.bg, 'accent');
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-1', 'TEST-2'] }] });
});

test('partial identity before any complete status leaves the shared seen set alone', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const baseline = { account: seenAccount, ids: [] };
  const store = new Map([[seenKey, baseline]]);
  const initialResponse = args => reply(args[2] === 'status'
    ? { ...statusReply, user: null, org: null } : issuesReply);
  const bar = harness({ store, initialResponse });
  await bar.flush();
  const popup = harness({ store, panel: 'linear', initialResponse });
  await popup.flush();
  assert.equal(byID(bar.view.render(bar.cx), 'linear').style.tooltip, 'Assigned Linear issues');
  assert.equal(byID(popup.view.render(popup.cx), 'issue-TEST-1').nodes[0].style.bg, undefined);
  assert.equal(store.get(seenKey), baseline);
  assert.ok(![...bar.writes, ...popup.writes].includes(seenKey));
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
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-1'] }] });
  assert.equal(button().style.border, 1);
  assert.equal(button().style.border_color, 'muted66');
  assert.equal(button().style.tooltip, 'Assigned Linear issues');

  bar.respond(args => args[2] === 'issues' ? withIssues(issue, second) : bar.fallback(args));
  const poll = bar.intervals.find(job => job.ms === 1800000);
  poll.fn(bar.cx); await bar.flush();
  assert.equal(button().style.tooltip, '1 new issue');

  // Reading the key also updates the badge without making another Linear request.
  store.set(seenKey, { account: seenAccount, ids: ['TEST-1', 'TEST-2'] });
  assert.equal(button().style.tooltip, 'Assigned Linear issues');
  assert.equal(linearCalls(bar).length, 3);

  store.set(seenKey, { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-1'] }] });
  bar.respond(args => args[2] === 'issues' ? withIssues(issue, second, third) : bar.fallback(args));
  poll.fn(bar.cx); await bar.flush();
  assert.equal(button().style.border, 1.5);
  assert.equal(button().style.border_color, 'accent');
  assert.equal(button().style.tooltip, '2 new issues');
  assert.ok(button().nodes.some(node => node.style.bg === 'blocked'));
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-1'] }] });

  const popup = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? reply(statusReply) : withIssues(second, third) });
  await popup.flush();
  const render = () => popup.view.render(popup.cx);
  const dot = id => byID(render(), 'issue-' + id).nodes[0].style;
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-2', 'TEST-3'] }] });
  assert.equal(button().style.tooltip, 'Assigned Linear issues');
  assert.equal(button().style.border_color, 'muted66');
  assert.equal(dot('TEST-2').bg, 'accent');
  assert.equal(dot('TEST-3').size, 6);

  popup.respond(args => args[2] === 'issues' ? withIssues(second, third, fourth) : popup.fallback(args));
  click(render(), 'linear-refresh', popup.cx);
  await popup.flush();
  assert.equal(dot('TEST-2').bg, 'accent');
  assert.equal(dot('TEST-4').bg, 'accent');
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-2', 'TEST-3', 'TEST-4'] }] });

  popup.view.close();
  const reopened = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? reply(statusReply) : withIssues(second, third, fourth) });
  await reopened.flush();
  const reserved = byID(reopened.view.render(reopened.cx), 'issue-TEST-2').nodes[0].style;
  assert.equal(reserved.size, 6);
  assert.equal(reserved.bg, undefined);
});

test('an error with cached issues leaves the seen set and opening revision intact', async () => {
  const seen = { account: seenAccount, ids: [] };
  const store = new Map([['usage-bar.linear-seen', seen]]);
  const popup = harness({ store, panel: 'linear', initialResponse: args => reply(args[2] === 'status'
    ? statusReply : { ...issuesReply, error: 'network', stale: true }) });
  await popup.flush();
  assert.deepEqual(popup.writes, []);
  assert.equal(store.get('usage-bar.linear-seen'), seen);
  assert.ok(byID(popup.view.render(popup.cx), 'issue-TEST-1'));
});

test('the first successful bar read of a different account adds an unread baseline', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map([[seenKey, { account: 'https://linear.app/prior', ids: ['OLD-1'] }]]);
  const bar = harness({ store }); await bar.flush();
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [
    { account: seenAccount, ids: ['TEST-1'] }, { account: 'https://linear.app/prior', ids: ['OLD-1'] },
  ] });
  assert.deepEqual(bar.writes, [seenKey]);
  assert.equal(byID(bar.view.render(bar.cx), 'linear').style.tooltip, 'Assigned Linear issues');
});

test('a different viewer in the same organization starts with zero unread', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map();
  const bar = harness({ store, initialResponse: args => args[2] === 'status' ? reply(apiKeyStatus) : reply(apiKeyIssues) });
  await bar.flush();
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: `api_key|${org.url}|First Viewer`, ids: ['TEST-1'] }] });

  const issues = { ...apiKeyIssues, issues: [{ ...issue, identifier: 'TEST-7' }, { ...issue, identifier: 'TEST-8' }] };
  bar.respond(args => args[2] === 'status' ? reply(nextAPIKeyStatus) : reply(issues));
  store.set('usage-bar.linear-account-rev', 1);
  store.set('usage-bar.linear-rev', 1);
  bar.view.render(bar.cx);
  bar.tick(0);
  await bar.flush();
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [
    { account: `api_key|${org.url}|Second Viewer`, ids: ['TEST-7', 'TEST-8'] },
    { account: `api_key|${org.url}|First Viewer`, ids: ['TEST-1'] },
  ] });
  assert.equal(byID(bar.view.render(bar.cx), 'linear').style.tooltip, 'Assigned Linear issues');

  const popup = harness({ store, panel: 'linear', initialResponse: args =>
    args[2] === 'status' ? reply(nextAPIKeyStatus) : reply(issues) });
  await popup.flush();
  const tree = popup.view.render(popup.cx);
  for (const id of ['TEST-7', 'TEST-8']) assert.equal(byID(tree, 'issue-' + id).nodes[0].style.bg, undefined);
});

test('an account revision forces a fresh baseline even if the loaded viewer is unchanged', async () => {
  const seenKey = 'usage-bar.linear-seen';
  const store = new Map();
  const bar = harness({ store });
  await bar.flush();
  const newIssue = { ...issue, identifier: 'TEST-2' };
  const issues = { ...issuesReply, issues: [newIssue] };
  bar.respond(args => args[2] === 'status' ? reply(statusReply) : reply(issues));
  store.set('usage-bar.linear-account-rev', 1);
  bar.view.render(bar.cx);
  bar.tick(0);
  await bar.flush();
  assert.deepEqual(store.get(seenKey), { v: 2, accounts: [{ account: seenAccount, ids: ['TEST-2'] }] });
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
    opts: { on: undefined }, options: [{ on: undefined }],
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
  click(rendered(), 'linear-refresh', h.cx);
  await h.flush();
  assert.deepEqual(linearCalls(h).at(-1), ['issues', '--refresh']);
  assert.equal(byID(rendered(), 'issue-detail-TEST-2'), undefined);
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
  assert.deepEqual(withProject.nodes[4].nodes.map(text), [[issue.title], ['Test Project']]);
  assert.equal(singleLine.style.h, 30);
  assert.deepEqual(singleLine.nodes[4].nodes, [issue.title]);
  assert.equal(singleLine.nodes[3].style.w, 58);

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
    const pill = byID(panel, 'issue-' + id).nodes[5];
    assert.equal(pill.style.h, 18);
    assert.equal(pill.style.text_color, color);
    assert.equal(pill.style.bg, bg);
  }
  assert.equal(byID(panel, 'issue-TEST-4').nodes.length, 5);
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
      assert.deepEqual(h.urls, []);
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
  const hidden = { linear: false };
  const h = harness({ panel: 'settings', store: new Map([['usage-bar.visible', hidden]]) });
  await h.flush();
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
  assert.equal(h.store.get('usage-bar.linear-account-machine'), '');
  assert.equal(h.store.get('usage-bar.visible'), hidden);
  assert.ok(!h.writes.includes('usage-bar.visible'));
  assert.deepEqual(linearCalls(h).at(-1), ['status']);
  click(tree, 'linear-create-key', h.cx);
  assert.deepEqual(h.urls, ['https://linear.app/settings/account/security']);
  tree.style.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.closed, ['settings-overlay']);
});

test('a successful settings connect reveals Linear and keeps other visibility choices', async () => {
  const visibleKey = 'usage-bar.visible';
  const store = new Map([[visibleKey, { linear: false, claude: false }]]);
  const bar = harness({ store });
  const settings = harness({ panel: 'settings', store, initialResponse: () => reply(disconnectedStatus) });
  await Promise.all([bar.flush(), settings.flush()]);
  const render = () => settings.view.render(settings.cx);
  assert.equal(byID(bar.view.render(bar.cx), 'linear'), undefined);
  assert.equal(byID(render(), 'visible-linear').style.checked, false);

  settings.respond(() => reply(apiKeyStatus));
  settings.view.input.set_value('synthetic-test-key');
  click(render(), 'linear-connect', settings.cx);
  await settings.flush();
  assert.deepEqual(store.get(visibleKey), { codex: true, claude: false, gemini: true, linear: true, system: true });
  assert.equal(byID(render(), 'visible-linear').style.checked, true);
  assert.equal(linearButton(bar), undefined);
  bar.tick(0);
  await bar.flush();
  assert.ok(linearButton(bar));
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
  assert.ok(text(otherSettings.view.render(otherSettings.cx)).includes('Not connected'));
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
  assert.equal(linearButton(bar), undefined);
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
  assert.equal(linearButton(bar), undefined);
  bar.tick(0);
  await bar.flush();
  assert.equal(linearButton(bar), undefined);
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


test('external navigation is limited to the Create API key action in settings', () => {
  const dir = new URL('.', import.meta.url);
  for (const file of readdirSync(dir, { recursive: true }).filter(file => file.endsWith('.js'))) {
    let code = readFileSync(new URL(file, dir), 'utf8');
    if (file === 'ui.js') {
      code = code.replace(/^export function openLinearKeySettings\(cx\) \{[\s\S]*?^\}/m, '');
    } else if (file === 'panels.js') {
      code = code.replace(/^import \{ openLinearKeySettings \} from '\.\/ui\.js';$/m, '')
        .replace(/^export function settingsPanel\(view\) \{[\s\S]*?^\}/m, body =>
          body.replace(/\bopenLinearKeySettings\b/g, ''));
    }
    assert.doesNotMatch(code, /\b(?:open_url|openLinearKeySettings)\b/, file);
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

const barIDs = root => root.nodes.map(node => node?.style?.id).filter(Boolean);

test('Report sits right after Linear and takes its place when Linear is hidden', async () => {
  const connected = harness();
  const disconnected = harness({ initialResponse: args => {
    if (args[1] !== 'linear') return reply(fixture[args[1]]);
    return args[2] === 'status' ? reply(disconnectedStatus) : unavailable;
  } });
  await Promise.all([connected.flush(), disconnected.flush()]);
  for (const bar of [connected, disconnected]) bar.view.width = 900;
  assert.deepEqual(barIDs(connected.view.render(connected.cx)), ['groups', 'linear', 'report', 'system', 'gear']);
  assert.deepEqual(barIDs(disconnected.view.render(disconnected.cx)), ['groups', 'report', 'system', 'gear']);
});

test('provider room reserves the Report width and one extra gap', async () => {
  const bar = harness(); await bar.flush(); bar.view.width = 900;
  const { padding, gap } = format.barSpacing(900);
  const root = bar.view.render(bar.cx);
  const mode = format.layoutMode(900, format.pickAccounts(fixture.usage), { linear: true });
  const right = format.GEAR_WIDTH + format.REPORT_WIDTH + format.LINEAR_WIDTH + format.systemWidth(mode.bars, mode.compactSystem);
  assert.equal(byID(root, 'groups').style.max_w, 900 - 2 * padding - right - gap * 5);
});

test('the Report button only flips shared flags and highlights while open', async () => {
  const bar = harness(); await bar.flush();
  const reportNode = () => byID(bar.view.render(bar.cx), 'report');
  assert.equal(reportNode().style.bg, 'chrome');
  reportNode().style.on_click({}, bar.cx);
  assert.deepEqual(bar.runs, []);
  assert.equal(bar.store.get('report.open'), true);
  assert.equal(reportNode().style.bg, 'hover');
  assert.equal(reportNode().style.border_color, 'foreground');
  reportNode().style.on_click({}, bar.cx);
  assert.deepEqual(bar.runs, []);
  assert.equal(bar.store.get('report.open'), false);
  assert.equal(reportNode().style.bg, 'chrome');
});

test('opening Report while hub is open clears hub.open and leaves layout calls to the Hub controller', async () => {
  const bar = harness(); await bar.flush();
  bar.store.set('hub.open', true);
  byID(bar.view.render(bar.cx), 'report').style.on_click({}, bar.cx);
  assert.equal(bar.store.get('hub.open'), false);
  assert.equal(bar.store.get('report.open'), true);
  byID(bar.view.render(bar.cx), 'report').style.on_click({}, bar.cx);
  assert.equal(bar.store.get('report.open'), false);
  assert.deepEqual(bar.runs, []);
});

test('Linear status mark completes once, removes the row before refresh, and offers Undo', async () => {
  const h = harness({ panel: 'linear', popupMachine: 'remote' });
  await h.flush();
  const id = issue.identifier;
  const render = () => h.view.render(h.cx);
  const before = h.view.linearSnapshot();
  h.view.linearDetails.expanded = id;
  let resolveComplete;
  let resolveRefresh;
  let refreshStarted;
  const refreshing = new Promise(resolve => { refreshStarted = resolve; });
  h.respond(args => {
    if (args[2] === 'complete') return new Promise(resolve => { resolveComplete = resolve; });
    if (args[2] === 'issues' && args[3] === '--refresh') {
      return new Promise(resolve => { resolveRefresh = resolve; refreshStarted(); });
    }
    return h.fallback(args);
  });

  const mark = byID(render(), 'complete-' + id);
  assert.equal(mark.style.tooltip, 'Mark as Done');
  assert.equal(mark.style.accessibility_label, 'Mark ' + id + ' as Done');
  const stopped = h.stopped();
  mark.style.on_click({}, h.cx);
  mark.style.on_click({}, h.cx);
  assert.equal(h.stopped(), stopped + 2);
  const pending = render();
  assert.deepEqual(text(byID(pending, 'complete-' + id)), ['✓']);
  assert.equal(byID(pending, 'complete-' + id).style.on_click, undefined);
  assert.equal(byID(pending, 'issue-' + id).style.on_click, undefined);
  assert.equal(before.pending.size, 0);
  assert.deepEqual(linearCalls(h).slice(2), [['complete', id]]);
  assert.deepEqual(linearExecs(h).at(-1).opts, { on: 'remote' });

  resolveComplete(reply({ identifier: id, status: 'Finished', previous: 'In Progress' }));
  await refreshing;
  assert.deepEqual(before.issues.issues, [issue]);
  assert.deepEqual(h.view.linearSnapshot().issues.issues, []);
  assert.equal(h.view.linearSnapshot().pending.size, 0);
  assert.equal(h.view.linearDetails.expanded, null);
  const completed = render();
  assert.ok(text(completed).includes('Marked TEST-1 as Finished'));
  assert.ok(text(completed).includes('No open issues'));
  resolveRefresh(reply({ ...issuesReply, issues: [] }));
  await h.flush();

  h.respond(args => args[2] === 'restore' ? reply({ identifier: id, status: 'In Progress' }) : h.fallback(args));
  click(completed, 'linear-undo', h.cx);
  click(completed, 'linear-undo', h.cx);
  assert.equal(h.view.linearSnapshot().undo, null);
  assert.equal(h.timers.find(job => job.ms === 6000).canceled, true);
  await h.flush();
  assert.deepEqual(linearCalls(h).slice(2), [
    ['complete', id], ['issues', '--refresh'], ['restore', id, 'In Progress'], ['issues', '--refresh'],
  ]);
  assert.deepEqual(linearExecs(h).at(-2).opts, { on: 'remote' });
  assert.ok(byID(render(), 'issue-' + id));
});

test('Linear issue action failures keep the row and show fixed copy', async () => {
  const h = harness({ panel: 'linear' });
  await h.flush();
  const id = issue.identifier;
  for (const [result, error, message] of [
    [reply({ error: 'forbidden' }, 1), 'forbidden', 'Linear denied the change — the API key may be read-only'],
    [reply({ identifier: 'OTHER-1', status: 'Done', previous: 'Started' }), 'helper', 'herdr-hud unavailable'],
  ]) {
    h.respond(args => args[2] === 'complete' ? result : h.fallback(args));
    click(h.view.render(h.cx), 'complete-' + id, h.cx);
    await h.flush();
    assert.deepEqual(h.view.linearSnapshot().note, { identifier: id, error });
    assert.equal(h.view.linearSnapshot().undo, null);
    const tree = h.view.render(h.cx);
    assert.ok(byID(tree, 'issue-' + id));
    assert.ok(text(tree).includes(`Couldn't update ${id}: ${message}`));
  }
  assert.deepEqual(linearCalls(h).slice(2), [
    ['complete', id], ['issues', '--refresh'], ['complete', id], ['issues', '--refresh'],
  ]);
});

test('Linear issue action ignores replies after machine, account, or popup changes', async () => {
  for (const invalidate of [
    h => { h.state.spaces[0].machine = 'other'; h.view.switchLinearTarget(h.cx); },
    h => h.store.set('usage-bar.linear-account-rev', 1),
    h => h.view.close(),
  ]) {
    for (const success of [true, false]) {
      const h = harness({ panel: 'linear' });
      await h.flush();
      let resolve;
      h.respond(args => args[2] === 'complete' ? new Promise(done => { resolve = done; }) : h.fallback(args));
      click(h.view.render(h.cx), 'complete-TEST-1', h.cx);
      invalidate(h);
      if (h.view.linearIssuesReadSeq != null) await new Promise(resolve => setImmediate(resolve));
      const rev = h.store.get('usage-bar.linear-rev');
      const localRev = h.view.linearRev;
      const snapshot = h.view.linearIssues;
      const pending = h.view.linearPending;
      resolve(reply(success ? { identifier: issue.identifier, status: 'Done', previous: 'Started' }
        : { error: 'forbidden' }));
      await h.flush();
      assert.equal(h.store.get('usage-bar.linear-rev'), rev + Number(success));
      assert.equal(h.view.linearRev, localRev);
      assert.equal(h.view.linearIssues, snapshot);
      assert.equal(h.view.linearPending, pending);
      assert.equal(h.view.linearUndo, null);
      assert.equal(h.view.linearActionNote, null);
      assert.equal(h.timers.some(job => job.ms === 6000), false);
      assert.equal(linearCalls(h).some(args => args.includes('--refresh')), false);
    }
  }
});

test('Linear Undo expires after six seconds and a superseded timer leaves the current Undo alone', async () => {
  const h = harness({ panel: 'linear' });
  await h.flush();
  const second = { ...issue, identifier: 'TEST-2' };
  h.view.linearIssues = { ...issuesReply, issues: [issue, second] };
  h.respond(args => args[2] === 'complete' ? reply({ identifier: args[3], status: 'Done', previous: 'Started' })
    : reply({ ...issuesReply, issues: [] }));
  const tree = h.view.render(h.cx);
  click(tree, 'complete-TEST-1', h.cx);
  click(tree, 'complete-TEST-2', h.cx);
  await h.flush();
  const [first, last] = h.timers.filter(job => job.ms === 6000);
  assert.equal(first.canceled, true);
  assert.equal(last.canceled, false);
  first.fn(h.cx);
  assert.equal(h.view.linearSnapshot().undo.identifier, 'TEST-2');
  h.tick(6000);
  assert.equal(h.view.linearSnapshot().undo, null);
  assert.equal(byID(h.view.render(h.cx), 'linear-undo'), undefined);
});

test('Linear restore failure refreshes issues and keeps the error note', async () => {
  const h = harness({ panel: 'linear' });
  await h.flush();
  h.respond(args => {
    if (args[2] === 'complete') return reply({ identifier: issue.identifier, status: 'Done', previous: 'Started' });
    if (args[2] === 'restore') return reply({ error: 'not_found' }, 1);
    return reply({ ...issuesReply, issues: [] });
  });
  click(h.view.render(h.cx), 'complete-TEST-1', h.cx);
  await h.flush();
  click(h.view.render(h.cx), 'linear-undo', h.cx);
  await h.flush();
  assert.deepEqual(linearCalls(h).slice(2), [
    ['complete', 'TEST-1'], ['issues', '--refresh'], ['restore', 'TEST-1', 'Started'], ['issues', '--refresh'],
  ]);
  assert.ok(text(h.view.render(h.cx)).includes("Couldn't update TEST-1: Issue not found"));
});

test('Linear already-completed reply removes the row without offering Undo', async () => {
  const h = harness({ panel: 'linear' });
  await h.flush();
  h.respond(args => args[2] === 'complete'
    ? reply({ identifier: issue.identifier, status: 'Done', previous: null })
    : reply({ ...issuesReply, issues: [] }));
  click(h.view.render(h.cx), 'complete-TEST-1', h.cx);
  await h.flush();
  const tree = h.view.render(h.cx);
  assert.equal(byID(tree, 'issue-TEST-1'), undefined);
  assert.equal(byID(tree, 'linear-undo'), undefined);
  assert.equal(h.view.linearSnapshot().undo, null);
  assert.equal(h.timers.some(job => job.ms === 6000), false);
});

test('Linear pre-write errors skip refresh and the next issue click clears the note', async () => {
  const h = harness({ panel: 'linear' });
  await h.flush();
  h.view.linearIssues = { ...issuesReply, issues: [issue, { ...issue, identifier: 'TEST-2' }] };
  for (const error of ['bad_request', 'busy', 'not_connected', 'expired', 'no_done_state']) {
    h.respond(() => reply({ error }));
    click(h.view.render(h.cx), 'complete-TEST-1', h.cx);
    await h.flush();
    assert.deepEqual(h.view.linearSnapshot().note, { identifier: 'TEST-1', error });
  }
  click(h.view.render(h.cx), 'complete-TEST-2', h.cx);
  assert.equal(h.view.linearSnapshot().note, null);
  await h.flush();
  assert.equal(h.view.linearSnapshot().note.identifier, 'TEST-2');
  assert.equal(linearCalls(h).some(args => args.includes('--refresh')), false);
});
