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
export const GEAR_WIDTH = 38;
export const systemWidth = bars => bars ? 178 : 142;
const PROVIDER_GAP = 10;

export function barSpacing(width) {
  // Keep the right-hand cards visible at 320px even with all providers shown.
  return width < 354 ? { padding: 6, gap: 4 } : { padding: 12, gap: 10 };
}

export function layoutMode(width, accounts, visible) {
  const mode = { bars: true, accountLine: true };
  const providers = accounts.filter(account => visible?.[account.provider] !== false);
  const showLinear = visible?.linear !== false;
  const showSystem = visible?.system !== false;
  const { padding, gap } = barSpacing(width);
  // Count gaps after the spacer and between the right-hand cards.
  const outer = padding * 2 + gap * (1 + Number(showLinear) + Number(showSystem) + Number(providers.length > 0));
  const fixed = outer + GEAR_WIDTH + (showLinear ? LINEAR_WIDTH : 0);
  const providerGaps = Math.max(0, providers.length - 1) * PROVIDER_GAP;
  const needed = () => {
    const weekly = cellWidth('weekly') - (mode.bars ? 0 : 32);
    return providers.reduce((sum, account) => sum + labelWidth(mode.accountLine) + weekly +
      (hasCouponCell(account.provider) ? cellWidth('coupon') + 8 : 0) + 16 + 2 + 8,
    fixed + providerGaps + (showSystem ? systemWidth(mode.bars) : 0));
  };
  if (width < needed()) mode.bars = false;
  if (width < needed()) mode.accountLine = false;
  return mode;
}
