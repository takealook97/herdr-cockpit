import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export const TAG_WIDTH = 52;
const GLYPH = "mods/space-tree/head-diamond.svg";

// "#rgb" / "#rrggbb" + alpha 0..1 -> "#rrggbbaa". gpui colors carry no separate opacity.
export function withAlpha(color, alpha) {
  const hex = String(color ?? "").replace("#", "");
  const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return color;
  return `#${full}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0")}`;
}

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
export function mixColor(a, b, k = 0.5) {
  if (!/^#[0-9a-f]{6}/i.test(a ?? "") || !/^#[0-9a-f]{6}/i.test(b ?? "")) return a;
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((v, i) => Math.round(v * (1 - k) + y[i] * k).toString(16).padStart(2, "0")).join("")}`;
}

// Claude heads read warm orange (red blended into yellow), Codex heads read blue; others use the accent.
export function headColor(program, t) {
  const id = `${program?.key ?? ""} ${program?.name ?? ""}`.toLowerCase();
  if (id.includes("claude")) return t.ansi1 && t.ansi3 ? mixColor(t.ansi1, t.ansi3) : t.accent;
  if (id.includes("codex")) return t.ansi4 ?? t.accent;
  return t.accent;
}

// Glossy pill: tinted base, brighter upper half, 1px top highlight, darker bottom edge.
// A sheen strip crosses it only while the Head works.
export function headTag(row, t, onRename) {
  const color = headColor(row.data?.program, t);
  const working = row.status === "working";
  const tag = h_flex().id(`head-${row.key}`).relative().flex_none().w(TAG_WIDTH).h(16).px(5).gap(3)
    .items_center().rounded(8).overflow_hidden().border_1().border_color(withAlpha(color, 0.5))
    .bg(withAlpha(color, 0.2))
    .child(div().absolute().top(0).left(0).right(0).h(8).bg(withAlpha(color, 0.2)))
    .child(div().absolute().top(0).left(0).right(0).h(1).bg("#ffffff40"))
    .child(div().absolute().bottom(0).left(0).right(0).h(1).bg("#00000040"))
    .child(svg(GLYPH).size(11).flex_none().text_color(color))
    .child(div().relative().flex_none().text_size(10).font_semibold().text_color(t.foreground).child("HEAD"));
  if (working) tag.child(div().absolute().top(0).h(16).w(10).bg("#ffffff2e")
    .loop("left", { from: -12, to: TAG_WIDTH, period: 2400, easing: "ease-in-out" }));
  if (onRename) tag.on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); onRename(cx); } });
  return tag;
}
