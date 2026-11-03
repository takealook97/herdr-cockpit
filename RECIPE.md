# Cockpit

## Intent

Keep provider capacity, active work, and machine navigation visible around a large terminal workspace. Vanilla CLI sessions work without cr or orch; orchestration labels appear only when active run metadata exists.

## What you see

A full-height left sidebar divides space-tree and agent-list in a 3:1 ratio. A compact 44 px usage row sits above tabs. The central workspace has padded, rounded terminal panes with persistent pane headers and focus borders. A hidden right panel hosts the shipped files/changes views, and the shipped workspace status sits at the bottom. All colors use the current theme. A sanitized screenshot is pending; no personal preview is included.

## How it behaves

Space-tree navigates machines, repositories, worktrees, tabs, and panes, with colored section rails, persistent folds, aliases, keyboard navigation and guarded tab moves. The hub row is first under This computer and opens a real space lazily. Its native panes run `hc attach --observe --history 2000` against local and remote Head terminals. Input is disabled in these mirrors. Native pane shortcuts, zoom and resizing remain available. Ctrl-Shift-H opens hub or returns to the previous space. Observer pane names show the source tab and space, with its model alongside. The count excludes observers and orch workers. Agent-list opens agent sessions; usage follows the active machine.

## Built from

`layouts/cockpit.json` composes the custom `usage-bar`, `space-tree`, and `agent-list` mods with shipped `tabs`, `pane`, `files`, `changes`, and `workspace-status`. The work column contains usage, tabs, work-body and status. Space-tree's `hub.js` reconciles a single hub tab against helper Head metadata; `hub-model.js` supplies pure planning and observer detection. Only observers in that hub tab can be removed. The seed shell is removed once a surviving observer exists. Failed helper polls pause reconciliation. The helper runs on each machine, with full remote address qualification.

`scripts/install.sh` installs custom assets and the helper, merges missing key bindings with a backup, and migrates old hub shortcuts. Unmodified legacy hub/cerberus mods are removed only when complete file sets and hashes match, ignoring app-generated root gpui-kit.d.ts/jsconfig.json. Modified and extra files are preserved.

## Watch out

Keep shipped names reserved. Install the helper on remote machines before using their usage cards. Never copy app-written settings/session state into this repository. Without providers or logins, cards display placeholders; without orch, pane names remain program names. With orch, moving an active run's tabs is guarded. Headless checks cannot verify actual installed geometry, clicks, or asynchronous provider updates. Choose cockpit manually after installation.

## Done when

`make test` and `herdr-app check` for all three mods pass. An isolated HOME install yields valid `sys` and `panes` JSON without cr/orch data, excludes tests/editor metadata, and can be repeated. Before sharing a screenshot, review an installed layout with synthetic accounts and no personal machine/workspace names, check narrow-window scrolling, focus, folds, aliases, and machine switches, check hub lazy creation, previous-space toggling, read-only mirrors, remote Heads and native pane shortcuts with disposable synthetic terminals, and confirm provider updates with the user's own logins.
