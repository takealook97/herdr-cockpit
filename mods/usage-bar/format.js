export function hudCommand(machine, args) {
  return ['sh', ['-c', 'exec "$HOME/.local/bin/herdr-hud" "$@"', 'hud', ...args], { on: machine || undefined }];
}

// Calendar labels follow local time, including daylight saving time.
const dayMS = 24 * 60 * 60 * 1000;
const day = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMS;
const clock = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
export function pctColorRole(pct) {
  return pct >= 80 ? 'crit' : pct >= 50 ? 'warn' : 'ok';
}
export function formatReset(iso, now = new Date()) {
  const reset = new Date(iso);
  if (!iso || !Number.isFinite(reset.getTime())) return '';
  if (reset <= now) return 'soon';
  return `${reset.getMonth() + 1}/${reset.getDate()} ${clock(reset)}`;
}
export function formatCouponExpiry(iso, now = new Date()) {
  const expires = new Date(iso);
  if (!iso || !Number.isFinite(expires.getTime())) return { text: '—', urgent: false };
  return { text: `~${expires.getMonth() + 1}/${expires.getDate()} ${clock(expires)}`, urgent: expires - now <= 3 * dayMS };
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  return `${Number((bytes / 1024 ** 3).toFixed(1))}G`;
}
export function pickAccounts(usage, visible) {
  return ['codex', 'claude', 'gemini'].filter(provider => visible?.[provider] !== false).map(provider => {
    const account = usage?.accounts?.find(account => account.provider === provider) ?? { provider };
    return { ...account, label: (account.label ?? '').split('@')[0] };
  });
}

// Dimensions shared by the provider cards and their width estimates.
export const cellWidth = label => label === 'coupon' ? 52 : 96;
export const labelWidth = accountLine => accountLine ? 96 : 48;
export const hasCouponCell = provider => provider === 'codex' || provider === 'claude';
export const LINEAR_WIDTH = 110;
export const REPORT_WIDTH = 92;
export const GEAR_WIDTH = 38;
// The detail column (RAM used/total) is the first thing to go when the right-hand cards still do not fit.
const SYSTEM_DETAIL_WIDTH = 60;
export const systemWidth = (bars, compact = false) => (bars ? 178 : 142) - (compact ? SYSTEM_DETAIL_WIDTH : 0);
const PROVIDER_GAP = 10;

// Left to right: provider cards, spacer, Linear (when shown), Report, system card, gear.
export function barOrder({ groups = true, linear = true, system = true } = {}) {
  return [groups && 'groups', 'spacer', linear && 'linear', 'report', system && 'system', 'gear'].filter(Boolean);
}

export function barSpacing(width) {
  // Keep the right-hand cards visible at 320px even with all providers shown.
  return width < 354 ? { padding: 6, gap: 4 } : { padding: 12, gap: 10 };
}

// `visible.linear` must say whether the Linear card is actually on screen (not just enabled).
// Shrink order: the system card's detail column, the account line, then progress bars.
export function layoutMode(width, accounts, visible) {
  const mode = { bars: true, accountLine: true };
  const providers = accounts.filter(account => visible?.[account.provider] !== false);
  const showLinear = visible?.linear !== false;
  const showSystem = visible?.system !== false;
  const { padding, gap } = barSpacing(width);
  // Count gaps after the spacer and between the right-hand cards. Report is always shown.
  const outer = padding * 2 + gap * (2 + Number(showLinear) + Number(showSystem) + Number(providers.length > 0));
  const fixed = outer + GEAR_WIDTH + REPORT_WIDTH + (showLinear ? LINEAR_WIDTH : 0);
  const providerGaps = Math.max(0, providers.length - 1) * PROVIDER_GAP;
  const needed = () => {
    const weekly = cellWidth('weekly') - (mode.bars ? 0 : 32);
    return providers.reduce((sum, account) => sum + labelWidth(mode.accountLine) + weekly +
      (hasCouponCell(account.provider) ? cellWidth('coupon') + 8 : 0) + 16 + 2 + 8,
    fixed + providerGaps + (showSystem ? systemWidth(mode.bars, mode.compactSystem) : 0));
  };
  if (showSystem && width < needed()) mode.compactSystem = true;
  if (width < needed()) mode.accountLine = false;
  if (width < needed()) mode.bars = false;
  return mode;
}
