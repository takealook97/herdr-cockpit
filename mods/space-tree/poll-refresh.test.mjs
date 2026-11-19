import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host } from './host.test.mjs';
import { mergeHuds } from './hub-model.js';
import * as poll from './poll.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const hud = model => ({ code: 0, stdout: JSON.stringify({ runs: [], terminals: [{ address: 't1', model }] }) });

function setup(options = {}) {
  const h = host();
  Object.assign(h, { now: 0, sleeps: [], execs: [], errors: [], machineNames: ['remote'], syncs: 0 }, options);
  h.cx.sleep = ms => new Promise(resolve => h.sleeps.push({ ms, resolve }));
  h.cx.spawn = fn => {
    const task = fn(h.cx);
    const handled = task.catch(error => h.errors.push(error));
    if (!fn.toString().includes('nextCommand')) h.tasks.push(handled);
    return task;
  };
  const Hub = class {
    snapshots = new Map();
    init() {}
    sync() { h.syncs++; if (h.fail === 'sync') { h.fail = null; throw new Error('sync'); } }
  };
  const deps = { ...h.deps, ...poll, Hub, Date: { now: () => h.now }, Plumbing: class { init() {} }, initRename() {},
    props: () => ({}), localStorage: { getItem() { return null; } },
    createPollGate: () => poll.createPollGate({ now: () => h.now }),
    nextCommand: () => new Promise(() => {}), spaces: () => [], panes: () => [],
    machines: () => { if (h.fail === 'machines') { h.fail = null; throw new Error('machines'); }
      return h.machineNames.map(name => ({ name })); },
    mergeHuds: snapshots => { if (h.fail === 'merge') { h.fail = null; throw new Error('merge'); }
      return mergeHuds(snapshots); },
    setShared: (key, value) => { if (h.fail === 'shared' || h.fail === 'shared-always') {
      if (h.fail === 'shared') h.fail = null;
      throw new Error('shared');
    } return h.deps.setShared(key, value); },
    exec: (_command, _args, { on }) => {
      h.execs.push(on ?? null);
      if (h.execute) return h.execute(on);
      if (h.remoteHung && on) return new Promise(() => {});
      if (h.fail === 'exec') return Promise.reject(new Error('offline'));
      if (h.fail === 'json') return Promise.resolve({ code: 0, stdout: '{' });
      return Promise.resolve(hud(h.model ?? 'current'));
    },
  };
  const Tree = load(process.env.SPACE_TREE_MAIN ?? new URL('./main.js', import.meta.url), 'SpaceTree', deps);
  h.tree = new Tree(); h.tree.init({}, h.cx);
  h.refresh = () => h.intervals.find(timer => timer.ms === 3000).fn(h.cx);
  return h;
}

async function finishTick(h) {
  await settle();
  for (const sleep of h.sleeps.splice(0)) sleep.resolve();
  await h.flush();
}

test('a never-settling remote exec is never overlapped, even after 45 seconds', async () => {
  const h = setup({ remoteHung: true });
  await finishTick(h);
  for (let now = 3000; now <= 120000; now += 3000) {
    h.now = now;
    h.refresh(); await finishTick(h);
  }
  assert.equal(h.execs.filter(on => on === 'remote').length, 1);
  assert.match(h.shared.get('hub.lastError'), /remote: previous poll still running/);
  assert.equal(h.shared.get('hub.stale'), true);
  assert.deepEqual(h.errors, []);
});

test('a timed-out remote stays in flight while local polls and retries after exec settles', async () => {
  // Arrange
  let resolveRemote;
  const h = setup({ execute: on => on
    ? new Promise(resolve => { resolveRemote = resolve; }) : Promise.resolve(hud('current')) });
  await settle();
  assert.equal(h.tree.orchLoaded, false);

  // Act
  for (const sleep of h.sleeps) { assert.equal(sleep.ms, poll.HUD_EXEC_TIMEOUT_MS); sleep.resolve(); }
  await settle();
  for (let tick = 0; tick < 3; tick++) { h.refresh(); await h.flush(); }

  // Assert
  assert.equal(h.execs.filter(on => on === 'remote').length, 1);
  assert.equal(h.execs.filter(on => on === null).length, 4);
  assert.equal(h.tree.orchLoaded, true);
  assert.equal(h.tree.lastModel.t1.model, 'current');
  assert.equal(h.tree.orchStale, true);
  assert.equal(h.shared.get('hub.stale'), true);

  // Arrange
  h.execute = () => Promise.resolve(hud('next'));

  // Act
  resolveRemote(hud('old')); await settle();
  h.refresh(); await h.flush();

  // Assert
  assert.equal(h.execs.filter(on => on === 'remote').length, 2);
  assert.equal(h.execs.filter(on => on === null).length, 5);
  assert.equal(h.tree.lastModel.t1.model, 'next');
  assert.equal(h.tree.orchStale, false);
  assert.equal(h.shared.get('hub.stale'), false);
  assert.deepEqual(h.errors, []);
});

test('a hub.sync exception releases the guard for the next tick', async () => {
  const h = setup({ fail: 'sync' });
  await settle();
  const count = h.execs.length;
  h.refresh(); await settle();
  assert.equal(h.execs.length, count + 2);
  assert.equal(h.syncs, 2);
  assert.equal(h.tree.orchStale, false);
  assert.deepEqual(h.errors, []);
});

for (const failure of ['exec', 'json', 'machines', 'merge', 'shared', 'shared-always', 'sync']) {
  test(`${failure} failure marks stale and permits recovery on the next tick`, async () => {
    const h = setup({ fail: failure });
    await settle();
    assert.equal(h.tree.orchStale, true);
    if (failure !== 'shared-always') assert.equal(h.shared.get('hub.stale'), true);
    const count = h.execs.length;
    h.fail = null; h.refresh(); await h.flush();
    assert.equal(h.execs.length, count + 2);
    assert.equal(h.tree.orchStale, false);
    assert.equal(h.shared.get('hub.stale'), false);
    assert.deepEqual(h.errors, []);
  });
}

test('a superseded poll cannot overwrite snapshots, cached labels, or merged hud', async () => {
  const pending = [];
  const h = setup({ execute: on => on
    ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(hud('old')) });
  await settle();
  h.now = poll.POLL_STALE_MS + 1;
  h.machineNames = ['new']; h.execute = () => Promise.resolve(hud('new'));
  h.refresh(); await settle();
  assert.equal(h.tree.lastModel.t1?.model, 'new', 'stale in-flight work must be superseded');
  const orch = h.tree.orch, lastModel = structuredClone(h.tree.lastModel);
  const snapshots = [...h.tree.hub.snapshots], syncs = h.syncs;
  pending.forEach(resolve => resolve(hud('old')));
  await h.flush();
  assert.deepEqual([...h.tree.hub.snapshots], snapshots);
  assert.deepEqual(h.tree.lastModel, lastModel);
  assert.equal(h.tree.orch, orch);
  assert.equal(h.tree.orchStale, false);
  assert.equal(h.shared.get('hub.stale'), false);
  assert.equal(h.syncs, syncs);
  assert.deepEqual(h.errors, []);
});

test('a superseded poll that throws cannot mark the current hud stale', async () => {
  // Arrange
  const h = setup();
  await h.flush();
  const pollMachine = h.tree.pollMachine;
  let rejectOld;
  const pending = new Promise((_resolve, reject) => { rejectOld = reject; });
  h.tree.pollMachine = () => pending;
  h.refresh();
  h.now = poll.POLL_STALE_MS + 1;
  h.tree.pollMachine = pollMachine;
  h.refresh(); await settle();
  assert.equal(h.tree.orchStale, false);
  assert.equal(h.shared.get('hub.stale'), false);

  // Act
  rejectOld(new Error('superseded poll failed'));
  await h.flush();

  // Assert
  assert.equal(h.tree.orchStale, false);
  assert.equal(h.shared.get('hub.stale'), false);
  assert.deepEqual(h.errors, []);
});
