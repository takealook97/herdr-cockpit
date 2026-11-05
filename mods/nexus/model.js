// Pure helpers for the nexus dialog; the helper CLI contract lives in the herdr-hud nexus subcommand.
export const REPORT_LIMIT = 80;
export const DOT_COUNT = 5;
export const HINT_LIMIT = 100, HINT_NAME_LIMIT = 64;
const DOT_BASE = 4, DOT_RANGE = 14;

const basename = path => String(path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
const reportText = report => {
  const text = typeof report === "string" ? report : report?.text;
  const flat = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return flat.length > REPORT_LIMIT ? flat.slice(0, REPORT_LIMIT) : flat;
};

export function buildRoster(heads = [], panes = [], terminals = []) {
  const paneOf = new Map(panes.filter(p => p?.terminal).map(p => [p.terminal, p]));
  const termOf = new Map(terminals.filter(t => t?.address).map(t => [t.address, t]));
  return heads.filter(head => head?.address && !String(head.address).includes("/")).map(head => {
    const pane = paneOf.get(head.address), term = termOf.get(head.address);
    return { address: head.address, space: head.spaceName ?? "", tab: head.tabName ?? "",
      cwd: basename(pane?.cwd ?? term?.cwd), status: pane?.status ?? head.status ?? term?.status ?? "idle",
      model: term?.model ?? head.model ?? "", report: reportText(term?.report) };
  });
}

// N9: unique space/tab names of the Heads, given to speech recognition as vocabulary hints.
export function hintsFrom(heads = []) {
  const names = heads.flatMap(head => [head?.spaceName, head?.tabName])
    .map(name => String(name ?? "").replace(/,/g, " ").trim().slice(0, HINT_NAME_LIMIT)).filter(Boolean);
  return [...new Set(names)].slice(0, HINT_LIMIT);
}

export function parseReply(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  return { action: "error", error: "helper 응답을 읽을 수 없습니다" };
}

export function dotHeights(levels = []) {
  const recent = levels.slice(-DOT_COUNT);
  const padded = [...Array(DOT_COUNT - recent.length).fill(0), ...recent];
  return padded.map(level => DOT_BASE + DOT_RANGE * Math.min(1, Math.max(0, Number(level) || 0)));
}

// exec("sh", argv) form from decision D15.
export function helperArgs(sub, opts = {}) {
  const head = ["-c", 'exec "$HOME/.local/bin/herdr-hud" "$@"', "hud", "nexus"];
  const roster = JSON.stringify(opts.roster ?? []);
  if (sub === "route") return [...head, "route", "--text", opts.text, "--roster", roster];
  if (sub === "send") return [...head, "send", "--to", opts.to, "--text", opts.text, "--roster", roster];
  if (sub === "listen") {
    const hints = opts.action === "start" && opts.hints?.length ? ["--hints", opts.hints.join(",")] : [];
    return [...head, "listen", opts.action, ...(opts.pid ? ["--pid", String(opts.pid)] : []), ...hints];
  }
  throw new Error(`unknown nexus subcommand: ${sub}`);
}

// Header mode: one dim line for the latest routed utterance (`nexus log --limit 1` entry).
export function logLine(entry) {
  if (!entry || typeof entry !== "object") return null;
  const flat = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const pick = (...values) => values.map(flat).find(Boolean) ?? "";
  switch (entry.action) {
    case "send": return { kind: "send", text: `→ ${pick(entry.label, entry.target)}` };
    case "ask": return { kind: "?", text: `? ${pick(entry.question)}` };
    case "ignore": return { kind: "ignore", text: "· 넘김" };
    case "error": return { kind: "!", text: `! ${pick(entry.error)}` };
    default: return null;
  }
}

export function logArgs() {
  return ["-c", 'exec "$HOME/.local/bin/herdr-hud" "$@"', "hud", "nexus", "log", "--limit", "1"];
}
