# Nexus

An overlay-only dialog (`place: none`) that sends one typed or spoken line to a Head. Space tree opens it from the NEXUS row, Cmd-Shift-N (`space-tree.nexus`) or Ctrl-Shift-Space (`space-tree.nexus-listen`, starts listening); the same command closes it. It sets `shared("nexus.open")` while open and `shared("nexus.last")` = `{label, at}` after a send.

The dialog shows the last 6 log entries (`> text`, `→ Head`, `? question`, `· summary`, `! error`), ask-candidate chips, five level dots and a mic button (hidden when listening is unavailable). Enter sends. A spoken final text waits 1.5 s before sending; typing or Esc cancels it, and Esc also stops listening without closing the dialog. After a send the dialog closes and focuses the Head (hub open) or toasts with a focus action.

Helper calls, all through `herdr-hud nexus` (see `model.js` `helperArgs`): `route --text --roster`, `send --to --text --roster`, `log --limit 6`, `listen start|stop|status` (polled every 120 ms only while listening). The roster comes from `shared("hub.heads")`, `panes()` and `terminals()`.

Tests: `node --test mods/nexus/*.test.mjs` covers roster, log lines, reply parsing, dot heights and argv. Run `herdr-app check "$PWD/mods/nexus"`. Microphone capture and real sends need an interactive check.
