# Cockpit

## Intent

Keep provider capacity, active work, and machine navigation visible around a large terminal workspace. Vanilla CLI sessions work without cr or orch; orchestration labels appear only when active run metadata exists.

## What you see

A full-height left sidebar divides space-tree and agent-list in a 3:1 ratio. A compact 44 px usage row sits above tabs. The central workspace has padded, rounded terminal panes with persistent pane headers and focus borders. A hidden right panel hosts the shipped files/changes views, and the shipped workspace status sits at the bottom. All colors use the current theme. A sanitized screenshot is pending; no personal preview is included.

## How it behaves

Space-tree navigates machines, repositories, worktrees, tabs, and panes with colored section rails, persistent folds, aliases, keyboard navigation and guarded tab moves. Its locked hub section sits under This computer and directly lists Heads. Cmd-Shift-H toggles an in-layout interactive grid of those original terminals. Tree navigation closes hub; the tab bar stays hidden while hub is open. Cmd-Alt-arrow moves between grid cells and Cmd-Shift-Enter toggles a single focused cell. The same keys call native pane commands outside hub. Cmd-[ / Cmd-] remain unchanged. Each card has a native-style header and a go-to-source button. Agent-list opens agent sessions; usage follows the active machine.

## Built from

`layouts/cockpit.json` composes usage-bar, space-tree, agent-list and hub-head with shipped mods. The work column contains usage and work-stack: work-normal has tabs, work-body and status; hub-view has hub-grid. `hub.js` writes plain JSON layout trees via the Herdr CLI and serializes transitions, with shared hub.open as source of truth. `hub-model.js` supplies Head discovery, grid geometry and neighboring-cell navigation. It excludes workers and legacy observers without creating spaces or terminal processes. The helper runs on each machine, retaining full remote addresses.

`scripts/install.sh` installs custom assets and the helper, merges missing key bindings with a backup, migrates old hub shortcuts, and replaces only exact built-in navigation/zoom actions with hub-aware commands. Unmodified legacy hub/cerberus mods are removed only when complete file sets and hashes match, ignoring app-generated root gpui-kit.d.ts/jsconfig.json. Modified and extra files are preserved.

## Watch out

Keep shipped names reserved. Install the helper on remote machines before using their usage cards. Never copy app-written settings/session state into this repository. Without providers or logins, cards display placeholders; without orch, pane names remain program names. With orch, moving an active run's tabs is guarded. Headless checks cannot verify actual installed geometry, clicks, or asynchronous provider updates. Choose cockpit manually after installation.

## Done when

`make test` and `herdr-app check` for all custom mods pass. An isolated HOME install yields valid `sys` and `panes` JSON without cr/orch data, excludes tests/editor metadata, and can be repeated. Before sharing a screenshot, review an installed layout with synthetic accounts and no personal machine/workspace names, check narrow-window scrolling, focus, folds, aliases, and machine switches, check interactive hub input, grid focus/zoom, source navigation, tab visibility and remote Heads with disposable synthetic terminals, and confirm provider updates with the user's own logins.
