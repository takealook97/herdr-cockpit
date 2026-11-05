import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, panes, terminals, shared, setShared, theme, props, closeOverlay, notify, run } from "herdr";
import { buildRoster, logLines, parseReply, dotHeights, helperArgs, DOT_COUNT } from "./model.js";

const POLL_MS = 120, COUNTDOWN_MS = 1500, LOG_LIMIT = 6, NOTIFY_MS = 5000, WARNING_MS = 6000, STARTUP_MS = 3000;
const UNAVAILABLE_TEXT = "이 기기에서는 음성 입력을 쓸 수 없습니다";
const PLACEHOLDER = "Head에게 보낼 말 · ⌃Space 말하기";

export default class Nexus extends View {
  init(_p, cx) {
    setShared("nexus.open", true);
    this.handle = cx.focus_handle();
    this.entries = []; this.reply = null; this.pending = false; this.micHidden = false;
    this.listening = false; this.laughing = false; this.polling = false; this.levels = []; this.countdown = null; this.voiceValue = null;
    this.listenGen = 0; this.sawActive = false; this.startIdle = false; this.startedAt = 0; this.closed = false;
    this.listenPid = null; this.userTouched = false; this.typedSinceListen = false;
    this.input = InputState.new({ placeholder: PLACEHOLDER });
    this.input.focus();
    this.input.on("submit", () => this.submit(cx));
    this.input.on("change", () => {
      if (this.input.value() !== this.voiceValue) {
        if (this.listening) this.typedSinceListen = true;
        this.userTouched = true;
        if (this.countdown) this.cancelCountdown(cx);
      }
    });
    this.loadLog(cx);
    const gen = this.listenGen;
    cx.spawn(async cx => {
      const status = await this.helper("listen", { action: "status" });
      if (status.state === "unavailable") return this.hideMic(cx);
      cx.notify();
      if (gen !== this.listenGen || this.userTouched || this.closed) return;
      if (props()?.listen && !this.micHidden) this.startListening(cx);
    });
  }

  helper(sub, opts) {
    return exec("sh", helperArgs(sub, opts)).then(r => parseReply(r.stdout))
      .catch(error => ({ action: "error", error: `helper를 실행하지 못했습니다: ${String(error?.message ?? error)}` }));
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
      if (reply.action !== "error" && (reply.action !== "ignore" || reply.local)) this.clearInput();
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
    if (reply.action === "ignore" && reply.local) this.clearInput();
    if (reply.action === "send" && reply.sent !== false) {
      this.afterSend(reply);
      if (reply.warning) notify({ title: "Nexus", body: reply.warning, level: "warning", timeout: WARNING_MS });
    }
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

  hideMic(cx) {
    this.micHidden = true; this.stopPolling(cx);
    this.reply = { action: "info", info: UNAVAILABLE_TEXT };
    cx.notify();
  }

  startListening(cx) {
    if (this.listening || this.micHidden || this.closed) return;
    this.userTouched = true; this.typedSinceListen = false;
    const gen = ++this.listenGen;
    this.listening = true; this.laughing = false; this.levels = []; this.sawActive = false; this.startIdle = false;
    this.startedAt = Date.now(); this.cancelCountdown(cx); cx.notify();
    cx.spawn(async cx => {
      const started = await this.helper("listen", { action: "start" });
      if (gen !== this.listenGen || !this.listening || this.closed) {
        if (started.state === "listening" && Number.isInteger(started.pid) && started.pid > 0) {
          this.helper("listen", { action: "stop", pid: started.pid });
        }
        return;
      }
      this.listenPid = Number.isInteger(started.pid) && started.pid > 0 ? started.pid : null;
      if (started.state === "unavailable") return this.hideMic(cx);
      if (started.state === "error" || started.action === "error") return this.failListening(started, cx);
      this.startIdle = started.state === "idle";
      this.poll = cx.timer.every(POLL_MS, cx => this.pollStatus(cx));
    });
  }

  pollStatus(cx) {
    if (this.polling || !this.listening) return;
    const gen = this.listenGen;
    this.polling = true;
    cx.spawn(async cx => {
      const status = await this.helper("listen", { action: "status" });
      if (gen !== this.listenGen || !this.listening) return;
      this.polling = false;
      const level = Number(status.level) || 0;
      this.laughing = status.laughing === true;
      if (status.state === "listening" && (status.pid || status.partial || level > 0)) this.sawActive = true;
      this.levels = [...this.levels, level].slice(-DOT_COUNT);
      if (typeof status.partial === "string" && status.partial.trim() && !this.typedSinceListen && status.state === "listening") this.setVoiceText(status.partial);
      if (status.state === "unavailable") return this.hideMic(cx);
      if (status.state === "final") this.finishListening(status.final || status.partial || "", cx);
      else if (status.state === "error" || status.action === "error") this.failListening(status, cx);
      else if (status.state === "idle" && this.idleSettled()) {
        if (this.voiceValue !== null && !this.typedSinceListen) this.clearInput();
        this.stopPolling(cx);
      }
      cx.notify();
    });
  }

  // The detached helper may report idle until it initializes; only trust idle after the startup window.
  idleSettled() { return this.startIdle || this.sawActive || Date.now() - this.startedAt >= STARTUP_MS; }

  finishListening(text, cx) {
    this.stopPolling(cx);
    if (this.typedSinceListen) return;
    if (!text.trim()) { if (this.voiceValue !== null) this.clearInput(); return; }
    this.setVoiceText(text);
    const gen = this.listenGen;
    this.countdown = cx.timer.after(COUNTDOWN_MS, cx => {
      this.countdown = null;
      if (gen !== this.listenGen || this.closed) return;
      this.submit(cx); cx.notify();
    });
  }
  failListening(status, cx) {
    this.stopPolling(cx);
    this.reply = { action: "error", error: status.error || "음성 인식 오류" };
    cx.notify();
  }
  stopPolling() { this.listenPid = null; this.listening = false; this.laughing = false; this.polling = false; this.poll?.cancel?.(); this.poll = null; this.levels = []; }
  cancelCountdown(cx) { if (this.countdown) { this.countdown.cancel(); this.countdown = null; cx?.notify(); } }
  stopSession() {
    const pid = this.listenPid;
    return this.helper("listen", pid ? { action: "stop", pid } : { action: "stop" });
  }
  stopListening(cx) {
    this.userTouched = true; this.listenGen++;
    const stop = this.stopSession(); this.stopPolling(cx); cx.notify(); return stop;
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
    this.closed = true; this.listenGen++;
    this.cancelCountdown();
    const wasListening = this.listening;
    if (wasListening) this.stopSession();
    this.stopPolling();
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
    } else if (reply?.action === "info") body.child(div().flex_none().text_color(t.muted).child(`· ${reply.info ?? ""}`));
    else if (reply?.action === "ignore") body.child(div().flex_none().text_color(t.dim).child(`· ${reply.summary || "명령으로 들리지 않아 넘겼습니다"}`));
    else if (reply?.action === "read") body.child(div().flex_none().text_color(t.muted).child(`· ${reply.summary ?? ""}`));
    else if (reply?.action === "error") body.child(div().flex_none().text_color(this.lineColor("!", t)).child(`! ${reply.error ?? ""}`));
    if (this.pending) body.child(h_flex().flex_none().gap(4).text_color(t.dim).child("판단 중")
      .child(div().loop("opacity", { from: 0.2, to: 1, period: 900 }).child("···")));
    return body;
  }

  dots(t) {
    const color = this.listening && !this.laughing ? t.accent : t.dim;
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
