import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './model.js';
import { load, host, byId } from './host.test.mjs';
const heads = [{ address: 't1', tabName: 'One', spaceName: 'Repo', status: 'working' },
  { address: 'remote/t2', tabName: 'Two', spaceName: 'Remote', status: 'blocked' }];
function setup(list = heads) {
  const h = host({ 'hub.heads': list, 'hub.stale': false });
  const Bar = load(new URL('./main.js', import.meta.url), 'HubBar', { ...h.deps, ...model });
  h.view = new Bar(); h.view.init({}, h.cx); h.view.input.set_value('literal $(message)');
  return h;
}
test('multi-head broadcast requires a second submit and sends literal text plus Enter via hc send', async () => {
  const h = setup();
  h.view.input.events.submit({}, h.cx);
  assert.equal(h.calls.length, 0);
  assert.equal(byId(h.view.render(), 'send').nodes[0], 'Confirm 2');
  h.view.input.events.submit({}, h.cx);
  await h.flush();
  assert.deepEqual(h.calls.filter(c => c.hc).map(c => c.hc), [
    ['send', 't1', 'literal $(message)'], ['send', 'remote/t2', 'literal $(message)'],
  ]);
  assert.equal(h.view.input.value(), '');
});
test('text changes, target changes and Escape invalidate confirmation', async () => {
  const h = setup();
  h.view.send(h.cx);
  h.view.input.set_value('changed'); h.view.input.events.change({}, h.cx);
  h.view.send(h.cx); assert.equal(h.calls.length, 0);
  h.view.send(h.cx); await h.flush();
  h.view.input.set_value('again');
  h.view.send(h.cx);
  byId(h.view.render(), 'chip-t1').handlers.click({}, h.cx);
  assert.equal(h.view.confirmation, null);
  byId(h.view.render(), 'chip-t1').handlers.click({}, h.cx);
  h.view.send(h.cx);
  const wrapper = h.view.render().nodes.find(n => n?.handlers?.key);
  wrapper.handlers.key({ key: 'escape' }, h.cx);
  assert.equal(h.view.confirmation, null);
});
test('single Head sends once; stale, empty and excluded targets never send', async () => {
  const h = setup(heads.slice(0, 1));
  h.view.send(h.cx); h.view.send(h.cx); await h.flush();
  assert.equal(h.calls.filter(c => c.hc).length, 1);
  h.view.input.set_value('again');
  h.shared.set('hub.stale', true); h.view.send(h.cx);
  h.shared.set('hub.stale', false); h.shared.set('hub.excluded', ['t1']); h.view.send(h.cx);
  h.shared.set('hub.excluded', []); h.view.input.set_value('  '); h.view.send(h.cx);
  await h.flush();
  assert.equal(h.calls.filter(c => c.hc).length, 1);
});
test('partial failures retain the draft and warn against resending to successful Heads', async () => {
  const h = host({ 'hub.heads': heads });
  const Bar = load(new URL('./main.js', import.meta.url), 'HubBar', { ...h.deps, ...model,
    hc: async args => { h.calls.push({ hc: args }); return { code: args[1] === 't1' ? 0 : 1 }; } });
  const view = new Bar(); view.init({}, h.cx); view.input.set_value('hello');
  view.send(h.cx); view.send(h.cx); await h.flush();
  assert.equal(view.input.value(), 'hello');
  assert.match(h.calls.at(-1).notify.body, /Failed: Two.*retry individually/);
  assert.equal(view.busy, false);
  assert.equal(h.shared.get('hub.sending'), false);
});
test('close control requests return to normal while preserving unsent text', () => {
  const h = setup();
  byId(h.view.render(), 'close').handlers.click();
  assert.deepEqual(h.calls, [{ run: ['space-tree.hub-close'] }]);
  assert.equal(h.view.input.value(), 'literal $(message)');
});
