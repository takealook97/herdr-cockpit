import test from 'node:test';
import assert from 'node:assert/strict';
import { load, host, element } from '../space-tree/host.test.mjs';
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
