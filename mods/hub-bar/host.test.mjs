// Synthetic retained-element host shared by interaction tests; no real hc calls.
import { readFileSync } from 'node:fs';
export function element() {
  const node = { nodes: [], style: {}, handlers: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') node.nodes.push(args[0]);
      else if (key === 'children') node.nodes.push(...args[0]);
      else if (key === 'when' && args[0]) args[1](proxy);
      else if (key === 'on_click') node.handlers.click = args[0];
      else if (key === 'on_key_down') node.handlers.key = args[0];
      else node.style[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
export const walk = node => typeof node === 'object' && node ? [node, ...(node.nodes ?? []).flatMap(walk)] : [node];
export const byId = (node, id) => walk(node).find(n => n?.style?.id === id);
export const load = (url, name, deps) => {
  const source = readFileSync(url, 'utf8').replace(/^import .*;\n/gm, '').replace('export default ', '');
  return new Function(...Object.keys(deps), `${source}; return ${name};`)(...Object.values(deps));
};
export function host(initial = {}) {
  const shared = new Map(Object.entries(initial)), calls = [], tasks = [], timers = [], intervals = [];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn(fn) { const task = fn(cx); if (!fn.toString().includes('nextCommand')) tasks.push(task); return task; },
    timer: {
      after(ms, fn) { const timer = { ms, fn, canceled: false, cancel() { this.canceled = true; } }; timers.push(timer); return timer; },
      every(ms, fn) { intervals.push({ ms, fn }); },
    },
  };
  const InputState = { new() {
    let value = ''; const events = {};
    return { value: () => value, set_value(v) { value = v; }, on(name, fn) { events[name] = fn; }, events, release() {} };
  } };
  const deps = { View: class {}, div: element, h_flex: element, InputState, Input: { new: element },
    shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value),
    theme: () => new Proxy({}, { get: (_o, key) => key }),
    notify: value => calls.push({ notify: value }), run: (...args) => calls.push({ run: args }),
    hc: async args => { calls.push({ hc: args }); return { code: 0 }; },
  };
  return { deps, shared, calls, tasks, timers, intervals, cx,
    async flush() { while (tasks.length) await Promise.all(tasks.splice(0)); },
    tick(ms) { for (const t of timers.filter(t => !t.canceled && t.ms === ms)) { t.canceled = true; t.fn(cx); } },
  };
}
