// Pure helpers for the nexus dialog; the helper CLI contract lives in the herdr-hud nexus subcommand.
export const REPORT_LIMIT = 80;
export const DOT_COUNT = 5;
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

// Log entries -> display lines: the typed text, then the outcome of that command.
export function logLines(entries = []) {
  return entries.flatMap(entry => {
    const lines = [];
    if (entry.text) lines.push({ kind: ">", text: entry.text });
    if (entry.action === "send") lines.push({ kind: "→", text: entry.label || entry.target || "" });
    else if (entry.action === "ask") lines.push({ kind: "?", text: entry.question || "" });
    else if (entry.action === "read") lines.push({ kind: "·", text: entry.summary || "" });
    else if (entry.action === "error" || entry.error) lines.push({ kind: "!", text: entry.error || "" });
    return lines;
  });
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
  if (sub === "log") return [...head, "log", "--limit", String(opts.limit ?? 6)];
  if (sub === "listen") return [...head, "listen", opts.action];
  throw new Error(`unknown nexus subcommand: ${sub}`);
}
