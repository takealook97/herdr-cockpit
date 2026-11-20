import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HOST_METHODS, FORBIDDEN_METHODS,
} from './herdr-registry.fixture.mjs';
import {
  REGISTERED, usedMethods, loadView, viewWith, fireClicks, fireClicksSettled, renderedPairs,
} from './mock-host.fixture.mjs';

const here = file => new URL(file, import.meta.url);
const mainSource = readFileSync(here('./main.js'), 'utf8');
const fixtureText = readFileSync(here('./fixture.json'), 'utf8');

// Methods the view defines on itself (`  name(args) {`) are not builder calls.
const ownMethods = new Set([...mainSource.matchAll(/^ {2}(?:async )?([a-z][A-Za-z0-9]*)\(/gm)].map(match => match[1]));
const jsBuiltins = new Set(['map', 'push', 'trim', 'split', 'now', 'forEach', 'find', 'filter', 'includes', 'slice', 'join']);
const unregistered = source => [...usedMethods(source)]
  .filter(name => !REGISTERED.has(name) && !HOST_METHODS.includes(name) && !ownMethods.has(name) && !jsBuiltins.has(name));

test('K6/T1: every method main.js calls, dotted or bracketed, is registered in the Herdr JS builder (style.rs / typings.rs @ fdbbe92)', () => {
  assert.deepEqual(unregistered(mainSource), []);
  const used = usedMethods(mainSource);
  for (const name of FORBIDDEN_METHODS) assert.equal(used.has(name), false, `${name} must not be called`);
  assert.equal(/from 'gpui/.test(readFileSync(here('./model.js'), 'utf8')), false, 'model.js builds no elements');
});

test('T1 negative: the registry check catches an unregistered method in dotted and bracketed calls', () => {
  assert.deepEqual(unregistered("div().border_dashed()"), ['border_dashed']);
  assert.deepEqual(unregistered("div()['border_dashed']()"), ['border_dashed']);
  assert.deepEqual(unregistered('div()["border_dashed"]()'), ['border_dashed']);
  assert.deepEqual(unregistered("div().bg(x)['px'](2)"), []);
});

test('T1 negative: the mock host runs hover and click callbacks, so an unregistered call inside one throws', async () => {
  const { harness } = await loadView();
  const bad = new harness.Element('div');
  assert.throws(() => bad.hover(s => s.border_dashed()), TypeError, 'hover callback is executed');
  assert.throws(() => harness.div().hover(s => s['border_dashed']()), TypeError, 'bracketed call inside hover');
  assert.doesNotThrow(() => harness.div().hover(s => s.bg('x')));
  const clicking = harness.div().on_click(() => harness.div().border_dashed());
  assert.throws(() => fireClicks(clicking), TypeError, 'click handlers are fired by fireClicks');
});

const flatten = el => [el, ...el.parts.flatMap(part => (part && typeof part === 'object' ? flatten(part) : [part]))];
const textsOf = root => flatten(root).filter(part => typeof part === 'string');
const hasTimeline = texts => texts.some(text => text.startsWith('타임라인'));
const markdownOf = root => flatten(root).filter(part => part?.kind === 'markdown');

async function renderCase({ final = true, active = false, logState = null } = {}) {
  const { ReportView, parseReport, harness } = await loadView();
  const data = JSON.parse(fixtureText);
  if (!final) delete data.final;
  if (active) data.run.status = 'active';
  const view = viewWith(ReportView, parseReport(JSON.stringify(data)), logState);
  return { view, tree: view.render(), harness, data };
}

test('K6: rendering a running run without a final report (progress open by default) throws nothing', async () => {
  const { view, tree } = await renderCase({ final: false, active: true });
  assert.equal(view.isLogOpen(), true);
  const texts = textsOf(tree);
  assert.ok(hasTimeline(texts), 'timeline drawn');
  assert.doesNotThrow(() => fireClicks(tree));
  const withFinal = await renderCase();
  withFinal.view.logState = { runId: withFinal.view.data.run.id, open: true };
  assert.doesNotThrow(() => withFinal.view.render());
});

test('D7: the run-log markdown is gone; the collapsed row is "진행 ▸" and opens to the timeline only', async () => {
  const collapsed = await renderCase();
  assert.equal(collapsed.view.isLogOpen(), false);
  let texts = textsOf(collapsed.tree);
  assert.ok(texts.includes('진행') && texts.includes('▸'));
  assert.equal(texts.includes('실행 기록'), false);
  assert.equal(hasTimeline(texts), false, 'timeline hidden while collapsed');
  assert.equal(markdownOf(collapsed.tree).length > 0, true, 'final text blocks still render');

  const open = await renderCase();
  open.view.logState = { runId: open.view.data.run.id, open: true };
  const tree = open.view.render();
  texts = textsOf(tree);
  assert.ok(texts.includes('▾') && hasTimeline(texts));
  assert.ok(fixtureText.includes('## 작업'), 'fixture still carries data.markdown in JSON');
  assert.equal(texts.some(text => text.includes('| 이름 | 종류 |')), false);
  assert.equal(/data\.markdown/.test(mainSource), false, 'main.js never reads data.markdown');
});

test('D7: without a final report the notice, KPI row and an open progress timeline are shown', async () => {
  const { tree } = await renderCase({ final: false });
  const texts = textsOf(tree);
  assert.ok(texts.some(text => text.startsWith('Head 최종 보고 없음')));
  assert.ok(texts.includes('작업 수') && texts.includes('완료 / 실패'));
  assert.ok(texts.includes('▾') && hasTimeline(texts));
  assert.equal(texts.includes('실행 기록'), false);
});

test('T1: click handlers of the rendered view run to the end, including the async open-in-browser task, without an unregistered call', async () => {
  for (const options of [{}, { final: false, active: true }]) {
    const { view, tree } = await renderCase(options);
    assert.deepEqual(await fireClicksSettled(tree), []);
    assert.match(view.openError ?? '', /브라우저에서 열지 못했습니다/, 'the spawned task body ran to its catch (mock exec has no orch)');
    assert.ok(renderedPairs(tree).length > 0);
  }
});

// The review's repro: a spaced bracketed call placed in the open-in-browser task, before its try block.
const spawnHead = /(cx\.spawn\(async cx => \{\s*)(try \{\s*await runOrch\(openArgs)/;
const injected = mainSource.replace(spawnHead, "$1div()['border_dashed'] ();\n      $2");

test('T1 negative: the static scan catches a bracketed call with blanks or a line break before the parenthesis', () => {
  assert.notEqual(injected, mainSource, 'the injection point exists in main.js');
  assert.ok(unregistered(injected).includes('border_dashed'));
  assert.deepEqual(unregistered("div()['border_dashed']\n  ()"), ['border_dashed']);
  assert.deepEqual(unregistered('div().border_dashed ()'), ['border_dashed']);
});

test('T1 negative: the click-then-await path catches the same call, which the static scan alone would not run', async () => {
  const { ReportView, parseReport } = await loadView({ mainOverride: injected });
  const view = viewWith(ReportView, parseReport(fixtureText));
  const errors = await fireClicksSettled(view.render());
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof TypeError, String(errors[0]));
});

test('K6 control: the mock host rejects an unregistered builder method', async () => {
  const { ReportView } = await loadView();
  const probe = new ReportView();
  assert.throws(() => probe.card({ border: '#000', surface: '#000' }).border_dashed(), TypeError);
});

// tidy: layout of the report column, KPI tiles and list rows.
const withStyle = (root, key) => flatten(root).filter(el => el.style && el.style[key] !== undefined);

test('tidy: the body column is capped at 880 and fills the pane width', async () => {
  const { tree } = await renderCase();
  const column = tree.parts.find(part => part?.style?.max_w !== undefined);
  assert.ok(column, 'a column carries max_w');
  assert.equal(column.style.max_w, 880);
  assert.equal(column.style.w, '100%');
  assert.equal(column.style.min_w, 0);
});

test('tidy: card headers carry the title only, no list/table/check/risk meta', async () => {
  const { tree } = await renderCase();
  const texts = textsOf(tree);
  for (const prefix of ['목록 ', '표 ', '확인 ', '위험 ']) {
    assert.equal(texts.some(text => text.startsWith(prefix) && /\d/.test(text)), false, `${prefix} meta is gone`);
  }
});

test('tidy: each KPI tile has exactly one detail line, and retries/fallbacks show only when not zero', async () => {
  const { tree } = await renderCase();
  const detailsOf = tile => tile.parts.filter(part => part?.style?.h === 14);
  const tileEls = flatten(tree).filter(el => el.kind === 'v_flex' && el.parts.some(part => part?.style?.h === 14));
  assert.equal(tileEls.length, 3);
  for (const tile of tileEls) assert.equal(detailsOf(tile).length, 1);
  assert.ok(textsOf(tree).includes('소요 · 재시도 1 · fallback 1'));

  const zero = JSON.parse(fixtureText);
  zero.kpi.retries = 0; zero.kpi.fallbacks = 0;
  const { ReportView, parseReport } = await loadView();
  const zeroTexts = textsOf(viewWith(ReportView, parseReport(JSON.stringify(zero))).render());
  assert.ok(zeroTexts.includes('소요'));
  assert.equal(zeroTexts.some(text => text.includes('fallback') || (text.includes('재시도') && text !== '소요 / 재시도')), false);
});

test('tidy: list and checklist rows have no divider; risk rows keep one with py 4', async () => {
  const { tree } = await renderCase();
  const bordered = withStyle(tree, 'border_b').filter(el => el.style.py === 4);
  const plainRows = flatten(tree).filter(el => el.kind === 'h_flex' && el.style.py === 2);
  assert.ok(plainRows.length > 0, 'list rows use py 2');
  for (const row of plainRows) assert.equal(row.style.border_b, undefined);
  for (const row of bordered) assert.equal(row.parts.length, 2);
});
