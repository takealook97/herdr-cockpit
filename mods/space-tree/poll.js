export const HUD_EXEC_TIMEOUT_MS = 8000;
export const POLL_STALE_MS = 20000;

export function withTimeout(promise, ms, sleep) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error("timeout"); }),
  ]);
}

export function createPollGate({ now = Date.now, staleMs = POLL_STALE_MS } = {}) {
  let token = null, startedAt = 0;
  return {
    begin() {
      const at = now();
      if (token && at - startedAt < staleMs) return null;
      token = {};
      startedAt = at;
      return token;
    },
    isCurrent(candidate) { return token !== null && candidate === token; },
    end(candidate) { if (candidate === token) token = null; },
  };
}

const REASON_MAX = 80;

export function pollFailureReason(error) {
  const text = String(error?.message ?? error).replace(/\s+/g, " ").trim() || "unknown";
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX) + "…" : text;
}

export function summarizePollFailures(names, failures) {
  return names.filter(name => failures.has(name))
    .map(name => `${name ?? "local"}: ${failures.get(name)}`).join("; ");
}
