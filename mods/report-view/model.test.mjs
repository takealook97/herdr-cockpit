import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  headTerminal, reportArgs, openArgs, orchCommand, parseReport, timelineRows, fmtDuration, errorLine, guardedCall, statusLabel, ORCH_SCRIPT, EXEC_TIMEOUT_MS,
  parseFinal, statusColorKey, levelLabel, levelColorKey, headerModel, kpiTiles, blockRows, conclusionParagraphs,
  contrastRatio, runTimes, logStateFor, isLogOpenFor, visibleBlocks, blockLabel, MAX_BLOCK_ROWS,
} from './model.js';
import { loadView, viewWith, renderedPairs, TOKEN_PREFIX } from './mock-host.fixture.mjs';

const fixtureText = readFileSync(new URL('./fixture.json', import.meta.url), 'utf8');
const fixture = () => JSON.parse(fixtureText);

test('headTerminal prefers the hub head on the focused tab, then the focused terminal, then null', () => {
  const heads = [{ tab: 'tb1', address: 'tHead1' }, { tab: 'tb2', address: 'tHead2' }];
  assert.equal(headTerminal({ tab: 'tb2', terminal: 'tWorker' }, heads), 'tHead2');
  assert.equal(headTerminal({ tab: 'tb9', terminal: 'tWorker' }, heads), 'tWorker');
  assert.equal(headTerminal({ tab: 'tb9', terminal: 'tWorker' }, undefined), 'tWorker');
  assert.equal(headTerminal({ tab: 'tb9', terminal: null }, heads), null);
  assert.equal(headTerminal(null, null), null);
});

test('reportArgs and openArgs build orch command lines', () => {
  assert.deepEqual(reportArgs('t2h'), ['report', '--for-terminal', 't2h', '--json']);
  assert.deepEqual(reportArgs(null), ['report', '--json']);
  assert.deepEqual(openArgs('run-1'), ['report', '--run', 'run-1', '--html', '--open']);
  assert.deepEqual(orchCommand(['report', '--json']),
    ['/bin/sh', ['-c', 'o="$HOME/.local/bin/orch"; [ -x "$o" ] || o=orch; exec "$o" "$@"', 'orch', 'report', '--json']]);
});

test('parseReport accepts the D2 fixture and keeps its fields', () => {
  const data = parseReport(fixtureText);
  assert.equal(data.run.id, '20261120-101046-fe8959');
  assert.equal(data.timeline.length, 5);
  assert.equal(data.acceptance.length, 3);
  assert.match(data.markdown, /\| 이름 \|/);
});

test('parseReport defaults optional arrays and rejects missing required keys', () => {
  const { acceptance, by_key, ...rest } = fixture();
  const data = parseReport(JSON.stringify(rest));
  assert.deepEqual([data.acceptance, data.by_key], [[], []]);
  for (const mutate of [
    d => { delete d.run; }, d => { d.run.id = ''; }, d => { delete d.kpi; }, d => { delete d.kpi.retries; },
    d => { delete d.timeline; }, d => { delete d.markdown; },
  ]) {
    const broken = fixture(); mutate(broken);
    assert.throws(() => parseReport(JSON.stringify(broken)), Error);
  }
  assert.throws(() => parseReport('not json'), /JSON/);
  assert.throws(() => parseReport('[]'), Error);
});

test('timelineRows places running, zero-length and unplaced items', () => {
  const { rows, unplaced, scale } = timelineRows(fixture(), 400);
  assert.equal(unplaced, 1);
  assert.equal(scale, 1500);
  assert.equal(rows.length, 4);
  const byName = Object.fromEntries(rows.map(row => [row.label, row]));
  const running = byName['cockpit-report'];
  assert.equal(running.statusLabel, '진행 중');
  assert.deepEqual([running.outlined, running.outlineKey, running.fill], [true, 'working', null]);
  assert.ok(Math.abs(running.leftPct + running.widthPct - 100) < 1e-9);
  const done = byName['orch-report'];
  assert.deepEqual([done.fill, done.outlined, done.statusLabel], ['foreground', false, '완료']);
  assert.equal(byName['review-1'].fill, 'dim');
  assert.equal(byName['review-1'].statusLabel, '실패');
  const zero = byName['go-test'];
  assert.ok(zero.widthPct >= 3 / 400 * 100 - 1e-9, 'zero-length bar stays visible');
  assert.ok(zero.leftPct + zero.widthPct <= 100 + 1e-9);
});

test('timelineRows scales to the latest end when it exceeds wall time and handles empty input', () => {
  const data = fixture(); data.kpi.wall_seconds = 10;
  assert.equal(timelineRows(data).scale, 1020);
  assert.deepEqual(timelineRows({ timeline: [], kpi: {} }), { rows: [], unplaced: 0, scale: 1 });
  const blocked = timelineRows({ kpi: { wall_seconds: 100 }, timeline: [
    { name: 'a', status: 'blocked', start_s: 0, end_s: 50 }, { name: 'b', status: 'weird', start_s: 0, end_s: 50 }] }).rows;
  assert.equal(blocked[0].outlined, true);
  assert.deepEqual([blocked[1].statusLabel, blocked[1].fill], ['기타', 'muted']);
});

test('fmtDuration formats seconds, minutes and hours at their boundaries', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(59.6), '1m 00s');
  assert.equal(fmtDuration(200), '3m 20s');
  assert.equal(fmtDuration(3599), '59m 59s');
  assert.equal(fmtDuration(3720), '1h 02m');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(-1), '—');
});

test('errorLine keeps only the first non-empty stderr line', () => {
  assert.equal(errorLine('\norch report: no run found\nmore'), '보고서를 불러오지 못했습니다: orch report: no run found');
  assert.equal(errorLine(''), '보고서를 불러오지 못했습니다: 알 수 없는 오류');
});

test('C3: the D17 command runs $HOME/.local/bin/orch under an empty PATH and falls back to orch on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/orch'), '#!/bin/sh\necho "home:$*"\n');
  chmodSync(join(home, '.local/bin/orch'), 0o755);
  const [command, argv] = orchCommand(['report', '--json']);
  const viaHome = spawnSync(command, argv, { env: { HOME: home, PATH: '' }, encoding: 'utf8' });
  assert.equal(viaHome.status, 0);
  assert.equal(viaHome.stdout.trim(), 'home:report --json');
  const bare = mkdtempSync(join(tmpdir(), 'orch-bare-'));
  const onPath = mkdtempSync(join(tmpdir(), 'orch-path-'));
  writeFileSync(join(onPath, 'orch'), '#!/bin/sh\necho "path:$*"\n');
  chmodSync(join(onPath, 'orch'), 0o755);
  const viaPath = spawnSync('/bin/sh', argv, { env: { HOME: bare, PATH: onPath }, encoding: 'utf8' });
  assert.equal(viaPath.stdout.trim(), 'path:report --json');
  assert.equal(command, '/bin/sh');
  assert.equal(ORCH_SCRIPT.includes('$HOME/.local/bin/orch'), true);
});

test('C5: parseReport rejects wrong inner field types and statusLabel ignores prototype keys', () => {
  const bad = [
    d => { d.run = { id: 'x', status: 'bogus' }; },
    d => { d.timeline = [null]; },
    d => { d.timeline = [{ name: {}, status: 'done', start_s: 0, end_s: 1 }]; },
    d => { d.timeline = [{ name: 'a', status: 'constructor', start_s: 0, end_s: 1 }]; },
    d => { d.timeline = [{ name: 'a', status: 'done', start_s: 'x', end_s: 1 }]; },
    d => { d.timeline = [{ name: 'a', status: 'done', start_s: 0, end_s: 'y' }]; },
    d => { d.acceptance = 7; },
    d => { d.acceptance = [null]; },
    d => { d.acceptance = [{ text: 'a', state: 'maybe' }]; },
    d => { d.kpi.items = '3'; },
    d => { d.markdown = 5; },
    d => { d.run.mode = { toString: null }; },
    d => { d.run.request = 3; },
    d => { d.run.ended = 5; },
    d => { delete d.timeline[0].end_s; },
    d => { d.by_key = [{ key: 1, n: 1, seconds: 2 }]; },
    d => { d.by_key = [{ key: 'k', n: '1', seconds: 2 }]; },
    d => { d.by_key = [{ key: 'k', n: 1, seconds: Infinity }]; },
    d => { d.by_key = {}; },
  ];
  for (const mutate of bad) {
    const data = fixture(); mutate(data);
    assert.throws(() => parseReport(JSON.stringify(data)));
  }
  const ok = fixture(); ok.timeline = [{ name: 'a', kind: 'ask', key: 'k', role: 'r', status: 'running', start_s: null, end_s: null }];
  assert.equal(parseReport(JSON.stringify(ok)).timeline.length, 1);
  assert.equal(statusLabel('constructor'), '기타');
  assert.equal(statusLabel('__proto__'), '기타');
  assert.equal(statusLabel('done'), '완료');
});

test('C6: guardedCall keeps the call in flight after a timeout and cancels the timer on completion', async () => {
  const timers = [];
  const after = (ms, fn) => { const t = { ms, fn, canceled: false, cancel() { this.canceled = true; } }; timers.push(t); return t; };
  let settled = 0, resolveCall;
  const slow = new Promise(resolve => { resolveCall = resolve; });
  const first = guardedCall(slow, after, () => { settled++; });
  assert.equal(timers[0].ms, EXEC_TIMEOUT_MS);
  timers[0].fn();
  await assert.rejects(first, /시간 초과/);
  assert.equal(settled, 0, 'a timed-out call is still in flight');
  resolveCall({ code: 0 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, 1);
  const fast = guardedCall(Promise.resolve('ok'), after, () => { settled++; });
  assert.equal(await fast, 'ok');
  assert.equal(timers[1].canceled, true);
});

test('C7: bars at the right edge keep a minimum width inside the track', () => {
  const data = fixture();
  data.kpi.wall_seconds = 5;
  data.timeline = [
    { name: 'a', kind: 'ask', key: 'k', role: 'r', status: 'done', start_s: 5, end_s: 5 },
    { name: 'b', kind: 'ask', key: 'k', role: 'r', status: 'running', start_s: 5, end_s: null },
  ];
  for (const row of timelineRows(data, 400).rows) {
    assert.ok(row.widthPct > 0);
    assert.ok(row.leftPct + row.widthPct <= 100 + 1e-9);
  }
});

test('final: the fixture keeps D3 block order, kinds and shapes', () => {
  const { final } = parseReport(fixtureText);
  assert.equal(final.present, true);
  assert.deepEqual(final.blocks.map(block => block.kind), ['list', 'table', 'risks', 'checklist', 'text']);
  assert.deepEqual(final.blocks.map(block => block.title), ['한 일', '검증', '남은 위험', '확인할 것', '메모']);
  assert.equal(conclusionParagraphs(final.conclusion).length, 2);
});

test('final: a missing key from an older orch is read as "no final report"', () => {
  const { final, ...rest } = fixture();
  const data = parseReport(JSON.stringify(rest));
  assert.deepEqual(data.final, { present: false, title: '', conclusion: '', blocks: [] });
  assert.deepEqual(parseFinal(undefined).blocks, []);
});

test('final: malformed final payloads are rejected', () => {
  const block = () => ({ kind: 'list', title: 't', text: '', items: [], header: [], rows: [] });
  const bad = [
    d => { d.final = null; }, d => { d.final = []; },
    d => { d.final.present = 'yes'; }, d => { d.final.title = 1; }, d => { d.final.conclusion = null; },
    d => { d.final.blocks = {}; },
    d => { d.final.blocks = [null]; },
    d => { d.final.blocks = [{ ...block(), kind: 'chart' }]; },
    d => { d.final.blocks = [{ ...block(), title: 3 }]; },
    d => { d.final.blocks = [{ ...block(), items: 'x' }]; },
    d => { d.final.blocks = [{ ...block(), items: [{ text: 1, checked: false, level: '' }] }]; },
    d => { d.final.blocks = [{ ...block(), items: [{ text: 'a', checked: 'no', level: '' }] }]; },
    d => { d.final.blocks = [{ ...block(), items: [{ text: 'a', checked: false, level: 'urgent' }] }]; },
    d => { d.final.blocks = [{ ...block(), header: [1] }]; },
    d => { d.final.blocks = [{ ...block(), rows: ['a'] }]; },
    d => { d.final.blocks = [{ ...block(), rows: [[1]] }]; },
  ];
  for (const mutate of bad) {
    const data = fixture(); mutate(data);
    assert.throws(() => parseReport(JSON.stringify(data)), Error);
  }
});

test('blockRows: checklist marks, risk labels and colors, table padding', () => {
  const { final } = parseReport(fixtureText);
  const [list, table, risks, checklist, text] = final.blocks.map(blockRows);
  assert.equal(list.items.length, 3);
  assert.deepEqual(checklist.items.map(item => [item.mark, item.checked, item.colorKey]),
    [['☐', false, 'muted'], ['☑', true, 'done'], ['☐', false, 'muted']]);
  assert.deepEqual(risks.items.map(item => [item.label, item.colorKey]),
    [['중간', 'accent'], ['낮음', 'muted'], ['', 'muted']]);
  assert.deepEqual(table.header, ['단계', '모델', '결과']);
  assert.equal(table.rows.length, 3);
  assert.ok(table.rows.every(row => row.length === 3));
  assert.match(text.text, /자유 형식/);
  const ragged = blockRows({ kind: 'table', title: 't', text: '', items: [], header: ['a'], rows: [['1', '2', '3'], []] });
  assert.deepEqual([ragged.header, ragged.rows], [['a', '', ''], [['1', '2', '3'], ['', '', '']]]);
});

test('D6 color mapping table: status, risk level and run badge', () => {
  assert.deepEqual(['done', 'failed', 'running', 'blocked', 'partial', 'other', 'constructor'].map(statusColorKey),
    ['done', 'blocked', 'working', 'accent', 'accent', 'muted', 'muted']);
  assert.deepEqual(['high', 'medium', 'low', '', 'toString'].map(levelColorKey),
    ['blocked', 'accent', 'muted', 'muted', 'muted']);
  assert.deepEqual(['high', 'medium', 'low', '', 'toString'].map(levelLabel), ['높음', '중간', '낮음', '', '']);
  const data = parseReport(fixtureText);
  assert.deepEqual(headerModel(data).badge, { label: '진행 중', colorKey: 'working' });
  const closed = fixture(); closed.run.status = 'closed'; closed.run.ended = '2026-11-20T11:00:00+09:00';
  assert.deepEqual(headerModel(parseReport(JSON.stringify(closed))).badge, { label: '종료 · 실패 1', colorKey: 'blocked' });
  closed.kpi.failed = 0;
  assert.deepEqual(headerModel(parseReport(JSON.stringify(closed))).badge, { label: '종료', colorKey: 'done' });
});

test('headerModel falls back to the request when there is no final title; kpiTiles gives three tiles', () => {
  const data = parseReport(fixtureText);
  assert.match(headerModel(data).title, /orch run 보고서/);
  const none = fixture(); delete none.final;
  assert.equal(headerModel(parseReport(JSON.stringify(none))).title, 'Report 버튼과 report-view 추가');
  const tiles = kpiTiles(data);
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles.map(tile => tile.value), ['5', '2 / 1', '25m 00s']);
  assert.equal(tiles[2].detail, '소요 · 재시도 1 · fallback 1');
});

// Mirrors herdr-app src/settings.rs `resolve` (@ ae925b3): the colors a mod gets from `theme()`.
const hex = c => `#${c.toString(16).padStart(6, '0')}`;
const num = h => parseInt(h.slice(1, 7), 16);
const mix = (a, b, t) => [16, 8, 0].reduce((acc, s) => {
  const [x, y] = [(a >> s) & 255, (b >> s) & 255];
  return acc | (Math.round(x * (1 - t) + y * t) << s);
}, 0);
const isLight = c => 0.2126 * ((c >> 16) & 255) / 255 + 0.7152 * ((c >> 8) & 255) / 255 + 0.0722 * (c & 255) / 255 > 0.5;
function appTheme(palette, overrides = {}) {
  const bg = num(palette.background);
  const light = isLight(bg);
  const fg = light ? 0x1b1b1e : 0xeeeeef;
  const base = {
    foreground: hex(fg), surface: hex(bg),
    chrome: hex(light ? mix(bg, 0xe8e8e2, 0.6) : mix(bg, 0, 0.32)),
    raised: hex(light ? mix(bg, 0, 0.035) : mix(bg, 0xffffff, 0.09)),
    muted: hex(mix(bg, fg, light ? 0.66 : 0.6)), dim: hex(mix(bg, fg, light ? 0.46 : 0.38)),
  };
  return { ...base, ...overrides };
}
// Palettes copied from herdr-app defaults/themes/{win98,atom-one-dark}.json.
const THEMES = {
  win98: appTheme({ background: '#ffffff' }, {
    foreground: '#000000', surface: '#c0c0c0', raised: '#dfdfdf', muted: '#404040', dim: '#808080',
    accent: '#000080', working: '#808000', blocked: '#ff0000', done: '#0000ff',
  }),
  // Dark presets take working/blocked/done/accent from ansi 3, 1, 4, 4 (settings.rs resolve).
  'atom-one-dark': appTheme({ background: '#21252b' }, { accent: '#61afef', working: '#e5c07b', blocked: '#e06c75', done: '#61afef' }),
};

test('K7: text pairs the view draws reach 4.5:1 on the real win98 and atom-one-dark theme values', () => {
  assert.equal(THEMES['atom-one-dark'].raised, '#35393e');
  assert.equal(THEMES['atom-one-dark'].muted, '#9c9ea1');
  for (const [name, c] of Object.entries(THEMES)) {
    // foreground: titles, conclusion label and notice (raised), card text. muted: meta on chrome, labels on surface.
    for (const [fg, bg] of [['foreground', 'chrome'], ['foreground', 'surface'], ['foreground', 'raised'], ['muted', 'chrome'], ['muted', 'surface']]) {
      const ratio = contrastRatio(c[fg], c[bg]);
      assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  }
  assert.ok(contrastRatio(THEMES['atom-one-dark'].muted, THEMES['atom-one-dark'].raised) < 4.5, 'muted on raised is why the conclusion uses foreground');
  assert.ok(contrastRatio('#000000', '#ffffff') > 20.9);
});

test('K2: the run-log choice resets when the run id changes', () => {
  let state = logStateFor(null, 'A');
  assert.equal(isLogOpenFor(state, 'A', true), false);
  state = { runId: 'A', open: true };
  assert.equal(isLogOpenFor(state, 'A', true), true);
  assert.equal(isLogOpenFor(state, 'B', true), false, 'B starts collapsed');
  assert.deepEqual(logStateFor(state, 'B'), { runId: 'B', open: null });
  assert.equal(isLogOpenFor(logStateFor(state, 'C'), 'C', false), true, 'C has no final report: open');
  assert.equal(isLogOpenFor({ runId: 'A', open: false }, 'A', false), false, 'an explicit choice for the same run stays');
});

test('K3: a 150,000-row table renders without throwing and caps at 200 rows plus a "more" count', () => {
  const rows = Array.from({ length: 150000 }, (_, i) => [`r${i}`, 'x']);
  const out = blockRows({ kind: 'table', title: 't', text: '', items: [], header: ['a', 'b'], rows });
  assert.equal(out.rows.length, MAX_BLOCK_ROWS);
  assert.equal(out.more, 150000 - 200);
  assert.equal(out.label, '표 150000행');
  const items = Array.from({ length: 201 }, (_, i) => ({ text: `i${i}`, checked: false, level: '' }));
  const list = blockRows({ kind: 'list', title: 't', text: '', items, header: [], rows: [] });
  assert.deepEqual([list.items.length, list.more], [200, 1]);
});

test('K4: the header meta shows the start date/time and the end time, and changes with created/ended', () => {
  const run = { created: '2026-11-20T10:10:00', ended: '2026-11-20T10:58:00' };
  assert.equal(runTimes(run), '11월 20일 10:10–10:58');
  assert.equal(runTimes({ created: '2026-11-20T10:10:00', ended: null }), '11월 20일 10:10');
  assert.equal(runTimes({ created: '2026-01-02T09:05:00', ended: null }), '1월 2일 09:05');
  assert.equal(runTimes({ created: 'bogus', ended: null }), '');
  const a = fixture(); a.run.created = '2026-11-20T10:10:00';
  const b = fixture(); b.run.created = '2026-11-21T12:30:00';
  const metaA = headerModel(parseReport(JSON.stringify(a))).meta;
  const metaB = headerModel(parseReport(JSON.stringify(b))).meta;
  assert.notEqual(metaA, metaB);
  assert.match(metaA, /11월 20일 10:10/);
});

test('K5: present:false hides the blocks', () => {
  const data = fixture();
  data.final.present = false;
  const final = parseReport(JSON.stringify(data)).final;
  assert.ok(final.blocks.length > 0);
  assert.deepEqual(visibleBlocks(final), []);
  assert.equal(visibleBlocks(parseReport(fixtureText).final).length, 5);
});

test('D13: card header labels per kind', () => {
  const item = (checked, level = '') => ({ text: 'x', checked, level });
  const mk = (kind, items = [], rows = []) => ({ kind, title: 't', text: '', items, header: [], rows });
  assert.equal(blockLabel(mk('list', [item(false), item(false)])), '목록 2개');
  assert.equal(blockLabel(mk('checklist', [item(true), item(false), item(true)])), '확인 3개 중 2개 완료');
  assert.equal(blockLabel(mk('risks', [item(false, 'high'), item(false, 'low'), item(false, 'high'), item(false, '')])), '위험 높음 2 · 낮음 1');
  assert.equal(blockLabel(mk('risks', [item(false, 'medium')])), '위험 중간 1');
  assert.equal(blockLabel(mk('table', [], [['a'], ['b']])), '표 2행');
  assert.equal(blockLabel(mk('text')), '');
});

test('K8: table width comes from the drawn header and rows, not from hidden rows', () => {
  const rows = Array.from({ length: 200 }, (_, i) => [`r${i}`]);
  rows.push(Array.from({ length: 1000 }, (_, i) => `c${i}`));
  const out = blockRows({ kind: 'table', title: 't', text: '', items: [], header: ['a'], rows });
  assert.equal(out.rows.length, 200);
  assert.equal(out.more, 1);
  assert.equal(out.header.length, 1);
  assert.ok(out.rows.every(row => row.length === 1));
  const cells = out.header.length + out.rows.reduce((n, row) => n + row.length, 0);
  assert.equal(cells, 201);
  const ragged = blockRows({ kind: 'table', title: 't', text: '', items: [], header: ['a'], rows: [['x', 'y', 'z']] });
  assert.deepEqual(ragged.rows[0], ['x', 'y', 'z']);
  assert.deepEqual(ragged.header, ['a', '', '']);
});

// T2: the pairs come from what the mock host saw the view draw, not from a hand-picked list.
const LARGE_BOLD_PX = 18;
const resolveToken = (theme, value) => theme[String(value).slice(TOKEN_PREFIX.length)];
// Translucent tokens (border, hover) have no single color to compare; they only draw tracks and hover washes.
const TRANSLUCENT = new Set([`${TOKEN_PREFIX}border`, `${TOKEN_PREFIX}hover`]);

// Default state (final present: progress collapsed; no final: progress open) and the opened state, for each data variant.
const VARIANTS = [
  d => d,
  d => { d.run.status = 'active'; delete d.final; return d; },
  d => { d.kpi.failed = 2; return d; },
];

async function renderedTrees() {
  const { ReportView, parseReport } = await loadView();
  const trees = [];
  for (const variant of VARIANTS) {
    for (const forceOpen of [false, true]) {
      const view = viewWith(ReportView, parseReport(JSON.stringify(variant(fixture()))));
      if (forceOpen) view.logState = { runId: view.data.run.id, open: true };
      trees.push(view.render());
    }
  }
  return trees;
}

const isDrawn = pair => !TRANSLUCENT.has(pair.bg) && !TRANSLUCENT.has(pair.fg);

function contrastFailures(pairs) {
  const failures = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const pair of pairs.filter(isDrawn)) {
      const ratio = contrastRatio(resolveToken(theme, pair.fg), resolveToken(theme, pair.bg));
      const need = pair.kind === 'dot' || (pair.bold && pair.size >= LARGE_BOLD_PX) ? 3 : 4.5;
      if (ratio < need) failures.push(`${name} ${pair.kind} ${pair.fg} on ${pair.bg} "${pair.text ?? ''}" = ${ratio.toFixed(2)} < ${need}`);
    }
  }
  return [...new Set(failures)];
}

test('T2: contrast of the token pairs the view actually draws, collapsed and opened, on win98 and atom-one-dark (text 4.5:1, large bold 3:1, dots 3:1)', async () => {
  const pairs = (await renderedTrees()).flatMap(renderedPairs).filter(isDrawn);
  const texts = pairs.filter(pair => pair.kind === 'text');
  const dots = pairs.filter(pair => pair.kind === 'dot');
  assert.ok(texts.length > 20 && dots.length > 0, `recorded ${texts.length} text pairs, ${dots.length} dots`);
  for (const pair of pairs) {
    assert.ok(String(pair.fg).startsWith(TOKEN_PREFIX) && String(pair.bg).startsWith(TOKEN_PREFIX), `explicit tokens: ${JSON.stringify(pair)}`);
  }
  const seen = new Set(pairs.map(pair => `${pair.kind}:${pair.fg}/${pair.bg}`));
  for (const expected of ['text:token:foreground/token:raised', 'text:token:muted/token:surface', 'dot:token:accent/token:surface', 'dot:token:working/token:chrome']) {
    assert.ok(seen.has(expected), `view draws ${expected}; saw ${[...seen].join(', ')}`);
  }
  const arrows = new Set(texts.filter(pair => pair.text === '▸' || pair.text === '▾').map(pair => pair.text));
  assert.deepEqual([...arrows].sort(), ['▸', '▾'], 'both the collapsed and the opened arrow are checked');
  assert.deepEqual(contrastFailures(pairs), []);
});

test('T2: the default state of a report with a final text is the collapsed row, and its arrow pair is part of the check', async () => {
  const { ReportView, parseReport } = await loadView();
  const view = viewWith(ReportView, parseReport(JSON.stringify(fixture())));
  assert.equal(view.isLogOpen(), false);
  const arrow = renderedPairs(view.render()).find(pair => pair.text === '▸');
  assert.deepEqual([arrow?.fg, arrow?.bg], [`${TOKEN_PREFIX}muted`, `${TOKEN_PREFIX}chrome`]);
});

test('T2 negative: a collapsed arrow drawn in the chrome color on chrome is reported on both themes', async () => {
  const { ReportView, parseReport } = await loadView();
  const view = viewWith(ReportView, parseReport(JSON.stringify(fixture())));
  const tree = view.render();
  assert.deepEqual(contrastFailures(renderedPairs(tree)), [], 'the real default render passes');
  const flatten = el => [el, ...el.parts.flatMap(part => (part && typeof part === 'object' ? flatten(part) : []))];
  const arrow = flatten(tree).find(el => el.parts.includes('▸'));
  assert.ok(arrow, 'collapsed arrow element found');
  arrow.style.text_color = `${TOKEN_PREFIX}chrome`;
  const failures = contrastFailures(renderedPairs(tree));
  assert.equal(failures.length, Object.keys(THEMES).length, failures.join('\n'));
  assert.ok(failures.every(line => line.includes('"▸" = 1.00')), failures.join('\n'));
});
