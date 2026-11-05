import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, panes, terminals, shared, setShared, theme, props, closeOverlay, notify, run } from "herdr";
import { buildRoster, logLines, parseReply, dotHeights, helperArgs, DOT_COUNT } from "./model.js";

const POLL_MS = 120, COUNTDOWN_MS = 1500, LOG_LIMIT = 6, NOTIFY_MS = 5000;
const PLACEHOLDER = "Head에게 보낼 말 · ⌃Space 말하기";

export default class Nexus extends View {
  init(_p, cx) {
    setShared("nexus.open", true);
    this.handle = cx.focus_handle();
    this.entries = []; this.reply = null; this.pending = false; this.micHidden = false;
    this.listening = false; this.polling = false; this.levels = []; this.countdown = null; this.voiceValue = null;
    this.input = InputState.new({ placeholder: PLACEHOLDER });
    this.input.focus();
    this.input.on("submit", () => this.submit(cx));
    this.input.on("change", () => {
      if (this.countdown && this.input.value() !== this.voiceValue) this.cancelCountdown(cx);
    });
    this.loadLog(cx);
    cx.spawn(async cx => {
      const status = await this.helper("listen", { action: "status" });
      this.micHidden = status.state === "unavailable";
      cx.notify();
    });
    if (props()?.listen) this.startListening(cx);
  }

  helper(sub, opts) {
    return exec("sh", helperArgs(sub, opts)).then(r => parseReply(r.stdout))
      .catch(error => ({ action: "error", error: String(error?.message ?? error) }));
  }
  roster() { return buildRoster(shared("hub.heads") ?? [], panes(), terminals()); }

  loadLog(cx) {
    cx.spawn(async cx => {
      const log = await this.helper("log", { limit: LOG_LIMIT });
      this.entries = Array.isArray(log.entries) ? log.entries.slice(-LOG_LIMIT) : [];
      cx.notify();
    });
  }

  submit(cx) {
    const text = this.input.value().trim();
    if (!text || this.pending) return;
    this.cancelCountdown(cx);
    this.pending = true; this.reply = null; cx.notify();
    cx.spawn(async cx => {
      const reply = await this.helper("route", { text, roster: this.roster() });
      this.pending = false;
      this.handleReply(reply, cx);
      if (reply.action !== "error") this.clearInput();
      this.loadLog(cx);
      cx.notify();
    });
  }

  chooseCandidate(candidate, cx) {
    const message = this.reply?.message;
    if (!message || this.pending) return;
    this.pending = true; this.reply = null; cx.notify();
    cx.spawn(async cx => {
      const reply = await this.helper("send", { to: candidate.address, text: message, roster: this.roster() });
      this.pending = false;
      this.handleReply(reply, cx);
      this.loadLog(cx);
      cx.notify();
    });
  }

  handleReply(reply, cx) {
    this.reply = reply;
    if (reply.action === "send" && reply.sent !== false) this.afterSend(reply);
    cx.notify();
  }

  // D11: record the send, close, then take the user to the Head (or toast when the hub is closed).
  afterSend(reply) {
    const terminal = reply.target, label = reply.label || terminal;
    setShared("nexus.last", { label, at: Date.now() });
    closeOverlay(props().overlay);
    if (shared("hub.open")) run("pane.focus", { terminal });
    else notify({ title: "Nexus", body: `→ ${label}`, level: "success", timeout: NOTIFY_MS,
      action: { name: "pane.focus", args: { terminal } } });
  }

  clearInput() { this.voiceValue = null; this.input.set_value(""); }
  setVoiceText(text) { this.voiceValue = text; this.input.set_value(text); }

  startListening(cx) {
    if (this.listening || this.micHidden) return;
    this.listening = true; this.levels = []; this.cancelCountdown(cx); cx.notify();
    cx.spawn(async cx => {
      const started = await this.helper("listen", { action: "start" });
      if (started.state === "error" || started.action === "error") return this.failListening(started, cx);
      this.poll = cx.timer.every(POLL_MS, cx => this.pollStatus(cx));
    });
  }

  pollStatus(cx) {
    if (this.polling || !this.listening) return;
    this.polling = true;
    cx.spawn(async cx => {
      const status = await this.helper("listen", { action: "status" });
      this.polling = false;
      if (!this.listening) return;
      this.levels = [...this.levels, Number(status.level) || 0].slice(-DOT_COUNT);
      if (status.partial && status.state === "listening") this.setVoiceText(status.partial);
      if (status.state === "final") this.finishListening(status.final || status.partial || "", cx);
      else if (status.state === "error" || status.action === "error") this.failListening(status, cx);
      else if (status.state === "idle") this.stopPolling(cx);
      cx.notify();
    });
  }

  finishListening(text, cx) {
    this.stopPolling(cx);
    if (!text.trim()) return;
    this.setVoiceText(text);
    this.countdown = cx.timer.after(COUNTDOWN_MS, cx => { this.countdown = null; this.submit(cx); cx.notify(); });
  }
  failListening(status, cx) {
    this.stopPolling(cx);
    this.reply = { action: "error", error: status.error || "음성 인식 오류" };
    cx.notify();
  }
  stopPolling() { this.listening = false; this.polling = false; this.poll?.cancel?.(); this.poll = null; this.levels = []; }
  cancelCountdown(cx) { if (this.countdown) { this.countdown.cancel(); this.countdown = null; cx?.notify(); } }
  stopListening(cx) {
    this.stopPolling(cx); this.helper("listen", { action: "stop" }); cx.notify();
  }
  toggleMic(cx) { if (this.listening) this.stopListening(cx); else this.startListening(cx); }

  key(e, cx) {
    if (e.key !== "escape" || !(this.countdown || this.listening)) return;
    this.cancelCountdown(cx);
    if (this.listening) this.stopListening(cx);
    cx.stop_propagation(); cx.notify();
  }

  close() {
    setShared("nexus.open", false);
    this.cancelCountdown();
    const wasListening = this.listening;
    this.stopPolling();
    if (wasListening) this.helper("listen", { action: "stop" });
    this.input?.release();
  }

  lineColor(kind, t) {
    return kind === ">" ? t.foreground : kind === "→" ? t.done ?? t.accent : kind === "?" ? t.blocked ?? t.accent
      : kind === "!" ? t.ansi1 ?? t.accent : t.muted;
  }

  logView(t) {
    const lines = logLines(this.entries);
    const reply = this.reply;
    const body = v_flex().id("nexus-log").flex_1().min_h(0).gap(4).overflow_y_scroll().text_size(12);
    lines.forEach((line, i) => body.child(div().id(`nexus-line-${i}`).flex_none()
      .text_color(this.lineColor(line.kind, t)).child(`${line.kind} ${line.text}`)));
    if (reply?.action === "ask") {
      body.child(div().flex_none().text_color(this.lineColor("?", t)).child(`? ${reply.question ?? ""}`));
      body.child(h_flex().flex_none().gap(6).flex_wrap().children((reply.candidates ?? []).map(c =>
        div().id(`nexus-chip-${c.address}`).h(24).px(8).rounded(6).border(1).border_color(t.border)
          .flex().items_center().text_size(11.5).text_color(t.foreground).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.chooseCandidate(c, cx)).child(c.label || c.address))));
    } else if (reply?.action === "read") body.child(div().flex_none().text_color(t.muted).child(`· ${reply.summary ?? ""}`));
    else if (reply?.action === "error") body.child(div().flex_none().text_color(this.lineColor("!", t)).child(`! ${reply.error ?? ""}`));
    if (this.pending) body.child(h_flex().flex_none().gap(4).text_color(t.dim).child("판단 중")
      .child(div().loop("opacity", { from: 0.2, to: 1, period: 900 }).child("···")));
    return body;
  }

  dots(t) {
    const color = this.listening ? t.accent : t.dim;
    return h_flex().flex_none().h(18).gap(3).items_center().children(dotHeights(this.levels).map((h, i) =>
      div().id(`nexus-dot-${i}`).w(4).h(h).rounded(2).bg(color)));
  }

  render() {
    const t = theme();
    const heads = (shared("hub.heads") ?? []).length;
    return v_flex().id("nexus").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.background).p(16).gap(10).text_size(12)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().text_size(12).font_bold().text_color(t.accent).child("NEXUS"))
        .child(div().text_color(t.dim).child(`Head ${heads}`))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child("Esc")))
      .child(this.logView(t))
      .when(Boolean(this.countdown), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child("1.5초 뒤 보냄 · Esc 취소")))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.input)))
        .child(this.dots(t))
        .when(!this.micHidden, el => el.child(div().id("nexus-mic").size(24).flex_none().flex().items_center().justify_center()
          .rounded(6).border(1).border_color(this.listening ? t.accent : t.border).text_size(11)
          .text_color(this.listening ? t.accent : t.muted).tooltip(this.listening ? "듣기 중지" : "말하기")
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleMic(cx)).child("●"))));
  }
}
