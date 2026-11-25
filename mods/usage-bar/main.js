import { View } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { exec, spaces, agents, theme, props, shared, setShared, run } from 'herdr';
import { formatReset, formatCouponExpiry, formatBytes, pickAccounts, layoutMode, hudCommand, hasCouponCell, barSpacing, barOrder, LINEAR_WIDTH, REPORT_WIDTH, GEAR_WIDTH, systemWidth } from './format.js';
import { cell, groupLabel, systemRow, iconButton, linearButton, reportButton } from './ui.js';
import { readVisible, toggleVisible } from './prefs.js';
import { badgeState, seenAccount, seenIds, unreadIds, nextSeen } from './linear.js';
import { LinearDetails } from './linear-detail.js';
import { linearPanel, settingsPanel, openPanel } from './panels.js';

const LINEAR_REV = 'usage-bar.linear-rev';
const LINEAR_ACCOUNT_REV = 'usage-bar.linear-account-rev';
const LINEAR_ACCOUNT_MACHINE = 'usage-bar.linear-account-machine';
const LINEAR_OPEN_REV = 'usage-bar.linear-open-rev';
const LINEAR_SEEN = 'usage-bar.linear-seen';
const LINEAR_POLL_MS = 30 * 60 * 1000;
const LINEAR_STATUS_RETRY_MS = 60 * 1000;
const LINEAR_ACTION_ERRORS_WITHOUT_REFRESH = new Set(['bad_request', 'busy', 'not_connected', 'expired', 'no_done_state']);
const VISIBLE_KEY = 'usage-bar.visible';
const REPORT_OPEN = 'report.open';
const HUB_OPEN = 'hub.open';
const linearRevision = (key = LINEAR_REV) => {
  const value = shared(key);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

function issuesMismatchStatus(issues, status) {
  return status?.connected === false ||
    !!(issues?.source && status?.source && issues.source !== status.source) ||
    !!(issues?.org_url && status?.org?.url && issues.org_url !== status.org.url);
}

function linearCommand(args, machine) {
  return hudCommand(machine, ['linear', ...args]);
}

async function execLinear(args, machine) {
  try {
    const { code, stdout } = await exec(...linearCommand(args, machine));
    const data = JSON.parse(stdout);
    if (typeof data?.error === 'string') return data;
    const valid = args[0] === 'issue' ? data?.issue?.identifier === args[1] :
      args[0] === 'complete' || args[0] === 'restore' ? data?.identifier === args[1] :
      args[0] === 'issues' ? Array.isArray(data?.issues) : typeof data?.connected === 'boolean';
    if (code === 0 && valid) return data;
  } catch {
    // Launch and JSON failures use fixed copy. Never surface helper diagnostics.
  }
  return null;
}

export default class UsageBar extends View {
  init(_props, cx) {
    const popup = props();
    this.panel = popup?.panel;
    this.linearGen = 0;
    this.linearRev = linearRevision();
    this.linearAccountRev = linearRevision(LINEAR_ACCOUNT_REV);
    this.linearSeq = { issues: 0, status: 0 };
    this.linearPending = new Set();
    this.linearUndo = null;
    this.linearActionNote = null;
    this.linearUndoTimer = null;
    this.linearVisible = readVisible(shared(VISIBLE_KEY)).linear;
    if (this.panel === 'linear' || this.panel === 'settings') {
      this.linearTarget = popup?.machine ?? '';
      this.handle = cx.focus_handle();
      this.handle.focus();
      if (this.panel === 'settings') {
        this.input = InputState.new({ placeholder: 'lin_api_…' });
        this.input.set_masked(true);
        this.input.on('submit', (_event, cx) => this.changeLinear('connect', cx));
      } else {
        this.linearDetails = new LinearDetails();
        this.readLinear('issues', cx);
      }
      this.readLinear('status', cx);
      return;
    }
    this.byMachine = Object.create(null);
    this.busy = new Set();
    this.request = new Set();
    this.width = 1200;
    this.observedKey = null;
    this.agentStatus = new Map();
    const snapshot = this.context();
    this.linearTarget = snapshot.machine;
    this.applyContext(snapshot, cx);
    this.refresh('sys', cx);
    this.refresh('usage', cx);
    cx.timer.every(1000, cx => this.refresh('sys', cx));
    cx.timer.every(60000, cx => this.refresh('usage', cx));
    if (this.linearVisible) {
      this.readLinear('status', cx);
      this.readLinear('issues', cx);
    }
    cx.timer.every(LINEAR_POLL_MS, cx => {
      if (this.linearVisible && readVisible(shared(VISIBLE_KEY)).linear) this.readLinear('issues', cx);
    });
    cx.timer.every(LINEAR_STATUS_RETRY_MS, cx => {
      if (this.linearVisible && readVisible(shared(VISIBLE_KEY)).linear &&
          this.linearStatus == null && this.linearStatusReadRev == null) this.readLinear('status', cx);
    });
  }

  close() {
    this.closed = true;
    this.clearLinearUndo();
    this.input?.release();
    this.handle?.release();
  }

  linearSnapshot() {
    // Hide the old snapshot on the first render, before the observation timer clears it.
    if (this.linearAccountRev !== linearRevision(LINEAR_ACCOUNT_REV)) {
      return { issues: null, status: null, issueError: null, statusError: null };
    }
    return { issues: this.linearIssues, status: this.linearStatus,
      issueError: this.linearIssueError, statusError: this.linearStatusError,
      pending: this.linearPending, undo: this.linearUndo, note: this.linearActionNote,
      details: this.linearDetails, seenAccount: this.linearSeenAccount,
      unread: this.linearUnreadAccount === this.linearSeenAccount ? this.linearUnread : undefined };
  }

  linearMachine() {
    return this.linearTarget;
  }

  switchLinearTarget(cx) {
    const machine = this.context().machine;
    if (machine === this.linearTarget) return;
    this.linearTarget = machine;
    this.linearGen++;
    this.clearLinearSnapshot();
    this.linearSeenReset = false;
    if (this.linearVisible) {
      this.readLinear('status', cx);
      this.readLinear('issues', cx);
    }
    cx.notify();
  }

  resetLinearAccount(rev) {
    this.linearAccountRev = rev;
    this.clearLinearSnapshot();
    const machine = shared(LINEAR_ACCOUNT_MACHINE);
    this.linearSeenReset = (typeof machine === 'string' ? machine : '') === this.linearMachine();
  }

  clearLinearSnapshot() {
    this.linearSeq.issues++;
    this.linearSeq.status++;
    this.linearDetails?.clear();
    this.linearIssues = null;
    this.linearStatus = null;
    this.linearSeenAccount = null;
    this.linearStatusReadRev = null;
    this.linearIssuesReadSeq = null;
    this.linearIssuesRev = null;
    this.linearUnread = undefined;
    this.linearUnreadAccount = null;
    this.linearIssueError = null;
    this.linearStatusError = null;
    this.linearPending = new Set();
    this.linearActionNote = null;
    this.clearLinearUndo();
  }

  applyLinearStatus(status, rev) {
    const account = seenAccount(status);
    const viewerChanged = this.linearSeenAccount && account && this.linearSeenAccount !== account;
    const needsSeenUpdate = account && account !== seenAccount(this.linearStatus);
    // A new issues reply can arrive before status for the same revision.
    if (issuesMismatchStatus(this.linearIssues, status) ||
        (this.linearIssuesRev !== rev && viewerChanged)) {
      this.linearIssues = null;
      this.linearIssueError = null;
      this.linearDetails?.clear();
      this.linearUnread = undefined;
    }
    this.linearStatus = status;
    // A connected status can temporarily omit identity when whoami fails.
    if (account) this.linearSeenAccount = account;
    this.linearStatusError = null;
    if (!this.closed && this.linearIssuesRev === rev && needsSeenUpdate) {
      this.updateLinearSeen();
    }
  }

  bumpLinear({ fromOpening = false, updateLocal = true } = {}) {
    const rev = linearRevision() + 1;
    if (updateLocal) this.linearRev = rev;
    if (fromOpening) setShared(LINEAR_OPEN_REV, rev);
    setShared(LINEAR_REV, rev);
  }

  updateLinearSeen() {
    const snapshot = this.linearIssues;
    const account = seenAccount(this.linearStatus);
    if (!account || !snapshot || snapshot.error || snapshot.stale ||
        issuesMismatchStatus(snapshot, this.linearStatus)) return;
    const seen = shared(LINEAR_SEEN);
    const reset = this.linearSeenReset;
    this.linearSeenReset = false;
    if (this.panel === 'linear') {
      if (this.linearUnreadAccount !== account) this.linearUnread = undefined;
      this.linearUnreadAccount = account;
      this.linearUnread ??= new Set();
      if (!reset) {
        for (const id of unreadIds(snapshot.issues, seen, account)) this.linearUnread.add(id);
      }
    } else if (!reset && seenIds(seen, account) !== null) {
      return;
    }
    setShared(LINEAR_SEEN, nextSeen(seen, snapshot.issues, account));
  }

  toggleLinearDetail(identifier, cx) {
    const machine = this.linearMachine();
    const gen = this.linearGen;
    const accountRev = this.linearAccountRev;
    this.linearDetails.toggle(identifier, cx, args => execLinear(args, machine),
      () => !this.closed && gen === this.linearGen && accountRev === linearRevision(LINEAR_ACCOUNT_REV));
  }

  clearLinearUndo() {
    this.linearUndoTimer?.cancel();
    this.linearUndoTimer = null;
    this.linearUndo = null;
  }

  completeLinearIssue(identifier, cx) {
    this.runLinearIssueAction(['complete', identifier], cx);
  }

  undoLinearComplete(cx) {
    const undo = this.linearUndo;
    if (undo) this.runLinearIssueAction(['restore', undo.identifier, undo.token], cx);
  }

  runLinearIssueAction(args, cx) {
    const [action, identifier] = args;
    const machine = this.linearMachine();
    const gen = this.linearGen;
    const accountRev = this.linearAccountRev;
    const isCurrent = () => !this.closed && gen === this.linearGen &&
      accountRev === linearRevision(LINEAR_ACCOUNT_REV);
    if (this.panel !== 'linear' || !isCurrent() || this.linearPending.has(identifier)) return;
    if (action === 'restore') this.clearLinearUndo();
    this.linearPending = new Set([...this.linearPending, identifier]);
    this.linearActionNote = null;
    cx.notify();

    cx.spawn(async cx => {
      const data = await execLinear(args, machine);
      const success = data && !data.error;
      const current = isCurrent();
      if (success) this.bumpLinear({ updateLocal: current });
      if (!current) return;
      const pending = new Set(this.linearPending);
      pending.delete(identifier);
      this.linearPending = pending;
      if (!success) {
        const error = data?.error ?? 'helper';
        this.linearActionNote = { identifier, error };
        if (LINEAR_ACTION_ERRORS_WITHOUT_REFRESH.has(error)) cx.notify();
        else this.readLinear('issues', cx, { refresh: true });
        return;
      }

      if (action === 'complete') {
        const snapshot = this.linearIssues;
        if (snapshot) {
          this.linearIssues = { ...snapshot, issues: snapshot.issues.filter(issue => issue.identifier !== identifier) };
        }
        this.clearLinearUndo();
        if (typeof data.previous === 'string' && data.previous) {
          const undo = { identifier, token: data.previous, status: data.status };
          this.linearUndo = undo;
          this.linearUndoTimer = cx.timer.after(6000, cx => {
            if (this.linearUndo !== undo) return;
            this.linearUndoTimer = null;
            this.linearUndo = null;
            cx.notify();
          });
        }
      }
      // Refresh also clears expanded details and invalidates any earlier issues read.
      this.readLinear('issues', cx, { refresh: true });
    });
  }

  readLinear(kind, cx, { refresh = false, observed = false } = {}) {
    const machine = this.linearMachine();
    const gen = this.linearGen;
    if (refresh) {
      this.linearDetails?.clear();
      cx.notify();
    }
    const seq = ++this.linearSeq[kind];
    const rev = linearRevision();
    if (kind === 'status') this.linearStatusReadRev = rev;
    else this.linearIssuesReadSeq = seq;
    const accountRev = this.linearAccountRev;
    const statusAtStart = this.linearStatus;
    const args = [kind];
    if (kind === 'issues') args.push(...(refresh ? ['--refresh'] : ['--max-age', '60s']));
    cx.spawn(async cx => {
      const data = await execLinear(args, machine);
      if (kind === 'issues' && this.linearIssuesReadSeq === seq) this.linearIssuesReadSeq = null;
      const currentRev = linearRevision();
      // A discarded status keeps its read revision so the bar can retry after an opening bump.
      if (gen !== this.linearGen || seq !== this.linearSeq[kind] ||
          (kind === 'status' ? this.linearStatusReadRev : rev) !== currentRev ||
          accountRev !== linearRevision(LINEAR_ACCOUNT_REV)) return;
      if (kind === 'status') this.linearStatusReadRev = null;
      const readError = data?.error === 'busy' ? 'busy' : data ? null : 'helper';
      let freshIssues = false;
      if (kind === 'issues') {
        this.linearIssueError = readError;
        // A newer status can rule out an issues reply already in flight.
        if (!readError && (statusAtStart === this.linearStatus || !issuesMismatchStatus(data, this.linearStatus))) {
          this.linearIssues = data;
          this.linearIssuesRev = rev;
          freshIssues = !data.error && !data.stale;
          if (!this.closed && freshIssues) this.updateLinearSeen();
        }
      } else if (!readError) {
        this.applyLinearStatus(data, currentRev);
        if (!this.closed && !this.panel && data.connected && !this.linearIssues && this.linearIssuesReadSeq == null) {
          this.readLinear('issues', cx);
        }
      } else {
        this.linearStatusError = readError;
      }
      if (refresh) {
        this.bumpLinear();
        if (freshIssues) this.linearIssuesRev = this.linearRev;
        if (!this.closed && !this.linearStatus) this.readLinear('status', cx);
      } else if (!this.closed && freshIssues && this.panel === 'linear' && !observed) {
        // Reads triggered by an observed revision already have a publisher.
        this.bumpLinear({ fromOpening: true });
        this.linearIssuesRev = this.linearRev;
        // This popup's issues announcement doesn't invalidate its pending status.
        if (this.linearStatusReadRev === rev) this.linearStatusReadRev = this.linearRev;
      }
      if (!this.closed) cx.notify();
    });
  }

  changeLinear(action, cx) {
    if (this.linearBusy) return;
    const machine = this.linearMachine();
    const gen = this.linearGen;
    const args = [action];
    if (action === 'connect') {
      const key = this.input.value().trim();
      this.input.set_value('');
      if (!key) return;
      args.push('--key', key);
    }
    this.linearBusy = true;
    this.linearActionError = null;
    cx.notify();
    cx.spawn(async cx => {
      const data = await execLinear(args, machine);
      if (gen !== this.linearGen) return;
      const accountRev = linearRevision(LINEAR_ACCOUNT_REV) + 1;
      setShared(LINEAR_ACCOUNT_MACHINE, machine);
      setShared(LINEAR_ACCOUNT_REV, accountRev);
      this.resetLinearAccount(accountRev);
      this.bumpLinear();
      if (action === 'connect' && data?.connected === true && !data.error &&
          machine === this.context().machine) {
        const visible = shared(VISIBLE_KEY);
        if (!readVisible(visible).linear) setShared(VISIBLE_KEY, toggleVisible(visible, 'linear'));
      }
      if (this.closed) return;
      this.linearBusy = false;
      this.linearActionError = data?.connected === undefined ? data?.error ?? 'helper' : null;
      if (!this.linearActionError) this.applyLinearStatus(data, this.linearRev);
      this.readLinear('status', cx);
      cx.notify();
    });
  }

  observeLinear(visible, cx) {
    if (linearRevision() === this.linearRev && visible === this.linearVisible &&
        linearRevision(LINEAR_ACCOUNT_REV) === this.linearAccountRev) return;
    this.linearObservation?.cancel();
    this.linearObservation = cx.timer.after(0, cx => {
      const rev = linearRevision();
      const accountRev = linearRevision(LINEAR_ACCOUNT_REV);
      const visible = this.panel ? this.linearVisible : readVisible(shared(VISIBLE_KEY)).linear;
      const changed = rev !== this.linearRev;
      const accountChanged = accountRev !== this.linearAccountRev;
      const enabled = !this.panel && visible && !this.linearVisible;
      const opening = !this.panel && changed && rev === shared(LINEAR_OPEN_REV);
      if (accountChanged) this.resetLinearAccount(accountRev);
      this.linearRev = rev;
      this.linearVisible = visible;
      if ((this.panel || visible) && (changed || accountChanged || enabled)) {
        // Reuse the bar's status on open unless the bump invalidated its latest read.
        const statusInvalidated = this.linearStatusReadRev != null && this.linearStatusReadRev !== rev;
        if (!opening || accountChanged || enabled || !this.linearStatus || statusInvalidated) {
          this.readLinear('status', cx);
        }
        if (this.panel !== 'settings') this.readLinear('issues', cx, { observed: true });
      }
      cx.notify();
    });
  }

  popupButton(button, panel) {
    const clearPointer = () => {
      if (this.popupPointer?.panel === panel) this.popupPointer = null;
    };
    return button.on_mouse_down('left', (event, cx) => {
      this.popupPointer = { panel, position: event.position };
      cx.stop_propagation();
    }).on_mouse_down_out(clearPointer).on_key_down(clearPointer)
      .on_click(() => {
        const point = this.popupPointer?.panel === panel ? this.popupPointer.position : null;
        clearPointer();
        openPanel(panel, point, this.context().machine);
      });
  }

  // Only flags change here; the Hub controller owns work-stack selection and the tab bar (D16).
  toggleReport(cx) {
    const opening = shared(REPORT_OPEN) !== true;
    if (opening) setShared(HUB_OPEN, false);
    setShared(REPORT_OPEN, opening);
    cx.notify();
  }

  context() {
    const active = spaces().find(space => space.active);
    const statuses = agents().filter(agent => agent.space === active?.id && !agent.address.includes('/'))
      .map(agent => [agent.address, agent.status]).sort(([a], [b]) => a.localeCompare(b));
    const machine = active?.machine || '';
    return { space: active?.id, machine, statuses, key: JSON.stringify([active?.id, machine, statuses]) };
  }

  scheduleUsage(delay, cx) {
    this.debounce?.cancel();
    this.debounce = cx.timer.after(delay, cx => this.refresh('usage', cx));
  }

  applyContext(snapshot, cx) {
    const changedMachine = this.observedMachine !== undefined && snapshot.machine !== this.observedMachine;
    const completed = snapshot.space === this.observedSpace && snapshot.statuses.some(([address, status]) =>
      this.agentStatus.get(address) === 'working' && ['done', 'idle', 'blocked'].includes(status));
    this.observedSpace = snapshot.space;
    this.observedMachine = snapshot.machine;
    if (changedMachine) {
      this.machineDebounce?.cancel();
      this.machineDebounce = cx.timer.after(300, cx => this.refreshAll(cx));
    }
    this.agentStatus = new Map(snapshot.statuses);
    this.observedKey = snapshot.key;
    if (completed) this.scheduleUsage(2000, cx);
  }

  machineState(machine) {
    return this.byMachine[machine] ??= { sys: null, usage: null, stale: { sys: false, usage: false } };
  }

  refresh(kind, cx, machine = this.context().machine) {
    const key = JSON.stringify([kind, machine]);
    if (this.busy.has(key)) {
      this.request.add(key);
      return;
    }
    this.busy.add(key);
    const state = this.machineState(machine);
    const args = [kind];
    if (kind === 'usage') args.push('--selected', '--max-age', '45s');
    cx.spawn(async cx => {
      let quiet = false;
      try {
        const result = await exec(...hudCommand(machine, args));
        if (result.code !== 0) throw new Error('herdr-hud unavailable');
        const data = JSON.parse(result.stdout);
        if (!data || (kind === 'sys'
          ? !['cpu_pct', 'mem_used_bytes', 'mem_total_bytes'].every(field => Number.isFinite(data[field])) || data.mem_total_bytes <= 0
          : !Array.isArray(data.accounts))) throw new Error('invalid hud data');
        if (kind !== 'sys') data.accounts = data.accounts.map(account => {
          const prior = state.usage?.accounts.find(old => old.provider === account.provider &&
            old.home === account.home && old.id === account.id);
          return account.error && prior ? { ...prior, ...account,
            five_hour: account.five_hour ?? prior.five_hour,
            weekly: account.weekly ?? prior.weekly,
            coupons: account.coupons ?? prior.coupons, stale: true } : account;
        });
        const before = kind === 'sys' ? sysSignature(state.sys, state.stale.sys) : null;
        state[kind] = data;
        state.stale[kind] = false;
        // A 1 s sys poll redraws the window only when a shown number changes.
        if (kind === 'sys' && sysSignature(data, false) === before) quiet = true;
      } catch (_error) {
        state[kind] = null;
        state.stale[kind] = true;
      } finally {
        this.busy.delete(key);
        if (!quiet && this.context().machine === machine) cx.notify();
        const pending = this.request.delete(key);
        if (pending) this.refresh(kind, cx, machine);
      }
    });
  }

  refreshAll(cx) {
    this.refresh('sys', cx);
    this.refresh('usage', cx);
  }

  percentCell(t, window, now, mode) {
    const past = window?.resets_at && new Date(window.resets_at) <= now;
    const pct = past ? 0 : window?.used_pct;
    const known = Number.isFinite(pct);
    const reset = window ? formatReset(window.resets_at, now) : '';
    return cell(t, { label: 'weekly', value: known ? `${Math.round(pct)}%` : '—',
      pct: known ? pct : undefined, detail: reset ? `↻ ${reset}` : '',
      hideBar: !mode.bars });
  }

  render(cx) {
    const panel = props()?.panel;
    if (panel === 'linear' || panel === 'settings') {
      this.observeLinear(this.linearVisible, cx);
      return panel === 'linear' ? linearPanel(this) : settingsPanel(this, cx);
    }
    // Apply usage context after render. Linear hides the prior machine's
    // snapshot immediately and changes request ownership in its own timer.
    const snapshot = this.context();
    const live = snapshot.machine;
    const linearTargetChanged = live !== this.linearTarget;
    if (linearTargetChanged) {
      this.linearTransition?.cancel();
      this.linearTransition = cx.timer.after(0, cx => this.switchLinearTarget(cx));
    }
    if (snapshot.key !== this.observedKey) {
      this.observation?.cancel();
      this.observation = cx.timer.after(0, cx => { this.applyContext(snapshot, cx); cx.notify(); });
    }
    const t = theme(), now = new Date();
    const state = this.machineState(snapshot.machine);
    const visible = readVisible(shared(VISIBLE_KEY));
    this.observeLinear(visible.linear, cx);
    const accounts = pickAccounts(state.usage, visible);
    const { padding, gap } = barSpacing(this.width);
    const { status, issues, issueError, seenAccount: account } = linearTargetChanged ? {} : this.linearSnapshot();
    const disconnected = ['not_connected', 'expired'].includes(issues?.error);
    const connected = disconnected ? false : (issues?.source ? true : status?.connected);
    const expired = issues?.error === 'expired' || status?.error === 'expired';
    const showLinear = visible.linear && (connected === true || expired);
    // Shrink decisions use what is really on screen, so a hidden Linear card costs no width.
    const mode = layoutMode(this.width, accounts, { ...visible, linear: showLinear });
    const rightWidth = GEAR_WIDTH + REPORT_WIDTH + (showLinear ? LINEAR_WIDTH : 0) + (visible.system ? systemWidth(mode.bars, mode.compactSystem) : 0);
    const providerRoom = this.width - 2 * padding - rightWidth -
      gap * (3 + Number(showLinear) + Number(visible.system));
    const group = id => h_flex().id(id).h(38).items_center().flex_none().px(8).gap(6)
      .rounded(6).bg(t.chrome).border(1).border_color(t.muted + "66").cursor_pointer()
      .tooltip('Click to refresh usage')
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => this.refreshAll(cx));
    const { cpu_pct: cpu, mem_used_bytes: used, mem_total_bytes: total } = state.sys ?? {};
    const memory = total > 0 ? used / total * 100 : undefined;
    const detail = total > 0 ? `${formatBytes(used).replace(/G$/, '')}/${formatBytes(total)}` : '';
    const system = group('system').child(v_flex().justify_center().gap(1)
      .opacity(state.stale.sys ? 0.6 : 1)
      .child(systemRow(t, 'CPU', cpu, '', !mode.bars, mode.compactSystem))
      .child(systemRow(t, 'RAM', memory, detail, !mode.bars, mode.compactSystem)));
    const groups = [];
    for (const account of accounts) {
      const stale = account.stale || !!account.error || state.stale.usage;
      const content = h_flex().items_center().gap(8).opacity(stale ? 0.6 : 1)
        .child(groupLabel(t, account, !mode.accountLine))
        .child(this.percentCell(t, account.weekly, now, mode));
      if (hasCouponCell(account.provider)) {
        const count = account.coupons?.available;
        const expiry = count > 0 ? formatCouponExpiry(account.coupons.next_expires_at, now) : { text: '—', urgent: false };
        content.child(cell(t, { label: 'coupon', value: count === undefined ? '—' : `${count} resets`, detail: expiry.text,
          color: count ? t.accent : t.dim, detailColor: expiry.urgent ? t.blocked : t.dim }));
      }
      groups.push(group(`account-${account.provider}`).child(content));
    }
    const badge = badgeState(issues?.issues, now);
    const seen = shared(LINEAR_SEEN);
    // A dropdown can prune IDs before the bar receives the corresponding issues list.
    const unread = !this.linearSeenReset && this.linearIssuesRev === linearRevision() && !issuesMismatchStatus(issues, status)
      ? unreadIds(issues?.issues, seen, account).size : 0;
    const linear = this.popupButton(linearButton(t, {
      count: Array.isArray(issues?.issues) && connected ? badge.count : null,
      alert: !!connected && badge.alert,
      unread: connected ? unread : 0,
      connected,
      stale: !!(issues?.stale || issueError),
    }), 'linear');
    const gear = this.popupButton(iconButton(t, 'gear', '⚙︎', 'Top bar settings'), 'settings');
    const report = reportButton(t, shared(REPORT_OPEN) === true).on_click((_event, cx) => this.toggleReport(cx));
    const parts = {
      groups: () => h_flex().id('groups').min_w(0).max_w(Math.max(0, providerRoom))
        .overflow_hidden().items_center().gap(10).children(groups),
      spacer: () => h_flex().flex_1().min_w(0),
      linear: () => linear.min_w(0).flex_shrink(1).overflow_hidden(),
      report: () => report,
      system: () => system.min_w(0).flex_shrink(1).overflow_hidden(),
      gear: () => gear,
    };
    const root = h_flex().id('root').size_full().min_w(0).px(padding).gap(gap).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } });
    for (const id of barOrder({ groups: groups.length > 0, linear: showLinear, system: visible.system })) {
      root.child(parts[id]());
    }
    return root;
  }
}

function sysSignature(sys, stale) {
  if (!sys) return '';
  return [Math.round(sys.cpu_pct), Math.round(sys.mem_used_bytes / sys.mem_total_bytes * 100),
    (sys.mem_used_bytes / 2 ** 30).toFixed(0), stale].join('|');
}
