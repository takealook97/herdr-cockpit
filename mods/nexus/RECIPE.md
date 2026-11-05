# Nexus

An overlay-only compact bar (`place: none`, dialog 560×120) that throws one typed or spoken line at a Head. Space tree opens it from the NEXUS row, Cmd-Shift-N (`space-tree.nexus`) or Cmd-Shift-Space (`space-tree.nexus-listen`, starts listening); the same command closes it. It sets `shared("nexus.open")` while open and `shared("nexus.last")` = `{label, at}` after a send. Nexus never answers: there is no log list and no read action.

Row 1 is the live text input (partial transcript fills it), five level dots and a mic button (hidden when listening is unavailable). Row 2 is one dim status line: `듣는 중`, `판단 중` (with the pending dots, the submitted text stays in the input), `1초 뒤 보냄 · Esc 취소`, `? question` plus candidate chips, `· 명령으로 들리지 않아 넘겼습니다`, `· 말을 알아듣지 못했습니다` (listening ended with no text) or `! error`. Enter sends. A spoken final text waits 1 s before sending; typing or Esc cancels it, and Esc also stops listening without closing the bar.

After a send the bar closes without a toast and jumps to the Head: hub open -> `pane.focus` only; otherwise `space.select`, `tab.select`, `pane.focus` using the `space`/`tab` ids of the matching entry in `shared("hub.heads")` (no entry -> `pane.focus` alone). A reply `warning` still toasts.

Helper calls, all through `herdr-hud nexus` (see `model.js` `helperArgs`): `route --text --roster`, `send --to --text --roster`, `listen start [--hints a,b]|stop|status` (polled every 120 ms only while listening). Hints are the unique non-empty space and tab names of `shared("hub.heads")` (`hintsFrom`). The roster comes from `shared("hub.heads")`, `panes()` and `terminals()`.

Tests: `node --test mods/nexus/*.test.mjs` covers roster, hints, reply parsing, dot heights, argv, navigation and the status line. Run `herdr-app check "$PWD/mods/nexus"`. Microphone capture and real sends need an interactive check.
