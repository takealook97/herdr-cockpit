# Agent list

## Intent

Show top-level live agent sessions beside the workspace and avoid duplicating orch workers already visible in space-tree.

## What you see

A compact theme-aware list shows agent identity, status, activity, and nested live child sessions. Active orchestration heads can show worker totals and working counts. Vanilla sessions keep their normal agent presentation.

## How it behaves

Select an agent to focus its session; existing menus and session controls retain the shipped behavior. Closed or lost workers do not contribute to active working counts. A five-second helper poll updates the optional run index while retaining the last valid index on failures.

## Built from

`main.js` renders Herdr agent data. `orch.js` projects the helper's `panes` response into worker/head indexes, and `presentation.js` formats agent details. Calls use `$HOME/.local/bin/herdr-hud` through `sh`; no credentials or provider requests occur in this mod.

## Watch out

The list relies on Herdr agent/session APIs. With no active orch runs the worker index is empty. Remote metadata depends on the helper's local terminal/run view. Install under the custom name `agent-list`, never the shipped `agents` name.

## Done when

`node --test mods/agent-list/*.test.mjs` and `herdr-app check "$PWD/mods/agent-list"` pass. An installed-layout review confirms focus, session menus, status updates, worker hiding, and vanilla session visibility. A sanitized preview is pending.
