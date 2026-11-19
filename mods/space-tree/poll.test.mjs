import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, createPollGate, HUD_EXEC_TIMEOUT_MS, POLL_STALE_MS } from './poll.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('withTimeout preserves a successful value before sleep completes', async () => {
  const timer = deferred(), value = { model: 'current' };
  const result = withTimeout(Promise.resolve(value), HUD_EXEC_TIMEOUT_MS, ms => {
    assert.equal(ms, 8000);
    return timer.promise;
  });
  assert.equal(await result, value);
  timer.resolve();
});

test('withTimeout preserves the original rejection', async () => {
  const timer = deferred(), error = new Error('offline');
  const result = withTimeout(Promise.reject(error), 8, () => timer.promise);
  await assert.rejects(result, actual => actual === error);
});

test('withTimeout rejects a hung operation when controlled sleep completes', async () => {
  const timer = deferred(), operation = deferred();
  const result = withTimeout(operation.promise, 8, () => timer.promise);
  timer.resolve();
  await assert.rejects(result, { message: 'timeout' });
  operation.reject(new Error('late rejection is handled'));
});

test('gate blocks fresh overlap and allows another poll after end', () => {
  const gate = createPollGate({ now: () => 0 });
  const first = gate.begin();
  assert.ok(first);
  assert.equal(gate.isCurrent(first), true);
  assert.equal(gate.begin(), null);
  gate.end(first);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(null), false);
  assert.ok(gate.begin());
});

test('gate supersedes stale polls and ignores an old token ending', () => {
  let now = 0;
  const gate = createPollGate({ now: () => now });
  const old = gate.begin();
  now = POLL_STALE_MS - 1;
  assert.equal(gate.begin(), null);
  now++;
  const current = gate.begin();
  assert.ok(current);
  assert.notEqual(current, old);
  assert.equal(gate.isCurrent(old), false);
  gate.end(old);
  assert.equal(gate.isCurrent(current), true);
  assert.equal(gate.begin(), null);
  gate.end(current);
  assert.ok(gate.begin());
});

test('gate accepts a custom stale interval', () => {
  let now = 10;
  const gate = createPollGate({ now: () => now, staleMs: 3 });
  const old = gate.begin();
  now = 13;
  assert.notEqual(gate.begin(), old);
});
