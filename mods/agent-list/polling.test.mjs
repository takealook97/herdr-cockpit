import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerIndex, freshPanes, indexSignature } from './orch.js';
const code = readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
function harness() {
  let data;
  let calls = 0, notifications = 0;
  const tasks = [];
  const cx = { notify() { notifications++; }, spawn(fn) { tasks.push(fn(cx)); } };
  const Agents = new Function('View', 'workerIndex', 'freshPanes', 'indexSignature', 'shared', 'exec', `${code}; return Agents;`)(class {}, workerIndex, freshPanes, indexSignature, () => data, async () => { calls++; return { code: 0, stdout: JSON.stringify({ runs: [] }) }; });
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
  h.set({ at: new Date().toISOString(), runs: [] });
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
