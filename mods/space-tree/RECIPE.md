# Space tree

A machine/space/tab/pane tree with persistent folds, section rails, aliases, inline rename, keyboard navigation and guarded tab moves. The Spaces header offers expand/collapse and new-space controls.

The locked hub section is first under This computer, has its own background and rail, and directly lists Heads under `hub · N`. It cannot be renamed, reordered or used as a drag source/target. Clicking the header opens hub; clicking a Head opens and focuses its interactive terminal block. Cmd-Shift-H toggles hub. Selecting an ordinary tree space/tab/pane hides it. The tab bar is hidden while hub is shown.

`hub.js` shows eligible Heads across all spaces and tabs on the current PC. Remote Heads never appear, even when a remote space is selected. Per-machine helper metadata polling remains available for the sidebar; failed polls keep the latest successful snapshot. It excludes orch workers and legacy observers (labels or old attach/--observe argv) and renders original terminals via layout blocks without creating spaces, tabs, observers or terminal processes. Grid membership/title changes and zoom are signature checked; membership changes debounce 500 ms. CLI layout writes are serialized, with shared hub.open as source of truth. A late write never selects an obsolete view.

The layout requires work-stack with work-normal and hub-view children, and a hub-grid node. Cards have 30 px hub-head headers. Rows = count <= 2 ? 1 : 2; columns = ceil(count / rows). Cmd-Alt-arrow commands move between neighboring cells using the focused terminal. Cmd-Shift-Enter toggles the focused cell full view. Outside hub the wrappers call the built-in pane.go and pane.zoom commands; bracket agent navigation is unchanged.

Tests use synthetic metadata and a fake command host. Run `make test` and `herdr-app check "$PWD/mods/space-tree"`. Real terminal input, source navigation, geometry and remote reconnects require an authorized interactive check. Tests and generated editor files are excluded from installation.

Drag a tab row onto a sibling tab row to reorder the persisted native Herdr tabs. The sidebar and Hub list and grid automatically follow that shared order, including when orch metadata is unavailable. Dragging to another space relocates terminals and remains subject to orch status, worker, mod-pane and machine protections.
