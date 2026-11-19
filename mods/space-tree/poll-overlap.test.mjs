import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './host.test.mjs';
import * as poll from './poll.js';

const hud = model => ({
  code: 0, stdout: JSON.stringify({ runs: [], terminals: [{ address: 't1', model }] }),
});
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(exec) {
  let now = 0;
  const sleeps = [];
  const Tree = load(new URL('./main.js', import.meta.url), 'SpaceTree', {
    ...poll, Plumbing: class {}, Date: { now: () => now }, panes: () => [], exec,
  });
  const tree = new Tree();
  tree.hudInflight = new Map();
  tree.pollFailures = new Map();
  tree.pollGate = poll.createPollGate({ now: () => now });
  tree.hub = { snapshots: new Map() };
  const cx = { sleep: ms => new Promise(resolve => sleeps.push({ ms, resolve })) };
  return {
    tree, setNow: at => { now = at; },
    start(machine) {
      const token = tree.pollGate.begin();
      assert.ok(token, 'global gate admits the new refresh');
      return tree.pollMachine(cx, machine, token).finally(() => tree.pollGate.end(token));
    },
    timeout() {
      const timer = sleeps.shift();
      assert.equal(timer.ms, 8000);
      timer.resolve();
    },
  };
}

test('a timed-out exec keeps blocking its machine until it settles, while others keep polling', async () => {
  const pending = new Set();
  const calls = [];
  const h = setup((_command, _args, opts) => {
    calls.push(opts);
    if (!opts.on) return Promise.resolve(hud('local'));
    const task = {};
    pending.add(task);
    return new Promise(resolve => { task.finish = reply => { pending.delete(task); resolve(reply); }; });
  });

  const first = h.start('remote');
  h.setNow(8000);
  h.timeout();
  assert.equal(await first, false);
  assert.equal(pending.size, 1);

  h.setNow(9000);
  assert.equal(await h.start('remote'), false);
  assert.equal(await h.start(null), true);
  assert.ok(h.tree.hub.snapshots.has(null));
  h.timeout();

  for (const at of [44999, 45000, 90000]) {
    h.setNow(at);
    assert.equal(await h.start('remote'), false);
    assert.equal(pending.size, 1, `no second exec at t=${at}`);
  }
  assert.equal(calls.filter(opts => opts.on === 'remote').length, 1);

  const [only] = pending;
  only.finish(hud('late'));
  await settle();
  assert.equal(h.tree.hudInflight.has('remote'), false);

  const second = h.start('remote');
  assert.equal(pending.size, 1);
  [...pending][0].finish(hud('fresh'));
  assert.equal(await second, true);
  assert.equal(h.tree.hub.snapshots.get('remote').data.terminals[0].model, 'fresh');
  h.timeout();
});

test('poll keeps a distinct short reason for rejection, bad exit code and invalid JSON', async () => {
  const cases = [
    [() => Promise.reject(new Error('instrumented rejection')), /instrumented rejection/],
    [() => Promise.resolve({ code: 23, stdout: '', stderr: 'x' }), /exit code 23/],
    [() => Promise.resolve({ code: 0, stdout: '{' }), /invalid JSON/],
  ];
  const seen = new Set();
  for (const [exec, expected] of cases) {
    const h = setup(exec);
    assert.equal(await h.start('remote'), false);
    const reason = h.tree.pollFailures.get('remote');
    assert.match(reason, expected);
    seen.add(reason);
    assert.equal(h.tree.hudInflight.has('remote'), false);
    assert.equal(h.tree.hub.snapshots.has('remote'), false);
    assert.match(poll.summarizePollFailures(['remote'], h.tree.pollFailures), /^remote: /);
    h.timeout();
  }
  assert.equal(seen.size, 3);
});
