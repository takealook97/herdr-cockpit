# Cockpit

## Intent

Keep provider capacity, active work, and machine navigation visible around a large terminal workspace. Vanilla CLI sessions work without cr or orch; orchestration labels appear only when active run metadata exists.

## What you see

A full-height left sidebar divides space-tree and agent-list in a 3:1 ratio. A compact 44 px usage row sits above tabs. The central workspace has padded, rounded terminal panes with persistent pane headers and focus borders. A hidden right panel hosts the shipped files/changes views, and the shipped workspace status sits at the bottom. All colors use the current theme. A sanitized screenshot is pending; no personal preview is included.

## How it behaves

Space-tree navigates machines, repositories, worktrees, tabs, and panes, with 2 px colored section rails (no letter avatars), 4 px section gaps, persistent folds, display aliases, keyboard navigation, and guarded tab moves. A pinned cerberus row shows Head count and aggregate status and toggles the Head hub. Agent-list opens agent sessions while hiding known orch worker duplicates. Usage follows the active machine and shows Codex, Claude, Gemini, CPU, and memory; selecting a card requests a refresh. Polling and provider backoff belong to the helper and mods. A zero-height controller block receives `cerberus.toggle` (Ctrl-Shift-H). The named overlay has a 44 px broadcast bar above live terminal cells with 26 px headers. It uses one row for up to three Heads, 2×2 for four, three columns for five to nine, and pages after nine. Expand focuses one Head at two-thirds width. Broadcast chips select recipients across every page; sending to multiple Heads requires a second confirmation. Text is passed literally to `hc send`, never interpolated into shell code. The controller rebuilds changed head sets after one second while open, retaining named-window placement and waiting for active sends. Unsent composer text is cleared on rebuild. The layout contains no account data.

## Built from

`layouts/cockpit.json` composes the custom `usage-bar`, `space-tree`, `agent-list`, `cerberus`, `cerberus-bar`, and `cerberus-cell` mods with shipped `tabs`, `pane`, `files`, `changes`, and `workspace-status`. Each custom mod calls the standalone `$HOME/.local/bin/herdr-hud` using `exec` and the existing JSON contracts (`sys`, `usage --selected`, `panes`). `scripts/install.sh` builds/installs the helper and copies custom assets, and merges missing key bindings with an original-file backup. Existing keys win. Each remote machine supplies its own agent/worker metadata, qualified with its full machine prefix. The mod sandbox forbids cross-directory imports, so cerberus and cerberus-bar carry identical pure model helpers; a test prevents drift. Individual mod recipes document rendering, interactions, and refresh details.

## Watch out

Keep shipped names reserved. Install the helper on remote machines before using their usage cards. Never copy app-written settings/session state into this repository. Without providers or logins, cards display placeholders; without orch, pane names remain program names. With orch, moving an active run's tabs is guarded. Headless checks cannot verify actual installed geometry, clicks, or asynchronous provider updates. Choose cockpit manually after installation.

## Done when

`make test` and `herdr-app check` for all six mods pass. An isolated HOME install yields valid `sys` and `panes` JSON without cr/orch data, excludes tests/editor metadata, and can be repeated. Before sharing a screenshot, review an installed layout with synthetic accounts and no personal machine/workspace names, check narrow-window scrolling, focus, folds, aliases, and machine switches, check cerberus commands, source navigation, named-window placement, focus, paging and broadcast with disposable synthetic terminals, and confirm provider updates with the user's own logins.
