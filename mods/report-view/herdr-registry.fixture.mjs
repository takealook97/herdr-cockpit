// Builder methods the Herdr JS runtime registers, copied for the report-view tests.
// Source: /Users/deepeet/Projects/herdr/herdr-app-pr499 @ fdbbe92 (vendor/gpui-kit/crates/shell/src).
// Update this file when Herdr changes its builder surface.

// style.rs PARAM_STYLES: style methods that take an argument.
export const PARAM_STYLES = [
  'w', 'h', 'size', 'min_w', 'min_h', 'min_size', 'max_w', 'max_h', 'max_size',
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr',
  'inset', 'top', 'bottom', 'left', 'right', 'gap', 'gap_x', 'gap_y',
  'flex_grow', 'flex_shrink', 'flex_basis', 'bg', 'text_color', 'text_bg', 'text_size',
  'font_family', 'font_weight', 'line_height', 'opacity',
  'border', 'border_t', 'border_b', 'border_l', 'border_r', 'border_x', 'border_y', 'border_color',
  'rounded', 'rounded_t', 'rounded_b', 'rounded_l', 'rounded_r', 'rounded_tl', 'rounded_tr', 'rounded_bl', 'rounded_br',
];

// style.rs EXTRA_NULLARY plus the reflected no-argument methods report-view relies on.
// Reflected ones come from gpui-pre `Styled` (vendor/gpui-pre/src/styled.rs, macros in gpui-pre-macros styles.rs).
export const NULLARY_STYLES = [
  'font_semibold', 'font_bold', 'font_normal',
  'flex', 'flex_none', 'flex_1', 'items_center', 'items_start', 'justify_end', 'truncate',
  'relative', 'absolute', 'overflow_hidden', 'cursor_pointer', 'size_full',
];

// typings.rs NON_STYLE_METHODS (and materialize.rs for the scrollbar variants): element behaviour, not style.
export const ELEMENT_METHODS = [
  'id', 'child', 'children', 'when', 'map', 'hover', 'on_click', 'tab_index',
  'overflow_y_scroll', 'overflow_y_scrollbar',
];

// Host and component entry points the view calls besides style chains.
export const HOST_METHODS = ['new', 'markdown', 'scrollable', 'after', 'every', 'spawn', 'notify'];

// Known not to be registered (or not verifiable) in the JS builder: the view must never call these.
export const FORBIDDEN_METHODS = ['border_dashed'];
