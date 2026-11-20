// Pure logic for the report-view mod. No Herdr or gpui imports, so node can test it.

export const REFRESH_MS = 5000;
export const EXEC_TIMEOUT_MS = 10000;
const MIN_BAR_PX = 3;

export const STATUS_LABELS = {
  done: '완료', failed: '실패', blocked: '막힘', partial: '부분', running: '진행 중', other: '기타',
};
export const ACCEPTANCE_LABELS = { met: '충족', unmet: '미충족', unrecorded: '기록 없음' };

// D8: the Head terminal is the hub head whose tab is focused, else the focused terminal.
export function headTerminal(focused, heads) {
  const match = Array.isArray(heads) && focused?.tab != null
    ? heads.find(head => head?.tab === focused.tab && head?.address)
    : null;
  return match?.address ?? focused?.terminal ?? null;
}

export const reportArgs = terminal => terminal
  ? ['report', '--for-terminal', terminal, '--json']
  : ['report', '--json'];

export const openArgs = runId => ['report', '--run', runId, '--html', '--open'];

// D17: prefer $HOME/.local/bin/orch (same place as herdr-hud) and fall back to PATH, so a bare mod-host PATH still works.
export const ORCH_SCRIPT = 'o="$HOME/.local/bin/orch"; [ -x "$o" ] || o=orch; exec "$o" "$@"';
export const SHELL = '/bin/sh';
export const orchCommand = args => [SHELL, ['-c', ORCH_SCRIPT, 'orch', ...args]];

// exec() has no timeout option (the host stops it at 30 s), so the view races EXEC_TIMEOUT_MS itself.
// `onSettled` fires only when the call itself finishes, so a timed-out call still counts as in flight.
// The timer is cancelled as soon as the race ends.
export function guardedCall(call, after, onSettled, ms = EXEC_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = after(ms, () => reject(new Error('시간 초과')));
  });
  Promise.resolve(call).then(onSettled, onSettled);
  return Promise.race([call, timeout]).finally(() => timer?.cancel?.());
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const KPI_KEYS = ['items', 'done', 'failed', 'other', 'wall_seconds', 'work_seconds', 'retries', 'fallbacks'];
const RUN_STRING_KEYS = ['mode', 'head_terminal', 'created', 'request'];
const RUN_STATUSES = ['active', 'closed'];
const ITEM_STATUSES = Object.keys(STATUS_LABELS);
const ACCEPTANCE_STATES = Object.keys(ACCEPTANCE_LABELS);
const isNumberOrNull = value => value === null || Number.isFinite(value);
const isString = value => typeof value === 'string';
const isFiniteNumber = value => Number.isFinite(value);
const fail = reason => { throw new Error(reason); };

function checkTimelineItem(item, index) {
  if (!isObject(item)) fail(`timeline[${index}] 가 객체가 아닙니다`);
  if (typeof item.name !== 'string') fail(`timeline[${index}].name 이 문자열이 아닙니다`);
  if (!ITEM_STATUSES.includes(item.status)) fail(`timeline[${index}].status 가 올바르지 않습니다`);
  if (!('end_s' in item)) fail(`timeline[${index}].end_s 가 없습니다`);
  if (!isNumberOrNull(item.start_s) || !isNumberOrNull(item.end_s)) fail(`timeline[${index}] 시각이 숫자가 아닙니다`);
}

export const BLOCK_KINDS = ['list', 'checklist', 'risks', 'table', 'text'];
const RISK_LEVELS = ['high', 'medium', 'low', ''];
export const EMPTY_FINAL = Object.freeze({ present: false, title: '', conclusion: '', blocks: [] });

function checkItem(item, where) {
  if (!isObject(item)) fail(`${where} 가 객체가 아닙니다`);
  if (!isString(item.text)) fail(`${where}.text 가 문자열이 아닙니다`);
  if (typeof item.checked !== 'boolean') fail(`${where}.checked 가 불리언이 아닙니다`);
  if (!RISK_LEVELS.includes(item.level)) fail(`${where}.level 이 올바르지 않습니다`);
}

function checkBlock(block, index) {
  const where = `final.blocks[${index}]`;
  if (!isObject(block)) fail(`${where} 가 객체가 아닙니다`);
  if (!BLOCK_KINDS.includes(block.kind)) fail(`${where}.kind 가 올바르지 않습니다`);
  if (!isString(block.title) || !isString(block.text)) fail(`${where} 의 title/text 가 문자열이 아닙니다`);
  if (!Array.isArray(block.items)) fail(`${where}.items 가 배열이 아닙니다`);
  block.items.forEach((item, i) => checkItem(item, `${where}.items[${i}]`));
  if (!Array.isArray(block.header) || !block.header.every(isString)) fail(`${where}.header 가 문자열 배열이 아닙니다`);
  if (!Array.isArray(block.rows) || !block.rows.every(row => Array.isArray(row) && row.every(isString))) {
    fail(`${where}.rows 가 문자열 배열의 배열이 아닙니다`);
  }
}

// D2 `final`. A missing key (older orch) is the same as "no final report"; a malformed one is rejected.
export function parseFinal(raw) {
  if (raw === undefined) return EMPTY_FINAL;
  if (!isObject(raw)) fail('final 이 객체가 아닙니다');
  if (typeof raw.present !== 'boolean') fail('final.present 가 불리언이 아닙니다');
  if (!isString(raw.title) || !isString(raw.conclusion)) fail('final.title/conclusion 이 문자열이 아닙니다');
  if (!Array.isArray(raw.blocks)) fail('final.blocks 가 배열이 아닙니다');
  raw.blocks.forEach(checkBlock);
  return raw;
}

// Validates the D2 shape, including inner field types. Throws an Error with a short reason on the first problem.
export function parseReport(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('JSON 형식이 아닙니다');
  }
  if (!isObject(data)) fail('보고서가 객체가 아닙니다');
  if (!isObject(data.run) || typeof data.run.id !== 'string' || !data.run.id) fail('run.id 가 없습니다');
  if (!RUN_STATUSES.includes(data.run.status)) fail('run.status 가 올바르지 않습니다');
  for (const key of RUN_STRING_KEYS) {
    if (!isString(data.run[key])) fail(`run.${key} 가 문자열이 아닙니다`);
  }
  if (data.run.ended !== null && !isString(data.run.ended)) fail('run.ended 가 올바르지 않습니다');
  if (!isObject(data.kpi)) fail('kpi 가 없습니다');
  for (const key of KPI_KEYS) {
    if (!Number.isFinite(data.kpi[key])) fail(`kpi.${key} 가 없습니다`);
  }
  if (!Array.isArray(data.timeline)) fail('timeline 이 없습니다');
  data.timeline.forEach(checkTimelineItem);
  if (data.acceptance !== undefined) {
    if (!Array.isArray(data.acceptance)) fail('acceptance 가 배열이 아닙니다');
    data.acceptance.forEach((item, index) => {
      if (!isObject(item) || typeof item.text !== 'string' || !ACCEPTANCE_STATES.includes(item.state)) fail(`acceptance[${index}] 가 올바르지 않습니다`);
    });
  }
  if (data.by_key !== undefined) {
    if (!Array.isArray(data.by_key)) fail('by_key 가 배열이 아닙니다');
    data.by_key.forEach((item, index) => {
      if (!isObject(item) || !isString(item.key) || !isFiniteNumber(item.n) || !isFiniteNumber(item.seconds)) fail(`by_key[${index}] 가 올바르지 않습니다`);
    });
  }
  if (typeof data.markdown !== 'string') fail('markdown 이 없습니다');
  return {
    ...data,
    acceptance: data.acceptance ?? [],
    by_key: data.by_key ?? [],
    final: parseFinal(data.final),
  };
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

export const statusLabel = status => Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : STATUS_LABELS.other;

// Style roles map to theme tokens in the view: fill, track, outline. `outlineKey` names the outline color.
// Only registered builder methods are used (no dashed borders): running is told apart by the working color.
function barStyle(status) {
  if (status === 'done') return { fill: 'foreground', outlined: false, outlineKey: null };
  if (status === 'failed') return { fill: 'dim', outlined: false, outlineKey: null };
  if (status === 'blocked' || status === 'partial') return { fill: null, outlined: true, outlineKey: 'foreground' };
  if (status === 'running') return { fill: null, outlined: true, outlineKey: 'working' };
  return { fill: 'muted', outlined: false, outlineKey: null };
}

// Bars span the larger of wall time and the latest known end; running items reach the right edge.
export function timelineRows(data, widthPx = 400) {
  const items = Array.isArray(data?.timeline) ? data.timeline : [];
  const wall = Number.isFinite(data?.kpi?.wall_seconds) ? data.kpi.wall_seconds : 0;
  const placed = items.filter(item => Number.isFinite(item?.start_s));
  const scale = Math.max(wall, 1, ...placed.map(item => Number.isFinite(item.end_s) ? item.end_s : item.start_s));
  const minPct = widthPx > 0 ? Math.min(100, MIN_BAR_PX / widthPx * 100) : 0.5;
  const rows = placed.map(item => {
    const start = Math.min(Math.max(item.start_s, 0), scale);
    const running = !Number.isFinite(item.end_s);
    const end = running ? scale : Math.min(Math.max(item.end_s, start), scale);
    // A bar at the right edge keeps its minimum width by moving left instead of being clipped to zero.
    const widthPct = Math.max(minPct, (end - start) / scale * 100);
    const leftPct = Math.min(start / scale * 100, 100 - Math.min(widthPct, minPct));
    return {
      label: item.name ?? '',
      kind: item.kind ?? '',
      status: item.status ?? 'other',
      statusLabel: statusLabel(item.status),
      durationLabel: fmtDuration(end - start),
      leftPct,
      widthPct,
      ...barStyle(item.status),
    };
  });
  return { rows, unplaced: items.length - placed.length, scale };
}

export function errorLine(message) {
  const first = String(message ?? '').split('\n').find(line => line.trim()) ?? '알 수 없는 오류';
  return `보고서를 불러오지 못했습니다: ${first.trim()}`;
}

// D6: status and risk level -> theme color name. Warn states (blocked/partial) borrow the accent like a medium risk.
const STATUS_COLOR_KEYS = {
  done: 'done', failed: 'blocked', running: 'working', blocked: 'accent', partial: 'accent', other: 'muted',
};
export const statusColorKey = status => Object.hasOwn(STATUS_COLOR_KEYS, status) ? STATUS_COLOR_KEYS[status] : 'muted';

const LEVEL_LABELS = { high: '높음', medium: '중간', low: '낮음' };
const LEVEL_COLOR_KEYS = { high: 'blocked', medium: 'accent', low: 'muted' };
export const levelLabel = level => Object.hasOwn(LEVEL_LABELS, level) ? LEVEL_LABELS[level] : '';
export const levelColorKey = level => Object.hasOwn(LEVEL_COLOR_KEYS, level) ? LEVEL_COLOR_KEYS[level] : 'muted';

const pad2 = n => String(n).padStart(2, '0');
const clock = date => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

// K4: `11월 20일 10:10` for the start (local time) plus `–10:58` when the run has ended. Unparseable input yields ''.
export function runTimes(run) {
  const start = new Date(run.created);
  if (!run.created || Number.isNaN(start.getTime())) return '';
  const end = run.ended ? new Date(run.ended) : null;
  const endText = end && !Number.isNaN(end.getTime()) ? `–${clock(end)}` : '';
  return `${start.getMonth() + 1}월 ${start.getDate()}일 ${clock(start)}${endText}`;
}

// K2: the run-log toggle belongs to one run. A different run id drops the user's choice back to the default.
export const logStateFor = (state, runId) => state?.runId === runId ? state : { runId, open: null };
export const isLogOpenFor = (state, runId, finalPresent) => {
  const current = logStateFor(state, runId);
  return current.open ?? !finalPresent;
};

// K5: with present:false the blocks are contradictory data and are not drawn.
export const visibleBlocks = final => final?.present ? final.blocks : [];

// D14: WCAG relative luminance and contrast ratio for #rrggbb colors.
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Run state badge: an active run is working, a closed one is done unless something failed.
export function headerModel(data) {
  const run = data.run;
  const failed = data.kpi.failed;
  const active = run.status === 'active';
  const badge = active
    ? { label: '진행 중', colorKey: 'working' }
    : failed > 0 ? { label: `종료 · 실패 ${failed}`, colorKey: 'blocked' } : { label: '종료', colorKey: 'done' };
  const meta = [run.id, runTimes(run), run.mode, fmtDuration(data.kpi.wall_seconds), `작업 ${data.kpi.items}개`]
    .filter(Boolean).join(' · ');
  const title = data.final?.present && data.final.title ? data.final.title : (run.request || 'run 보고서');
  return { title, badge, meta, stripeColorKey: badge.colorKey };
}

export function kpiTiles(data) {
  const { kpi } = data;
  return [
    { label: '작업 수', value: String(kpi.items), detail: '', colorKey: 'foreground' },
    { label: '완료 / 실패', value: `${kpi.done} / ${kpi.failed}`, detail: kpi.other > 0 ? `기타 ${kpi.other}` : '',
      colorKey: kpi.failed > 0 ? 'blocked' : 'done' },
    { label: '소요 / 재시도', value: fmtDuration(kpi.wall_seconds), detail: ['소요', kpi.retries > 0 && `재시도 ${kpi.retries}`, kpi.fallbacks > 0 && `fallback ${kpi.fallbacks}`]
        .filter(Boolean).join(' · '),
      colorKey: 'foreground' },
  ];
}

// K3: a block draws at most MAX_BLOCK_ROWS rows; the rest is one "… n개 더" line.
export const MAX_BLOCK_ROWS = 200;
const capRows = rows => ({ rows: rows.slice(0, MAX_BLOCK_ROWS), more: Math.max(0, rows.length - MAX_BLOCK_ROWS) });

function riskCounts(items) {
  return ['high', 'medium', 'low']
    .map(level => [level, items.filter(item => item.level === level).length])
    .filter(([, n]) => n > 0)
    .map(([level, n]) => `${levelLabel(level)} ${n}`).join(' · ');
}

// D13: the small label in a card header.
export function blockLabel(block) {
  if (block.kind === 'list') return `목록 ${block.items.length}개`;
  if (block.kind === 'checklist') {
    return `확인 ${block.items.length}개 중 ${block.items.filter(item => item.checked).length}개 완료`;
  }
  if (block.kind === 'risks') return `위험 ${riskCounts(block.items)}`.trim();
  if (block.kind === 'table') return `표 ${block.rows.length}행`;
  return '';
}

// Rows for one final block, shaped for the view. Table rows are padded to the widest drawn row so the grid stays square.
export function blockRows(block) {
  const base = { kind: block.kind, title: block.title, text: block.text, label: blockLabel(block), items: [], header: [], rows: [], more: 0 };
  if (block.kind === 'list' || block.kind === 'checklist' || block.kind === 'risks') {
    const { rows, more } = capRows(block.items);
    const shape = {
      list: item => ({ text: item.text }),
      checklist: item => ({ text: item.text, checked: item.checked, mark: item.checked ? '☑' : '☐', colorKey: item.checked ? 'done' : 'muted' }),
      risks: item => ({ text: item.text, level: item.level, label: levelLabel(item.level), colorKey: levelColorKey(item.level) }),
    }[block.kind];
    return { ...base, items: rows.map(shape), more };
  }
  if (block.kind === 'table') {
    // K8: the column count comes from the header and the rows that are drawn, never from hidden rows.
    const { rows, more } = capRows(block.rows);
    let width = block.header.length;
    for (const row of rows) width = Math.max(width, row.length);
    const pad = cells => Array.from({ length: width }, (_, i) => cells[i] ?? '');
    return { ...base, header: pad(block.header), rows: rows.map(pad), more };
  }
  return base;
}

export const conclusionParagraphs = conclusion => conclusion.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
