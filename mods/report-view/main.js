import { View, div } from 'gpui-kit';
import { h_flex, v_flex, Button, TextView } from 'gpui-base';
import { exec, focused, shared, theme } from 'herdr';
import {
  REFRESH_MS, headTerminal, guardedCall, reportArgs, openArgs, orchCommand,
  parseReport, timelineRows, errorLine, headerModel, kpiTiles, blockRows, conclusionParagraphs,
  logStateFor, isLogOpenFor, visibleBlocks,
} from './model.js';

const TICK_MS = 1000;
const NAME_WIDTH = 168;
const STATUS_WIDTH = 64;
const DURATION_WIDTH = 56;
const BAR_HEIGHT = 10;
const TIMELINE_MAX_HEIGHT = 220;
const TRACK_WIDTH_ESTIMATE = 400;
const GAP = 10;
const CONTENT_MAX_WIDTH = 880;
const KPI_DETAIL_HEIGHT = 14;
const TABLE_FIRST_COLUMN = '30%';
const CARD_RADIUS = 8;
const CARD_PAD = 12;
const STRIPE_WIDTH = 3;
const LIST_ROW_PAD = 2;
const LIST_ROW_GAP = 4;
const RISK_ROW_PAD = 4;

const isOpen = () => shared('report.open') === true;

// Runs orch through sh and returns stdout, or throws with the first stderr line.
// `onSettled` runs when exec itself finishes, even if the timeout already rejected the race.
async function runOrch(args, cx, onSettled = () => {}) {
  const [command, argv] = orchCommand(args);
  let call;
  try {
    call = exec(command, argv);
  } catch (error) {
    onSettled();
    throw error;
  }
  const result = await guardedCall(call, (ms, fn) => cx.timer.after(ms, fn), onSettled);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || `orch exited ${result.code}`);
  return result.stdout;
}

export default class ReportView extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.openError = null;
    this.busy = false;
    this.logState = null;
    this.wasOpen = false;
    this.lastFetch = 0;
    cx.timer.every(TICK_MS, cx => this.tick(cx));
  }

  close() {
    this.closed = true;
  }

  // Poll only while the report is on screen: the first tick after opening reads at once.
  tick(cx) {
    const open = isOpen();
    const due = open && (!this.wasOpen || Date.now() - this.lastFetch >= REFRESH_MS);
    this.wasOpen = open;
    if (due) this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.lastFetch = Date.now();
    const terminal = headTerminal(focused(), shared('hub.heads'));
    cx.spawn(async cx => {
      try {
        const next = parseReport(await runOrch(reportArgs(terminal), cx, () => { this.busy = false; }));
        this.data = next;
        this.logState = logStateFor(this.logState, next.run.id);
        this.error = null;
      } catch (error) {
        // Keep the last good data on screen; only the one-line error changes.
        this.error = errorLine(error?.message ?? error);
      } finally {
        if (!this.closed) cx.notify();
      }
    });
  }

  openInBrowser(cx) {
    const id = this.data?.run?.id;
    if (!id) return;
    cx.spawn(async cx => {
      try {
        await runOrch(openArgs(id), cx);
        this.openError = null;
      } catch (error) {
        this.openError = `브라우저에서 열지 못했습니다: ${String(error?.message ?? error).split('\n')[0]}`;
      }
      if (!this.closed) cx.notify();
    });
  }

  // The progress timeline is open by default only when there is no final report to read.
  isLogOpen() {
    return isLogOpenFor(this.logState, this.data.run.id, this.data.final.present);
  }

  // D14: a status-colored dot plus a foreground label, readable on every theme.
  pill(t, label, colorKey) {
    return h_flex().flex_none().items_center().gap(6).h(20)
      .child(div().flex_none().size(8).rounded(4).bg(t[colorKey]))
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(label));
  }

  header(t) {
    const model = headerModel(this.data);
    return h_flex().flex_none().w('100%').min_w(0).items_center().gap(GAP)
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().min_w(0).items_center().gap(8)
          .child(div().min_w(0).truncate().text_size(16).font_semibold().text_color(t.foreground).child(model.title))
          .child(this.pill(t, model.badge.label, model.badge.colorKey)))
        .child(div().text_size(11).text_color(t.muted).truncate().child(model.meta)))
      .child(Button.new('report-open').flex_none().h(28).px(10).flex().items_center().rounded(6).border(1)
        .border_color(t.border).bg(t.chrome).text_size(12).text_color(t.foreground)
        .cursor_pointer().hover(s => s.bg(t.hover)).tab_index(0)
        .on_click((_event, cx) => this.openInBrowser(cx))
        .child('브라우저에서 보기'));
  }

  card(t) {
    return v_flex().flex_none().w('100%').min_w(0).gap(8).p(CARD_PAD).rounded(CARD_RADIUS).border(1).border_color(t.border).bg(t.surface);
  }

  conclusion(t) {
    const { final } = this.data;
    const model = headerModel(this.data);
    const body = final.present
      ? v_flex().gap(6).children(conclusionParagraphs(final.conclusion)
        .map(text => div().text_size(13).text_color(t.foreground).child(text)))
      : div().text_size(13).text_color(t.foreground).child('Head 최종 보고 없음 — 진행 상황만 있습니다');
    return h_flex().id('report-conclusion').flex_none().rounded(CARD_RADIUS).bg(t.raised).overflow_hidden()
      .child(div().flex_none().w(STRIPE_WIDTH).bg(t[model.stripeColorKey]))
      .child(v_flex().flex_1().min_w(0).gap(6).p(CARD_PAD)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child('결론'))
        .child(body));
  }

  // Tile values stay in the foreground color: status colors fail contrast on the win98 surface (T2); the header badge carries the status.
  kpiRow(t) {
    return h_flex().flex_none().w('100%').min_w(0).gap(GAP)
      .children(kpiTiles(this.data).map((tile, index) => v_flex().id(`report-kpi-${index}`).flex_1().min_w(0).gap(2)
        .p(CARD_PAD).rounded(CARD_RADIUS).border(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(tile.value))
        .child(div().text_size(11).text_color(t.muted).child(tile.label))
        .child(div().h(KPI_DETAIL_HEIGHT).min_w(0).text_size(11).text_color(t.muted).truncate().child(tile.detail))));
  }

  cardHeader(t, block) {
    return h_flex().items_center().gap(8).pb(8).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(block.title));
  }

  bulletRow(t, mark, markColor, text, key) {
    return h_flex().id(key).min_w(0).items_start().gap(8).py(LIST_ROW_PAD)
      .child(div().flex_none().w(16).text_size(13).text_color(markColor).child(mark))
      .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(text));
  }

  moreRow(t, count) {
    return count > 0 ? [div().py(LIST_ROW_PAD).text_size(11.5).text_color(t.muted).child(`… ${count}개 더`)] : [];
  }

  tableGrid(t, block) {
    const cell = (text, header, first) => div().min_w(0).px(8).py(6).text_size(12)
      .when(first, el => el.w(TABLE_FIRST_COLUMN).flex_none()).when(!first, el => el.flex_1())
      .text_color(header ? t.muted : t.foreground).when(header, el => el.font_semibold()).child(text);
    const row = (cells, key, header) => h_flex().id(key).flex_none().min_w(0).items_start()
      .border_b(1).border_color(t.border)
      .children(cells.map((text, column) => cell(text, header, column === 0 && cells.length > 1)));
    const grid = v_flex().flex_none().w('100%').min_w(0).rounded(6).border(1).border_color(t.border).overflow_hidden().child(row(block.header, 'head', true));
    for (let index = 0; index < block.rows.length; index += 1) grid.child(row(block.rows[index], `row-${index}`, false));
    for (const extra of this.moreRow(t, block.more)) grid.child(extra.px(8));
    return grid;
  }

  block(t, source, index) {
    const block = blockRows(source);
    const card = this.card(t).id(`report-block-${index}`).child(this.cardHeader(t, block));
    const rows = [];
    if (block.kind === 'list') {
      block.items.forEach((item, i) => rows.push(this.bulletRow(t, '•', t.muted, item.text, `item-${index}-${i}`)));
    } else if (block.kind === 'checklist') {
      block.items.forEach((item, i) => rows.push(this.bulletRow(t, item.mark, t.foreground, item.text, `item-${index}-${i}`)));
    } else if (block.kind === 'risks') {
      block.items.forEach((item, i) => rows.push(h_flex().id(`item-${index}-${i}`).min_w(0).items_start().gap(8).py(RISK_ROW_PAD).border_b(1).border_color(t.border)
        .child(item.label
          ? this.pill(t, item.label, item.colorKey)
          : div().flex_none().h(20).w(8).text_size(11).text_color(t.muted).child('·'))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(item.text))));
    } else if (block.kind === 'table') {
      return card
        .when(!!block.text, el => el.child(div().text_size(12).text_color(t.muted).child(block.text)))
        .child(this.tableGrid(t, block));
    } else {
      return card.child(TextView.markdown(`report-text-${index}`, block.text).scrollable(false));
    }
    if (rows.length > 0) card.child(v_flex().min_w(0).gap(block.kind === 'risks' ? 0 : LIST_ROW_GAP).children(rows));
    for (const extra of this.moreRow(t, block.more)) card.child(extra);
    return card;
  }

  finalBlocks(t) {
    return v_flex().flex_none().w('100%').min_w(0).gap(GAP).children(visibleBlocks(this.data.final).map((block, index) => this.block(t, block, index)));
  }

  progressToggle(t) {
    const open = this.isLogOpen();
    return h_flex().id('report-progress-toggle').flex_none().items_center().gap(6).px(4).py(6)
      .cursor_pointer().on_click((_event, cx) => { this.logState = { runId: this.data.run.id, open: !open }; cx.notify(); })
      .child(div().flex_none().w(12).text_size(11).text_color(t.muted).child(open ? '▾' : '▸'))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child('진행'));
  }

  bar(t, row) {
    const el = div().absolute().top(0).h(BAR_HEIGHT).rounded(2)
      .left(`${row.leftPct}%`).w(`${row.widthPct}%`);
    if (row.fill) return el.bg(t[row.fill]);
    // Outlined states stay unfilled; running is outlined in the working color. Status is always spelled out beside the bar.
    return el.border(1).border_color(t[row.outlineKey]);
  }

  timelineRow(t, row, index) {
    return h_flex().id(`timeline-${index}`).flex_none().items_center().gap(8).h(18)
      .child(div().w(NAME_WIDTH).flex_none().truncate().text_size(11.5).text_color(t.foreground).child(row.label))
      .child(div().relative().flex_1().min_w(0).h(BAR_HEIGHT).bg(t.border).rounded(2).child(this.bar(t, row)))
      .child(div().w(STATUS_WIDTH).flex_none().text_size(11).text_color(t.muted).child(row.statusLabel))
      .child(h_flex().w(DURATION_WIDTH).flex_none().justify_end().text_size(11).text_color(t.muted).child(row.durationLabel));
  }

  timeline(t) {
    const { rows, unplaced } = timelineRows(this.data, TRACK_WIDTH_ESTIMATE);
    return this.card(t).gap(4)
      .child(div().text_size(11).text_color(t.muted).child(
        unplaced > 0 ? `타임라인 · 시작 시각을 모르는 항목 ${unplaced}개는 표시하지 않음` : '타임라인'))
      .child(v_flex().id('report-timeline').max_h(TIMELINE_MAX_HEIGHT).overflow_y_scroll().gap(2)
        .children(rows.map((row, index) => this.timelineRow(t, row, index))))
      .when(rows.length === 0, el => el.child(div().text_size(11).text_color(t.muted).child('표시할 항목이 없습니다')));
  }

  notice(t, text, id) {
    return div().id(id).flex_none().text_size(11.5).text_color(t.muted).truncate().child(text);
  }

  render() {
    const t = theme();
    const root = v_flex().id('report-view').size_full().min_h(0).min_w(0).bg(t.chrome).overflow_y_scrollbar();
    if (!this.data) {
      const text = this.error ?? '보고서를 불러오는 중입니다…';
      return root.child(div().p(20).text_size(12).text_color(t.muted).child(text));
    }
    return root.child(v_flex().id('report-column').flex_none().w('100%').max_w(CONTENT_MAX_WIDTH).min_w(0).gap(GAP).p(16)
      .child(this.header(t))
      .when(!!this.error, el => el.child(this.notice(t, this.error, 'report-error')))
      .when(!!this.openError, el => el.child(this.notice(t, this.openError, 'report-open-error')))
      .child(this.conclusion(t))
      .child(this.kpiRow(t))
      .child(this.finalBlocks(t))
      .child(this.progressToggle(t))
      .when(this.isLogOpen(), el => el.child(this.timeline(t))));
  }
}
