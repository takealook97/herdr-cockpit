import { div } from "gpui-kit";

const TAG_H = 16;
const LIGHT_TEXT = "#f5f5f5";
const DARK_FALLBACK = "#0b0b0b";
const MIN_CONTRAST = 4.5;

const isHex = value => /^#[0-9a-f]{6}/i.test(value ?? "");
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = hex => {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text color for a solid accent pill: the theme background, unless near-white reads better on it.
export function headTagTextColor(accent, background) {
  const dark = isHex(background) ? background : DARK_FALLBACK;
  if (!isHex(accent)) return dark;
  if (contrast(dark, accent) >= MIN_CONTRAST) return dark;
  return contrast(LIGHT_TEXT, accent) > contrast(dark, accent) ? LIGHT_TEXT : dark;
}

// Flat pill: one solid accent background and a single text child. Child overlays are not clipped to
// rounded corners in this toolkit, so the tag carries no layers. Same style for every Head.
export function headTag(row, t, onRename) {
  const tag = div().id(`head-${row.key}`).flex_none().h(TAG_H).px(5).flex().items_center().rounded(TAG_H / 2)
    .bg(t.accent).text_size(10).font_semibold().text_color(headTagTextColor(t.accent, t.background))
    .child("HEAD");
  if (onRename) tag.on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); onRename(cx); } });
  return tag;
}
