import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, host } from '../cerberus-bar/host.test.mjs';
import * as model from './model.js';
function setup() {
  const h = host();
  h.spaces = [{ id: 's', name: 'Repo', machine: null, tabs: [{ id: 'tb', name: 'Head', index: 1 }] }];
  h.panes = [{ tab: 'tb', terminal: 't1', status: 'working' }];
  h.hud = { runs: [], terminals: [{ address: 't1' }] };
  h.responses = () => ({ code: 0, stdout: JSON.stringify(h.hud) });
  let id = 0;
  const deps = { ...h.deps, ...model, props: () => ({}), spaces: () => h.spaces,
    machines: () => [], panes: () => h.panes,
    nextCommand: () => new Promise(() => {}),
    exec: async (...args) => { h.calls.push({ exec: args }); return h.responses(args); },
    openOverlay: spec => { h.calls.push({ open: spec }); return `overlay-${++id}`; },
    closeOverlay: id => h.calls.push({ close: id }),
  };
  const Controller = load(new URL('./main.js', import.meta.url), 'Cerberus', deps);
  h.view = new Controller(); h.view.init({}, h.cx);
  return h;
}
test('controller owns named near-full window, tracks the id, and closes on a second toggle', async () => {
  const h = setup(); await h.flush();
  assert.equal(h.calls.filter(c => c.open).length, 0);
  assert.equal(h.shared.get('cerberus.heads').length, 1);
  h.view.toggle(h.cx);
  const spec = h.calls.find(c => c.open).open;
  assert.equal(spec.key, 'cerberus');
  assert.equal(spec.width, 0.96);
  assert.equal(spec.layout.children[0].size.px, 44);
  assert.equal(spec.layout.children[1].children[0].children[1].content.terminal, 't1');
  h.view.toggle(h.cx);
  assert.equal(h.calls.at(-1).close, 'overlay-1');
  assert.equal(h.shared.get('cerberus.open'), false);
});
test('head-set changes debounce rebuilds only while open and preserve named window placement', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.panes.push({ tab: 'tb', terminal: 't2', status: 'idle' }); h.hud.terminals.push({ address: 't2' });
  h.view.refresh(h.cx); await h.flush();
  assert.equal(h.calls.filter(c => c.open).length, 1);
  h.panes[1].status = 'blocked'; h.view.sync(h.cx);
  assert.equal(h.timers.filter(t => !t.canceled).length, 1);
  h.tick(1000);
  assert.deepEqual(h.calls.filter(c => c.open).map(c => c.open.key), ['cerberus', 'cerberus']);
  assert.equal(h.calls.filter(c => c.close).at(-1).close, 'overlay-1');
  h.view.hide(); h.panes.pop(); h.view.sync(h.cx); h.tick(1000);
  assert.equal(h.calls.filter(c => c.open).length, 2);
});
test('status remains live, failed polls retain known Heads and disable broadcast', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.panes[0].status = 'done'; h.view.sync(h.cx);
  assert.equal(h.timers.filter(t => !t.canceled).length, 0);
  assert.equal(h.shared.get('cerberus.heads')[0].status, 'done');
  h.responses = () => ({ code: 1 }); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.shared.get('cerberus.heads').length, 1);
  assert.equal(h.shared.get('cerberus.stale'), true);
  h.view.close(); assert.equal(h.shared.get('cerberus.open'), false);
});
test('rebuild waits while a broadcast is in flight and handles removal before debounce', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.shared.set('cerberus.sending', true);
  h.shared.set('cerberus.focus', 't1'); h.view.sync(h.cx);
  assert.equal(h.timers.length, 0);
  h.shared.set('cerberus.sending', false); h.view.sync(h.cx);
  assert.equal(h.timers.length, 1);
  h.shared.set('cerberus.focus', null); h.view.sync(h.cx); h.tick(1000);
  assert.equal(h.calls.filter(c => c.open).length, 1);
});


test('closing waits for a confirmed broadcast to finish', async () => {
  const h = setup(); await h.flush(); h.view.toggle(h.cx);
  h.shared.set('cerberus.sending', true); h.view.hide();
  assert.equal(h.calls.filter(c => c.close).length, 0);
  h.shared.set('cerberus.sending', false); h.view.sync(h.cx);
  assert.equal(h.calls.filter(c => c.close).at(-1).close, 'overlay-1');
  assert.equal(h.shared.get('cerberus.open'), false);
});


test('remote helper metadata qualifies worker addresses before excluding them', async () => {
  const h = setup(); await h.flush();
  h.spaces.push({ id: 'remote/host/s', name: 'Remote', machine: 'remote/host', tabs: [{ id: 'remote/host/tb', index: 1, name: 'Remote Head' }] });
  h.panes.push({ tab: 'remote/host/tb', terminal: 'remote/host/t1', status: 'idle' },
    { tab: 'remote/host/tb', terminal: 'remote/host/t2', status: 'working' });
  h.responses = args => ({ code: 0, stdout: JSON.stringify(args[2].on ? {
    runs: [{ workers: [{ terminal: 't2' }] }], terminals: [{ address: 't1' }, { address: 't2' }],
  } : h.hud) });
  h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.shared.get('cerberus.heads').map(h => h.address), ['t1', 'remote/host/t1']);
  assert.deepEqual(h.calls.filter(c => c.exec).at(-1).exec[2], { on: 'remote/host' });
});

test('cockpit mounts the resident controller in a zero-height column slot and ships the key', () => {
  const layout = JSON.parse(readFileSync(new URL('../../layouts/cockpit.json', import.meta.url), 'utf8'));
  const work = layout.children.find(node => node.id === 'work');
  assert.equal(work.type, 'column');
  const controller = work.children.find(node => node.content?.mod === 'cerberus');
  assert.equal(controller.size.px, 0);
  assert.notEqual(controller.hidden, true);
  const keys = JSON.parse(readFileSync(new URL('../../keys/cerberus.json', import.meta.url), 'utf8'));
  assert.equal(keys.global['ctrl-shift-h'], 'cerberus.toggle');
});

test('mod.open launcher forwards to the resident receiver and closes only its bootstrap overlay', () => {
  const h = host();
  const Controller = load(new URL('./main.js', import.meta.url), 'Cerberus', {
    ...h.deps, ...model, props: () => ({ overlay: 'bootstrap' }),
    closeOverlay: id => h.calls.push({ close: id }),
  });
  const view = new Controller(); view.init({}, h.cx); view.close();
  assert.deepEqual(h.calls, [{ run: ['cerberus.toggle'] }, { close: 'bootstrap' }]);
});
