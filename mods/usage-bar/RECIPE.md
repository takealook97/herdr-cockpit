# Usage bar

## Intent

Keep selected-provider capacity and host load visible in a compact top row, with all authentication and provider requests isolated in the standalone helper.

## What you see

A 44 px row has 12 px outer padding and 8 px gaps. Three 38 px provider cards sit on the left, ordered Codex, Claude, Gemini; CPU/RAM sit on the right. Cards have a raised theme background, border, and 6 px radius. Provider names use 12 px text and account local parts use 10.5 px text. Gemini omits its account line. Cards show weekly usage and a reset detail, without 5h/Week labels; Codex and Claude add available reset credits and expiry (Claude Limit resets). Missing values show an em dash. CPU and RAM each have fixed columns for percentage, a 32 px mini bar, and memory detail. Usage colors change at 50% and 80%. Responsive width calculation hides bars, then account lines, then reset details as space tightens. A sanitized preview is pending.

## How it behaves

The active space selects the machine. Provider cards use `usage --selected`, following cr selection rules when a registry exists and default CLI logins otherwise. Clicking a card requests a refresh; credits are never redeemed. Calendar labels follow local time, including DST. System readings refresh every second; usage refreshes every minute with `--max-age 45s`. Machine switches debounce a read by 300 ms, and agent completion by two seconds. Per-machine readings remain available when switching back. A failed process/JSON read clears that response to placeholders; partial provider failures retain matching prior windows with dim styling. Obsolete machine responses cannot overwrite another machine's display. System polls redraw only when a displayed number changes.

## Built from

`main.js` exports a `View`, `ui.js` builds GPUI card elements, and `format.js` owns pure formatting, account selection, responsive sizing, and portable command arguments. The mod reads `spaces()`, `agents()`, and `theme()` and calls `herdr-hud sys|usage` through `exec`, with `{on: machine || undefined}`. Provider auth, cache floors, retry backoff, and network requests stay inside the helper. `mod.json` uses `place: none`; the cockpit layout supplies the 44 px block. Timers use `cx.timer` and async work uses `cx.spawn`.

## Watch out

Install the helper on each machine whose usage you view. Missing CLIs/logins produce placeholders or bounded provider errors. Claude's 120 second and Gemini's 300 second floors still apply to click refreshes. Only account local parts appear in the UI, but helper JSON/cache can contain local paths and account metadata. GPUI initial-description checks do not verify later asynchronous geometry or narrow-window behavior.

## Done when

`node --test mods/usage-bar/*.test.mjs` and `herdr-app check "$PWD/mods/usage-bar"` pass. Tests cover helper argv, polling, selected accounts, machine switches, debounce, failures, responsive card descriptions, expiry/reset formatting, timezone/DST, and per-account stale retention. An installed-layout review checks spacing, narrow windows, clicking, remote switching, and live updates with the user's own logins before publishing a sanitized screenshot.
