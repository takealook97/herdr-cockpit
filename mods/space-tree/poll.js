export const HUD_EXEC_TIMEOUT_MS = 8000;
export const HUD_INFLIGHT_MAX_MS = 45000;
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
