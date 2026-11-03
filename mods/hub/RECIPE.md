# hub controller

A resident zero-height block in cockpit receives hub.toggle/close. Poll each machine's local herdr-hud panes every three seconds, qualify remote addresses without truncating machine prefixes, exclude workers, and publish ordered Head metadata. Never infer workers from tab names. Retain stale snapshots and pause broadcasts when any helper is unavailable.

Select work-stack's hub-view to show the 44 px hub-bar and live Head grid in the work area. Select work-normal to return to the tabs and work-body, including its files/changes panel. Debounce structural, focus, page and blocked-border changes for one second while open; ordinary status changes update headers in place. Clone layout() and replace only hub-grid children, preserving other nodes and the mounted bar/composer. Equal grid children skip layout.set. Wait for broadcasts before rebuilding or closing on request. Missing work-stack leaves the layout untouched and reports unavailability. Model helpers are copied byte-for-byte into hub-bar because Herdr isolates mod imports; tests enforce equality.

Verify with synthetic app state and helper responses. Live installation, geometry, command delivery to the zero-height block, and PTY input need an authorized interactive check.
