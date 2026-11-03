# Cockpit

## Intent

Keep provider capacity, active work, and machine navigation visible around a large terminal workspace. Vanilla CLI sessions work without cr or orch; orchestration labels appear only when active run metadata exists.

## What you see

A full-height left sidebar divides space-tree and agent-list in a 3:1 ratio. A compact 44 px usage row sits above tabs. The central workspace has padded, rounded terminal panes with persistent pane headers and focus borders. A hidden right panel hosts the shipped files/changes views, and the shipped workspace status sits at the bottom. All colors use the current theme. A sanitized screenshot is pending; no personal preview is included.

## How it behaves

Space-tree navigates machines, repositories, worktrees, tabs, and panes, with persistent folds, display aliases, keyboard navigation, and guarded tab moves. Agent-list opens agent sessions while hiding known orch worker duplicates. Usage follows the active machine and shows Codex, Claude, Gemini, CPU, and memory; selecting a card requests a refresh. Polling and provider backoff belong to the helper and mods. The layout itself contains no commands or account data.

## Built from

`layouts/cockpit.json` composes the custom `usage-bar`, `space-tree`, and `agent-list` mods with shipped `tabs`, `pane`, `files`, `changes`, and `workspace-status`. Each custom mod calls the standalone `$HOME/.local/bin/herdr-hud` using `exec` and the existing JSON contracts (`sys`, `usage --selected`, `panes`). `scripts/install.sh` builds/installs the helper and copies only custom assets. Individual mod recipes document rendering, interactions, and refresh details.

## Watch out

Keep shipped names reserved. Install the helper on remote machines before using their usage cards. Never copy app-written settings/session state into this repository. Without providers or logins, cards display placeholders; without orch, pane names remain program names. With orch, moving an active run's tabs is guarded. Headless checks cannot verify actual installed geometry, clicks, or asynchronous provider updates. Choose cockpit manually after installation.

## Done when

`make test` and `herdr-app check` for all three mods pass. An isolated HOME install yields valid `sys` and `panes` JSON without cr/orch data, excludes tests/editor metadata, and can be repeated. Before sharing a screenshot, review an installed layout with synthetic accounts and no personal machine/workspace names, check narrow-window scrolling, focus, folds, aliases, and machine switches, and confirm provider updates with the user's own logins.
