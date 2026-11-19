# Usage bar

## Intent

Keep selected-provider capacity, Linear assignments, and host load accessible in a compact top row. The standalone helper handles credentials and requests.

## What you see

A 44 px row holds 38 px cards. Codex, Claude, and Gemini sit on the left. Linear, CPU/RAM, and the gear sit on the right in that order. Provider cards show weekly usage and reset time. Codex and Claude also show available reset credits and expiry. CPU and RAM each have fixed columns for percentage, a 32 px mini bar, and memory detail. Usage colors change at 50% and 80%. Width estimates include the visible cards. At narrower widths the bar hides mini bars, then account lines, and clips provider cards inside their own region.

The Linear button appears only on machines with a confirmed or expired connection and is hidden elsewhere, where the settings popup still offers connection controls. The button shows the open assigned issue count and a dot if an issue is blocked or overdue. An accent border and tooltip flag issues newly assigned since the dropdown was last opened. Opening the dropdown clears the border and marks those rows with an accent dot for the session. The dropdown groups issues into Blocked, In Progress, Todo, Backlog, and Triage, in that order. Within each group, issues are ordered by earliest due date, highest priority, and most recent update. Rows show the identifier, title, short project name, priority, and due date badge. The gear stays visible and opens the settings popup with five visibility switches and Linear connection controls.

## How it behaves

The active space selects the machine. Provider cards use `usage --selected`, following cr selection rules when a registry exists and default CLI logins otherwise. Clicking a card requests a refresh; credits are never redeemed. Calendar labels follow local time, including DST. System readings refresh every second; usage refreshes every minute with `--max-age 45s`. Machine switches debounce a read by 300 ms, and agent completion by two seconds. Per-machine readings remain available when switching back. A failed process/JSON read clears that response to placeholders; partial provider failures retain matching prior windows with dim styling. Obsolete machine responses cannot overwrite another machine's display. System polls redraw only when a displayed number changes.

Linear follows the active space's machine and uses no AI tokens. A machine switch clears the bar's Linear snapshot and reloads status and issues when the Linear switch is on. The bar polls issues every 30 minutes while the switch is on. While the connection is unknown, the bar re-checks status every minute. Both popups keep the machine selected when they open. The dropdown fetches issues if the cache is older than one minute. Refresh requests an immediate fetch. Clicking a row expands its details inline. Detail responses are cached for 60 seconds in the popup and cleared on refresh or account change. A fetch error dims any stale issues returned for the current credential. Each connect or disconnect attempt invalidates every view's saved issues and connection status. The settings popup saves card visibility, shows connection status and the remote machine name, and accepts a key through a masked input. Disconnect is available for a saved API key. Esc closes either popup.

The Linear switch requires a confirmed connection on the active machine to turn on and can always turn off. A successful API key connection reveals the Linear button if the target machine is still active.

## Built from

`main.js` exports a `View`. `ui.js` builds cards and `panels.js` builds the two popups. `linear-detail.js` manages inline expansion and its in-memory cache. `format.js`, `prefs.js`, and `linear.js` handle formatting, visibility, and issue grouping. Herdr exec runs `herdr-hud sys` and `herdr-hud usage` on the active machine and routes Linear commands to the bar or popup's target machine. Shared state persists visibility, Linear revisions, the machine of the last credential change, and seen lists. The opening revision lets the bar reuse the issue cache without fetching connection status again. Each seen list stores an account identifier and its open issue identifiers locally, up to eight accounts in order of their last seen-list update. `mod.json` uses `place: none`, and the cockpit layout supplies the 44 px block.

## Watch out

Install or update the helper on each machine where you view usage or Linear. Use `scripts/remote-install.sh` for remote machines. Missing CLIs/logins produce placeholders or bounded provider errors. Claude's 120 second and Gemini's 300 second floors still apply to click refreshes. Only account local parts appear in the UI, but helper JSON/cache can contain local paths and account metadata. GPUI initial-description checks do not verify later asynchronous geometry or narrow-window behavior.

Connecting sends the API key to the target machine through Herdr exec. The helper on that machine saves a validated key in the macOS keychain under `herdr-hud-linear` or in `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-hud/linear.json` with mode 0600 on other platforms. It reads that machine's Claude Code Linear MCP token without refreshing or updating it. Issues are cached privately per credential generation. While connecting, the key briefly appears in the target helper's process arguments and in the macOS keychain command's arguments. Manual runs can also leave the key in shell history.

## Done when

`node --test mods/usage-bar/*.test.mjs` and `herdr-app check "$PWD/mods/usage-bar"` pass. Tests cover provider polling, machine switching, responsive widths, the settings switches, popup commands and placement, issue grouping, DST, error states, and out-of-order responses. An installed-layout review checks popup sizing, narrow windows, switches, links, and live updates.
