import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerIndex, freshPanes, indexSignature } from './orch.js';
const code = readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
function harness(response = { code: 0, stdout: JSON.stringify({ runs: [], terminals: [] }) }) {
  let data;
  let calls = 0, notifications = 0;
  const tasks = [];
  const cx = { notify() { notifications++; }, spawn(fn) { tasks.push(fn(cx)); } };
  const Agents = new Function('View', 'workerIndex', 'freshPanes', 'indexSignature', 'shared', 'exec', `${code}; return Agents;`)(class {}, workerIndex, freshPanes, indexSignature, () => data, async () => { calls++; return response; });
  const view = new Agents();
  return { view, cx, set(value) { data = value; }, get calls() { return calls; }, get notifications() { return notifications; }, async flush() { await Promise.all(tasks.splice(0)); } };
}
test('fresh shared panes avoid exec, and timestamp-only changes avoid redraw', async () => {
  const h = harness();
  h.set({ at: new Date().toISOString(), runs: [], terminals: [{ address: 't1', labels: { 'hub.observer': 't2' } }] });
  h.view.loadOrch(h.cx);
  assert.equal(h.calls, 0);
  assert.equal(h.notifications, 1);
  h.set({ at: new Date().toISOString(), runs: [], terminals: [{ address: 't1', labels: { 'hub.observer': 't2' } }] });
  h.view.loadOrch(h.cx);
  assert.equal(h.notifications, 1);
  h.set({ at: new Date().toISOString(), runs: [], terminals: [] });
  h.view.loadOrch(h.cx);
  assert.equal(h.notifications, 2);
});
test('missing and stale shared data poll once while a request is in flight', async () => {
  const h = harness();
  h.view.loadOrch(h.cx); h.view.loadOrch(h.cx);
  await h.flush();
  assert.equal(h.calls, 1);
  h.set({ at: new Date(Date.now() - 10001).toISOString(), runs: [] });
  h.view.loadOrch(h.cx); await h.flush();
  assert.equal(h.calls, 2);
  assert.equal(h.notifications, 1);
});
test('invalid and future timestamps cannot suppress fallback polling', () => {
  for (const at of [undefined, 'invalid', Date.now() + 100000]) assert.equal(freshPanes({ at }), null);
});

const good = { runs: [{ head_terminal: 'head', workers: [{ terminal: 'worker', status: 'prompted' }] }], terminals: [{ address: 'observer', labels: { 'hub.observer': 'head' } }] };
const invalid = [null, [], {}, 'text', { runs: [] }, { terminals: [] },
  { runs: {}, terminals: [] }, { runs: [], terminals: {} },
  { error: 'cannot list terminals', runs: [], terminals: [] },
  { error: null, runs: [], terminals: [] }];
test('helper error JSON and malformed responses retain the complete last good index on both paths', async () => {
  for (const data of invalid) for (const cached of [true, false]) {
    const h = harness({ code: 0, stdout: JSON.stringify(data) });
    h.view.applyOrch(good, h.cx); const previous = h.view.orch;
    h.set(cached && data && typeof data === 'object' ? { ...data, at: new Date().toISOString() } : null);
    h.view.loadOrch(h.cx); await h.flush();
    assert.equal(h.view.orch, previous, JSON.stringify({ data, cached }));
    assert.equal(h.view.orch.workers.size, 1); assert.equal(h.view.orch.heads.size, 1); assert.equal(h.view.orch.observers.size, 1);
    assert.equal(h.notifications, 1);
  }
});
test('nonzero exits and invalid JSON retain the index and release the polling flag', async () => {
  for (const response of [{ code: 1, stdout: JSON.stringify({ runs: [], terminals: [] }) }, { code: 0, stdout: 'not json' }]) {
    const h = harness(response); h.view.applyOrch(good, h.cx); const previous = h.view.orch;
    h.view.loadOrch(h.cx); await h.flush(); assert.equal(h.view.orch, previous); assert.equal(h.view.orchLoading, false);
  }
});
test('empty well-formed success replaces the index on both paths', async () => {
  for (const cached of [true, false]) {
    const h = harness(); h.view.applyOrch(good, h.cx);
    if (cached) h.set({ at: new Date().toISOString(), runs: [], terminals: [] });
    h.view.loadOrch(h.cx); await h.flush();
    assert.equal(h.view.orch.workers.size, 0); assert.equal(h.view.orch.heads.size, 0); assert.equal(h.view.orch.observers.size, 0);
    assert.equal(h.notifications, 2); assert.equal(h.calls, cached ? 0 : 1);
  }
});
