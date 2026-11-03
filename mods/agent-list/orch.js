export function workerIndex(hud) {
  const workers = new Map();
  const heads = new Map();
  const observers = new Set((Array.isArray(hud?.terminals) ? hud.terminals : []).filter(t => t?.labels?.["hub.observer"]).map(t => t.address));
  if (!Array.isArray(hud?.runs)) return { workers, heads, observers };
  for (const run of hud.runs) {
    if (!run || !Array.isArray(run.workers)) continue;
    for (const worker of run.workers) {
      if (!worker || typeof worker.terminal !== "string" || !worker.terminal) continue;
      workers.set(worker.terminal, worker);
      if (typeof run.head_terminal !== "string" || !run.head_terminal || worker.status === "closed" || worker.status === "lost") continue;
      const counts = heads.get(run.head_terminal) ?? { total: 0, working: 0 };
      counts.total++;
      if (worker.status === "spawned" || worker.status === "prompted") counts.working++;
      heads.set(run.head_terminal, counts);
    }
  }
  return { workers, heads, observers };
}

export function isHidden(agent, index) {
  return Boolean(agent?.labels?.["hub.observer"]) || index.observers.has(agent?.address) || index.observers.has(agent?.terminal) || index.workers.has(agent?.address) || index.workers.has(agent?.terminal);
}

export function headSuffix(address, index) {
  const counts = index.heads.get(address);
  return counts?.total ? ` · ${counts.total} worker${counts.total === 1 ? "" : "s"}${counts.working ? ` (${counts.working} working)` : ""}` : "";
}

export function freshPanes(value, now = Date.now()) {
  const at = typeof value?.at === 'number' ? value.at : Date.parse(value?.at);
  return Number.isFinite(at) && now - at >= 0 && now - at < 10000 ? value : null;
}
export function indexSignature(index) {
  return JSON.stringify([ [...index.workers].sort(), [...index.heads].sort(), [...index.observers].sort() ]);
}
