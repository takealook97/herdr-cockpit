import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, element, byId } from '../space-tree/host.test.mjs';
import * as model from './model.js';

function setup(reply, props = {}) {
  const h = host(); h.closed = []; h.execs = [];
  const Nexus = load(new URL('./main.js', import.meta.url), 'Nexus', { ...h.deps, ...model, v_flex: element,
    InputState: { new: opts => ({ ...h.deps.InputState.new(opts), focus() {} }) },
    exec: async (_c, args) => {
      h.execs.push(args.slice(4));
      const sub = args[4] === 'listen' ? 'listen' : args[4];
      const out = sub === 'log' ? { entries: [] } : sub === 'listen' ? { state: 'idle' } : reply;
      return { code: 0, stdout: JSON.stringify(out) };
    },
    panes: () => [], terminals: () => [], props: () => ({ overlay: 'ov', ...props }),
    closeOverlay: id => h.closed.push(id), });
  h.view = new Nexus(); h.view.init({}, h.cx); return h;
}

test('a sent reply records nexus.last, closes the dialog and toasts when hub is closed', async () => {
  const h = setup({ action: 'send', target: 't1', label: 'tool · x', sent: true });
  assert.equal(h.shared.get('nexus.open'), true);
  h.view.input.set_value('hello'); h.view.submit(h.cx); await h.flush();
  assert.deepEqual(h.closed, ['ov']);
  assert.equal(h.shared.get('nexus.last').label, 'tool · x');
  assert.equal(h.calls.find(c => c.notify).notify.action.args.terminal, 't1');
  assert.equal(h.view.input.value(), '');
  h.view.close(); assert.equal(h.shared.get('nexus.open'), false);
});

test('hub open focuses the Head instead of toasting; ask keeps the dialog open with candidates', async () => {
  const h = setup({ action: 'send', target: 't2', label: 'a · b', sent: true }); h.shared.set('hub.open', true);
  h.view.input.set_value('go'); h.view.submit(h.cx); await h.flush();
  assert.deepEqual(h.calls.find(c => c.run).run, ['pane.focus', { terminal: 't2' }]);
  const a = setup({ action: 'ask', question: 'which?', candidates: [{ address: 't1', label: 'x' }], message: 'm' });
  a.view.input.set_value('go'); a.view.submit(a.cx); await a.flush();
  assert.deepEqual(a.closed, []); assert.equal(a.view.reply.action, 'ask');
});

test('empty input is ignored and errors keep the typed text', async () => {
  const h = setup({ action: 'error', error: 'boom' });
  h.view.submit(h.cx); await h.flush(); assert.ok(!h.execs.some(a => a[0] === 'route'));
  h.view.input.set_value('x'); h.view.submit(h.cx); await h.flush();
  assert.equal(h.view.input.value(), 'x'); assert.equal(h.view.reply.error, 'boom');
});

function voice(handler, props = { listen: true }) {
  const h = host(); h.closed = []; h.execs = [];
  h.cx.timer.every = (ms, fn) => { const t = { ms, fn, canceled: false, cancel() { this.canceled = true; } }; h.intervals.push(t); return t; };
  const Nexus = load(new URL('./main.js', import.meta.url), 'Nexus', { ...h.deps, ...model, v_flex: element,
    InputState: { new: opts => ({ ...h.deps.InputState.new(opts), focus() {} }) },
    exec: async (_c, args) => { h.execs.push(args.slice(4)); return { code: 0, stdout: JSON.stringify(await handler(args.slice(4), h)) }; },
    panes: () => [], terminals: () => [], props: () => ({ overlay: 'ov', ...props }), closeOverlay: id => h.closed.push(id) });
  h.live = () => h.intervals.filter(t => !t.canceled);
  h.view = new Nexus(); h.view.init({}, h.cx); return h;
}
const settle = () => new Promise(r => setImmediate(r));
const withClock = async (fn) => {
  const real = Date.now; let now = 1000; Date.now = () => now;
  try { await fn(ms => { now += ms; }); } finally { Date.now = real; }
};

test('unavailable helper hides the mic and never creates a poll timer', async () => {
  const h = voice(async a => a[0] === 'log' ? { entries: [] } : { state: 'unavailable' });
  await h.flush();
  assert.equal(h.view.micHidden, true); assert.equal(h.view.listening, false);
  assert.equal(h.live().length, 0); assert.ok(!h.execs.some(a => a[1] === 'start'));
  assert.match(h.view.reply.info, /음성 입력을 쓸 수 없습니다/);
});

test('unavailable start reply and unavailable poll both stop polling', async () => {
  const h = voice(async a => a[0] === 'log' ? { entries: [] } : a[1] === 'status' && h.execs.filter(x => x[1] === 'status').length < 2 ? { state: 'idle' } : { state: 'unavailable' });
  await h.flush();
  assert.equal(h.view.micHidden, true); assert.equal(h.live().length, 0);
  const p = voice(async a => a[0] === 'log' ? { entries: [] } : a[1] === 'start' ? { state: 'listening' } : p.execs.filter(x => x[1] === 'status').length < 2 ? { state: 'idle' } : { state: 'unavailable' });
  await p.flush(); assert.equal(p.live().length, 1);
  p.view.pollStatus(p.cx); await p.flush();
  assert.equal(p.view.listening, false); assert.equal(p.live().length, 0); assert.equal(p.view.micHidden, true);
});

test('stop during a pending start leaves no live timers and stops the helper', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const h = voice(async a => a[0] === 'log' ? { entries: [] } : a[1] === 'start' ? pending : { state: 'idle' }, {});
  await h.flush(); h.view.startListening(h.cx);
  h.view.stopListening(h.cx); resolve({ state: 'listening' }); await h.flush();
  assert.equal(h.view.listening, false); assert.equal(h.live().length, 0);
  assert.equal(h.execs.filter(a => a[1] === 'stop').length, 1);
});

test('early idle is ignored during startup so later partials reach the input; persistent idle stops', async () => {
  await withClock(async advance => {
    let polls = 0;
    const h = voice(async a => a[0] === 'log' ? { entries: [] } : a[1] === 'start' ? { state: 'listening' }
      : a[1] === 'status' && h.view?.startedAt ? (++polls === 1 ? { state: 'idle' } : { state: 'listening', partial: '안녕' }) : { state: 'idle' });
    await h.flush(); h.view.pollStatus(h.cx); await h.flush();
    assert.equal(h.view.listening, true);
    h.view.pollStatus(h.cx); await h.flush();
    assert.equal(h.view.input.value(), '안녕');
    const g = voice(async a => a[0] === 'log' ? { entries: [] } : a[1] === 'start' ? { state: 'listening' } : { state: 'idle' });
    await g.flush(); g.view.pollStatus(g.cx); await g.flush();
    assert.equal(g.view.listening, true);
    advance(3001); g.view.pollStatus(g.cx); await g.flush();
    assert.equal(g.view.listening, false); assert.equal(g.live().length, 0);
  });
});

test('a send reply with a warning still succeeds and warns', async () => {
  const h = setup({ action: 'send', target: 't1', label: 'x', sent: true, warning: '확인 필요' });
  h.view.input.set_value('hi'); h.view.submit(h.cx); await h.flush();
  assert.deepEqual(h.closed, ['ov']);
  const w = h.calls.map(c => c.notify).filter(Boolean).find(n => n.level === 'warning');
  assert.deepEqual(w, { title: 'Nexus', body: '확인 필요', level: 'warning', timeout: 6000 });
});

test('stale start continuation stops only its own pid and leaves the newer session alive', async () => {
  const held = []; let starts = 0;
  const h = voice(async a => {
    if (a[0] === 'log') return { entries: [] };
    if (a[1] === 'start') { if (++starts === 1) return new Promise(r => held.push(r)); return { state: 'listening', pid: 222 }; }
    return { state: 'idle' };
  }, {});
  await h.flush(); h.view.startListening(h.cx);
  h.view.stopListening(h.cx); h.view.startListening(h.cx); await settle();
  const before = h.execs.filter(a => a[1] === 'stop').length;
  held[0]({ state: 'listening', pid: 111 }); await h.flush();
  const stops = h.execs.filter(a => a[1] === 'stop').slice(before);
  assert.deepEqual(stops, [['listen', 'stop', '--pid', '111']]);
  assert.equal(h.view.listening, true); assert.equal(h.view.listenPid, 222); assert.equal(h.live().length, 1);
  h.view.stopListening(h.cx); await h.flush();
  assert.deepEqual(h.execs.filter(a => a[1] === 'stop').pop(), ['listen', 'stop', '--pid', '222']);
});

test('init probe resolving after the user started and stopped does not auto-start', async () => {
  let release; const probe = new Promise(r => { release = r; });
  let statuses = 0;
  const h = voice(async a => {
    if (a[0] === 'log') return { entries: [] };
    if (a[1] === 'status' && ++statuses === 1) return probe;
    return a[1] === 'start' ? { state: 'listening', pid: 5 } : { state: 'idle' };
  });
  h.view.startListening(h.cx); await settle();
  h.view.stopListening(h.cx); await settle();
  const starts = h.execs.filter(a => a[1] === 'start').length;
  release({ state: 'idle' }); await h.flush();
  assert.equal(h.execs.filter(a => a[1] === 'start').length, starts);
  assert.equal(h.live().length, 0); assert.equal(h.view.listening, false);
});

test('local ignore clears input, keeps the dialog open and renders a dim reason', async () => {
  for (const summary of [undefined, '다른 사람에게 한 말입니다']) {
    const h = setup({ action: 'ignore', local: true, sent: false, summary });
    h.view.input.set_value('ㅋㅋㅋ'); h.view.submit(h.cx); await h.flush();
    assert.equal(h.view.input.value(), '');
    assert.equal(h.view.pending, false);
    assert.deepEqual(h.closed, []);
    assert.equal(h.calls.filter(c => c.notify || c.run).length, 0);
    const rendered = JSON.stringify(h.view.logView({ dim: 'dim' }));
    assert.ok(rendered.includes('· ' + (summary || '명령으로 들리지 않아 넘겼습니다')));
    assert.ok(rendered.includes('dim'));
  }
});

test('voice auto-send ignore leaves the dialog idle without an error', async () => {
  const h = voice(async a => a[0] === 'log' ? { entries: [] }
    : a[0] === 'route' ? { action: 'ignore', local: true, sent: false }
    : { state: 'idle' }, {});
  await h.flush();
  h.view.finishListening('하하하', h.cx);
  h.view.countdown.fn(h.cx);
  await h.flush();
  assert.equal(h.view.listening, false);
  assert.equal(h.view.countdown, null);
  assert.equal(h.view.pending, false);
  assert.equal(h.view.input.value(), '');
  assert.equal(h.view.reply.action, 'ignore');
  assert.deepEqual(h.closed, []);
});

test('model ignore keeps the original input available for editing and resending', async () => {
  const h = setup({ action: 'ignore', sent: false, summary: '잠시 기다리는 말입니다' });
  h.view.input.set_value('  네  '); h.view.submit(h.cx); await h.flush();
  assert.equal(h.view.input.value(), '  네  ');
  assert.equal(h.view.pending, false);
  assert.deepEqual(h.closed, []);
  assert.equal(h.calls.filter(c => c.notify || c.run).length, 0);
});

test('laughing status dims dots and retracted laughter text never routes', async () => {
  let status = { state: 'listening', partial: '하하하', level: 0.8, laughing: false };
  const h = voice(async a => a[0] === 'log' ? { entries: [] }
    : a[1] === 'start' ? { state: 'listening', pid: 123 } : status, {});
  await h.flush(); h.view.startListening(h.cx); await h.flush();
  h.view.pollStatus(h.cx); await h.flush();
  assert.equal(h.view.input.value(), '하하하');
  assert.equal(byId(h.view.dots({ accent: 'accent', dim: 'dim' }), 'nexus-dot-0').style.bg, 'accent');
  status = { state: 'listening', partial: '', level: 0.8, laughing: true, trimmed: 1 };
  h.view.pollStatus(h.cx); await h.flush();
  assert.equal(h.view.input.value(), '하하하'); // Empty partials do not write into the input.
  assert.equal(byId(h.view.dots({ accent: 'accent', dim: 'dim' }), 'nexus-dot-0').style.bg, 'dim');
  status = { state: 'idle', final: '', trimmed: 1 };
  h.view.pollStatus(h.cx); await h.flush();
  assert.equal(h.view.listening, false);
  assert.equal(h.view.input.value(), '');
  assert.equal(h.view.countdown, null);
  assert.ok(!h.execs.some(a => a[0] === 'route'));
});


test('typing during auto-listen survives empty and non-empty partials and the final result', async () => {
  for (const terminalState of ['final', 'idle']) {
    let status = { state: 'listening', partial: 'voice', pid: 123 };
    const h = voice(async a => a[0] === 'log' ? { entries: [] }
      : a[1] === 'start' ? { state: 'listening', pid: 123 } : status);
    await h.flush();
    assert.equal(h.view.listening, true);
    h.view.pollStatus(h.cx); await h.flush();
    assert.equal(h.view.input.value(), 'voice');
    h.view.input.events.change(); // A voice write is not typing.
    assert.equal(h.view.typedSinceListen, false);
    h.view.input.set_value('my typed command');
    h.view.input.events.change();
    assert.equal(h.view.typedSinceListen, true);
    for (const partial of ['', 'new voice text']) {
      status = { state: 'listening', partial, pid: 123 };
      h.view.pollStatus(h.cx); await h.flush();
      assert.equal(h.view.input.value(), 'my typed command');
    }
    status = { state: terminalState, final: 'final voice text' };
    h.view.pollStatus(h.cx); await h.flush();
    assert.equal(h.view.input.value(), 'my typed command');
    assert.equal(h.view.listening, false);
    assert.equal(h.view.countdown, null);
    assert.ok(!h.execs.some(a => a[0] === 'route'));
  }
});
