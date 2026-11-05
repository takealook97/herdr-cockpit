import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, panes, terminals, shared, setShared, theme, props, closeOverlay, notify, run } from "herdr";
import { buildRoster, hintsFrom, parseReply, dotHeights, helperArgs, DOT_COUNT } from "./model.js";

const QUESTION_MAX_W = 160, CHIP_MAX_W = 140, MAX_CHIPS = 4;
const POLL_MS = 120, COUNTDOWN_MS = 1000, WARNING_MS = 6000, STARTUP_MS = 3000;
const UNAVAILABLE_TEXT = "이 기기에서는 음성 입력을 쓸 수 없습니다";
const NO_SPEECH_TEXT = "말을 알아듣지 못했습니다";
const IGNORED_TEXT = "명령으로 들리지 않아 넘겼습니다";
const PLACEHOLDER = "Head에게 보낼 말 · ⌘⇧Space 말하기";

export default class Nexus extends View {
  init(_p, cx) {
    setShared("nexus.open", true);
    this.handle = cx.focus_handle();
    this.reply = null; this.pending = false; this.micHidden = false;
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

  submit(cx) {
    const text = this.input.value().trim();
    if (!text || this.pending) return;
    this.cancelCountdown(cx);
    this.endVoiceSession();
    this.pending = true; this.reply = null; cx.notify();
    cx.spawn(async cx => {
      const reply = await this.helper("route", { text, roster: this.roster() });
      this.pending = false;
      this.handleReply(reply, cx);
      if (reply.action !== "error" && (reply.action !== "ignore" || reply.local)) this.clearInput();
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

  // N8: record the send, close the bar, then take the user to the Head's session.
  afterSend(reply) {
    const terminal = reply.target, label = reply.label || terminal;
    setShared("nexus.last", { label, at: Date.now() });
    closeOverlay(props().overlay);
    const head = (shared("hub.heads") ?? []).find(h => h.address === terminal);
    if (!shared("hub.open") && head) {
      if (head.space != null) run("space.select", { id: head.space });
      if (head.tab != null) run("tab.select", { id: head.tab });
    }
    run("pane.focus", { terminal });
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
    this.userTouched = true; this.typedSinceListen = false; this.reply = null;
    const gen = ++this.listenGen;
    this.listening = true; this.laughing = false; this.levels = []; this.sawActive = false; this.startIdle = false;
    this.startedAt = Date.now(); this.cancelCountdown(cx); cx.notify();
    cx.spawn(async cx => {
      const started = await this.helper("listen", { action: "start", hints: hintsFrom(shared("hub.heads") ?? []) });
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
        this.noSpeech(cx);
      }
      cx.notify();
    });
  }

  // The detached helper may report idle until it initializes; only trust idle after the startup window.
  idleSettled() { return this.startIdle || this.sawActive || Date.now() - this.startedAt >= STARTUP_MS; }

  finishListening(text, cx) {
    if (!this.listening) return;
    this.stopPolling(cx);
    if (this.typedSinceListen) return;
    if (!text.trim()) { if (this.voiceValue !== null) this.clearInput(); this.noSpeech(cx); return; }
    this.setVoiceText(text);
    const gen = this.listenGen;
    this.countdown = cx.timer.after(COUNTDOWN_MS, cx => {
      this.countdown = null;
      if (gen !== this.listenGen || this.closed) return;
      this.submit(cx); cx.notify();
    });
  }
  noSpeech(cx) {
    if (this.typedSinceListen || this.input.value().trim()) return;
    this.reply = { action: "info", info: NO_SPEECH_TEXT };
    cx.notify();
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
  // An explicit submit ends the voice session so a later final cannot resubmit.
  endVoiceSession() {
    this.userTouched = true; this.listenGen++;
    if (this.listening) this.stopSession();
    this.stopPolling();
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

  statusColor(kind, t) {
    return kind === "?" ? t.blocked ?? t.accent : kind === "!" ? t.ansi1 ?? t.accent : kind === "listen" ? t.accent : t.dim;
  }

  // Row 2: one dim status line; ask adds candidate chips inline.
  statusView(t) {
    const reply = this.reply;
    const row = h_flex().id("nexus-status").flex_none().h(22).min_w(0).overflow_hidden().items_center().gap(6).text_size(11.5).text_color(t.dim)
      .child(div().flex_none().text_size(11.5).font_bold().text_color(t.accent).child("NEXUS"));
    const text = (kind, value) => row.child(div().id("nexus-status-text").flex_1().min_w(0).truncate()
      .text_color(this.statusColor(kind, t)).tooltip(value).child(value));
    if (this.pending) return row.child(div().text_color(t.dim).child("· 판단 중"))
      .child(div().loop("opacity", { from: 0.2, to: 1, period: 900 }).text_color(t.dim).child("···"));
    if (this.countdown) return text("", "· 1초 뒤 보냄 · Esc 취소");
    if (reply?.action === "ask") {
      const question = `? ${reply.question ?? ""}`;
      row.child(div().id("nexus-question").flex_none().max_w(QUESTION_MAX_W).truncate()
        .text_color(this.statusColor("?", t)).tooltip(question).child(question));
      return row.child(h_flex().id("nexus-chips").flex_1().min_w(0).overflow_hidden().gap(6).items_center()
        .children((reply.candidates ?? []).slice(0, MAX_CHIPS).map(c => {
          const label = c.label || c.address;
          return div().id(`nexus-chip-${c.address}`).flex_1().min_w(0).max_w(CHIP_MAX_W).h(22).px(8).rounded(6).border(1).border_color(t.border)
            .flex().items_center().truncate().text_size(11.5).text_color(t.foreground).hover(s => s.bg(t.hover))
            .tooltip(label).on_click((_e, cx) => this.chooseCandidate(c, cx)).child(label);
        })));
    }
    if (reply?.action === "ignore") return text("", `· ${reply.summary || IGNORED_TEXT}`);
    if (reply?.action === "error") return text("!", `! ${reply.error ?? ""}`);
    if (this.listening) return text("listen", "· 듣는 중");
    if (reply?.action === "info") return text("", `· ${reply.info ?? ""}`);
    return text("", "· 대기");
  }

  dots(t) {
    const color = this.listening && !this.laughing ? t.accent : t.dim;
    return h_flex().flex_none().h(18).gap(3).items_center().children(dotHeights(this.levels).map((h, i) =>
      div().id(`nexus-dot-${i}`).w(4).h(h).rounded(2).bg(color)));
  }

  render() {
    const t = theme();
    return v_flex().id("nexus").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.background).p(12).gap(6).text_size(12)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.input)))
        .child(this.dots(t))
        .when(!this.micHidden, el => el.child(div().id("nexus-mic").size(24).flex_none().flex().items_center().justify_center()
          .rounded(6).border(1).border_color(this.listening ? t.accent : t.border).text_size(11)
          .text_color(this.listening ? t.accent : t.muted).tooltip(this.listening ? "듣기 중지" : "말하기")
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleMic(cx)).child("●"))))
      .child(this.statusView(t));
  }
}
