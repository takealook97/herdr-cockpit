import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as format from './format.js';
import * as linear from './linear.js';
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
  '{cell, groupLabel, systemRow, iconButton, linearButton}');
const walk = node => typeof node === 'object' ? [node, ...node.nodes.flatMap(walk)] : [node];
const text = node => walk(node).filter(value => typeof value === 'string');
const byID = (node, id) => walk(node).find(value => value?.style?.id === id);

const org = { name: 'Example', url: 'https://linear.app/example' };
const issue = { identifier: 'TEST-1', title: 'An assigned issue', url: org.url + '/issue/TEST-1',
  status: 'Blocked', status_type: 'started', priority: 1, project: 'Example / Test Project', due_date: '2000-01-01' };
const statusReply = { connected: true, source: 'claude_mcp', org, expires_at: '2099-07-10T12:00:00Z', error: null };
const issuesReply = { source: 'claude_mcp', issues: [issue], org_url: org.url, stale: false, error: null };
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
  const deps = { View: class {}, div, h_flex, v_flex, Switch: controls('switch'), InputState,
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
  assert.deepEqual(h.intervals.map(job => job.ms), [1000, 60000, 120000]);
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
  assert.deepEqual(linearCalls(restarted), startup);
  restarted.intervals.find(job => job.ms === 120000).fn(restarted.cx);
  assert.deepEqual(linearCalls(restarted), startup);
  click(popup, 'visible-linear', settings.cx);
  assert.ok(byID(restarted.view.render(restarted.cx), 'linear'));
  restarted.tick(0); await restarted.flush();
  assert.deepEqual(linearCalls(restarted).slice(2), startup);
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
    const h = harness({ panel, machine: 'remote' }); await h.flush();
    assert.equal(h.intervals.length, 0);
    assert.equal(h.timers.length, 0);
    assert.equal(h.calls.length, expected.length);
    assert.deepEqual(linearCalls(h), expected);
    assert.ok(h.calls.every(call => call.options.length === 0));
  }

  const bar = harness({ machine: 'remote' }); await bar.flush();
  bar.intervals.find(job => job.ms === 120000).fn(bar.cx);
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
  assert.deepEqual(popup.writes, ['usage-bar.linear-rev']);
  finishInitial(reply(issuesReply)); await popup.flush();
  const labels = text(popup.view.render(popup.cx));
  assert.ok(labels.includes('New title'));
  assert.ok(!labels.includes(issue.title));

  bar.view.render(bar.cx);
  assert.equal(linearCalls(bar).length, 2);
  bar.tick(0); await bar.flush();
  assert.deepEqual(linearCalls(bar).slice(2), [['status'], ['issues', '--max-age', '60s']]);
});

test('Linear panel shows grouped issue details and opens only Linear links', async () => {
  const h = harness({ panel: 'linear', initialResponse: args => args[2] === 'status' ? reply(statusReply) :
    reply({ ...issuesReply, issues: [issue, { ...issue, identifier: 'TEST-2', url: 'https://example.invalid/' }] }) });
  await h.flush();
  const panel = h.view.render(h.cx), labels = text(panel);
  assert.ok(['My issues · Example', 'Blocked (2)', '!', 'TEST-1', issue.title, 'Test Project'].every(label => labels.includes(label)));
  assert.equal(panel.style.max_h, 520);
  assert.deepEqual(byID(panel, 'linear-issue-list').style.overflow_y_scroll, []);
  assert.ok(labels.some(label => /d over$/.test(label)));
  assert.equal(byID(panel, 'issue-TEST-2').style.on_click, undefined);
  click(panel, 'linear-open', h.cx);
  click(panel, 'issue-TEST-1', h.cx);
  assert.deepEqual(h.urls, [org.url + '/my-issues/assigned', issue.url]);
  assert.deepEqual(h.closed, ['linear-overlay']);
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
  assert.deepEqual([...h.store], [['usage-bar.linear-rev', 1]]);
  assert.deepEqual(linearCalls(h).at(-1), ['status']);
  click(tree, 'linear-create-key', h.cx);
  assert.deepEqual(h.urls, ['https://linear.app/settings/account/security']);
  tree.style.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.closed, ['settings-overlay']);
});

test('Disconnect is offered for an API key and re-reads status for the fallback', async () => {
  const apiKeyStatus = { connected: true, source: 'api_key', user: { name: 'Test Viewer' }, org, error: null };
  const h = harness({ panel: 'settings', initialResponse: () => reply(apiKeyStatus) });
  await h.flush();
  const tree = h.view.render(h.cx);
  assert.ok(text(tree).includes('API key · Test Viewer'));
  h.respond(() => reply(statusReply));
  click(tree, 'linear-disconnect', h.cx);
  await h.flush();
  assert.deepEqual(linearCalls(h), [['status'], ['disconnect'], ['status']]);
  assert.deepEqual([...h.store], [['usage-bar.linear-rev', 1]]);
  assert.equal(byID(h.view.render(h.cx), 'linear-disconnect'), undefined);
});

test('connect updates the API-key status and clears old issue snapshots on revision change', async () => {
  let finishOldRead;
  const store = new Map();
  const popup = harness({ panel: 'linear', store }), settings = harness({ panel: 'settings', store });
  await Promise.all([popup.flush(), settings.flush()]);
  popup.respond(args => args[2] === 'issues'
    ? new Promise(resolve => { finishOldRead = resolve; }) : reply(statusReply));
  popup.view.readLinear('issues', popup.cx);

  const apiKeyStatus = { connected: true, source: 'api_key', user: { name: 'Test Viewer' }, org, error: null };
  settings.respond(() => reply(apiKeyStatus));
  settings.view.input.set_value(' synthetic-test-key ');
  click(settings.view.render(settings.cx), 'linear-connect', settings.cx);
  await settings.flush();
  assert.deepEqual(linearCalls(settings), [['status'], ['connect', '--key', 'synthetic-test-key'], ['status']]);
  assert.ok(text(settings.view.render(settings.cx)).includes('API key · Test Viewer'));
  assert.ok(!text(popup.view.render(popup.cx)).includes(issue.title));

  finishOldRead(reply(issuesReply)); await popup.flush();
  popup.respond(args => args[2] === 'status' ? reply(apiKeyStatus) :
    reply({ source: 'api_key', issues: [], error: 'network' }));
  popup.tick(0); await popup.flush();
  const popupLabels = text(popup.view.render(popup.cx));
  assert.ok(popupLabels.includes("Couldn't load Linear issues"));
  assert.ok(!popupLabels.includes(issue.title));
});
