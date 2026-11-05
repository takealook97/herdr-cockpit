# Herdr Cockpit

A compact cockpit for Herdr.app: provider usage across the top, a machine/space/tab/pane tree on the left, and an agent list underneath. The standalone `herdr-hud` helper supplies system readings, usage, and terminal models. It works with ordinary CLI logins; cr and orch are optional.

Drag sibling tab rows to save their native Herdr order; the sidebar and Hub follow that order. When a remote machine is unavailable, the cockpit tab bar's close button hides the tab on this screen while keeping its machine registration and remote tasks. Remote spaces with all tabs hidden disappear from the tree. Right-click the remote machine and choose **Show hidden tabs** to restore them.

Screenshot placeholder: a sanitized preview will be added after an installed-layout review. No screenshot or personal app state is bundled.

## Requirements

- Herdr.app with custom layout/mod support and its `hc` command.
- macOS or Linux on arm64 or amd64, Bash, rsync, and Python 3 (for safe key merging).
- Go 1.27+ to build, or a trusted prebuilt helper at `bin/<os>-<arch>/herdr-hud` (for example `bin/darwin-arm64/herdr-hud`).
- The provider CLIs and your own logins for the usage cards you want: `codex`, `claude`, and `agy` for Gemini. Missing providers show placeholders.
- Node.js for development tests; Go for the optional remote installer.

## Install

```sh
make setup
./scripts/install.sh --dry-run
make install
```

The installer builds the helper and installs it at `$HOME/.local/bin/herdr-hud`. If Go is absent, it uses the matching prebuilt instead. It copies `layouts/cockpit.json`, `themes/{styx,asphodel,elysium}.json`, and `mods/{usage-bar,space-tree,agent-list,hub-head,cockpit-tabs,nexus}` into `${HERDR_APP_HOME:-$HOME/.config/herdr-app}`. On macOS with `swiftc` the installer also builds `herdr-listen` into `$HOME/.local/bin`; it is skipped otherwise and never fails the install. Tests, package metadata, and generated editor files are excluded. Shipped mod/layout names are reserved and rejected before any writes. Repeating the install updates only these custom assets and the helper, preserving excluded editor files; it preserves app state, settings, and the selected layout. It merges missing bindings from `keys/*.json` into `keys.json`, backing up an existing file first. Existing custom bindings win, including a conflicting Ctrl-Shift-H; built-in Cmd-Alt-arrow and Cmd-Shift-Enter actions migrate to hub-aware space-tree wrappers; the previous `cerberus.toggle` and `hub.toggle` bindings migrate to `space-tree.hub`. Old `hub`, `hub-bar`, `hub-cell`, `cerberus`, `cerberus-bar`, and `cerberus-cell` directories are removed only when their complete file set and contents match the previous install; app-generated `gpui-kit.d.ts` and `jsconfig.json` are ignored during comparison, while modified directories and other extra files are preserved. `--dry-run` previews this merge without writing. Malformed key files are rejected before installation. Different existing theme files are preserved unless `--force` is given.

Select **cockpit** in Herdr's layout chooser (**Ctrl-Shift-L**), or invoke `layout.switch cockpit`. Keep the shipped layouts available as a fallback.

The mods call `sh -c 'exec "$HOME/.local/bin/herdr-hud" "$@"' hud ...`, so the same configuration works on another machine without personal paths or PATH assumptions. Usage follows the active space's machine; the sidebar reads terminal metadata from the local helper.

To install only the helper on connected Herdr machines:

```sh
./scripts/remote-install.sh --dry-run [machine ...]
./scripts/remote-install.sh [machine ...]
```

Omit machine names to target all connected machines. This explicitly writes to those machines. The script cross-builds for each detected Darwin/Linux arm64/amd64 platform, uploads in 7 MB parts with `hc file write`, verifies the joined SHA-256 before installation, and checks `sys`. It does not install remote mods or change layouts.

## nexus

NEXUS is the locked top row above hub under **This computer**. Click it, press **Cmd-Shift-N** (or **Ctrl-Shift-N**), or press **Ctrl-Shift-Space** (opens and starts listening) from any tab of the cockpit layout to open a dimmed, centered dialog. The same shortcut closes it. It works only in the cockpit layout, because the space-tree mod receives the bindings.

Each command is routed by one stateless model call that sees only the local Head roster (space · tab, folder, status, model, last report line), the last 6 Nexus log entries and the command, so context never grows; the default key measured about 1.2k input tokens per call. Nexus sends with `hc send` only to a validated local Head (no remote Heads, workers or observers). When the target is ambiguous or confidence is below 0.6 it asks, with candidate chips. Status questions are answered by reading at most the last 40 screen lines of that Head, with one extra summary call. After a send the dialog closes; with hub open the target Head is focused, otherwise a toast links to it.

Model: the `HERDR_NEXUS_MODEL` environment variable, or `${XDG_CONFIG_HOME:-~/.config}/herdr-hud/nexus.json` with `{"model":"<key>"}`; the default is `claude-medium-m`. It accepts orch catalog keys of the Claude or Codex families. The CLI runs without user settings, MCP servers, tools or slash commands. A failure or the 20 s timeout sends nothing.

Voice is macOS only, with on-device ko-KR speech recognition through `herdr-listen`. Five dots follow the input level and partial text fills the input. 1.2 s of silence ends listening, and the text is sent after a 1.5 s countdown that Esc or editing cancels. It requires System Settings > Keyboard > Dictation to be enabled and microphone/speech permission for Herdr. Without `herdr-listen` the mic button is hidden.

## hub

Click **hub**, the locked section under **This computer**, or press **Ctrl-Shift-H** to show your Head terminals inside the cockpit layout. Click the header to open; click a Head row to open and focus that terminal. Ctrl-Shift-H toggles back to normal work. Selecting a space, tab or pane in the tree also closes hub. The normal tab bar stays hidden while hub is open.

Herdr renders the original interactive terminals in native-style cards, with a program icon, source tab/space name, dim cwd and a **Go to source** button. Input goes directly to the Head. The grid uses one row for one or two Heads, and two rows for larger sets, with `ceil(count / rows)` columns. Empty hub shows a placeholder. There is no hub space, observer process or managed terminal to create or kill. Existing spaces from an earlier version remain yours to remove manually.

**Cmd-Alt-arrow** moves between neighboring hub cells; **Cmd-Shift-Enter** toggles the focused cell to a full hub view and back. Outside hub these shortcuts call the original `pane.go` and `pane.zoom` commands. **Cmd-[ / Cmd-]** retain their built-in agent navigation. The installer adds missing bindings and rewrites only exact built-in values, preserving custom shortcuts and backing up keys first.

Hub shows eligible Heads across all spaces and tabs on the current PC. Remote Heads never appear, even when a remote space is selected. Heads exclude orch workers and legacy observers. Space-tree polls each machine's helper every three seconds for sidebar metadata and rebuilds changed grid membership after a 500 ms debounce. Failed polls retain the last known metadata. Hub requires cockpit's `work-stack` layout and uses the Herdr CLI to write the grid, avoiding the mod host's argument nesting limit.

## Themes

`themes/` ships three Herdr themes: `styx` (very dark blue-black), `asphodel` (muted grey-green dark) and `elysium` (warm paper light with a soft gold accent). `scripts/install.sh` copies them into the app's `themes/` folder, refusing to overwrite a different file of the same name unless `--force` is given. Pick one from the theme menu, with `app.theme {name}`, or set a layout's root `theme`. Contrast ratios and details are in [themes/README.md](themes/README.md).

## Data collection

Successful subcommands emit JSON. Operational failures are represented by bounded errors so the UI can show placeholders or stale readings.

```sh
herdr-hud sys
herdr-hud panes
herdr-hud usage --selected --max-age 120s
herdr-hud usage --terminals t1,t2 --max-age 120s
herdr-hud usage --refresh
herdr-hud nexus route --text TEXT --roster ROSTER_JSON
herdr-hud nexus send --to ADDRESS --text MESSAGE --roster ROSTER_JSON
herdr-hud nexus log [--limit N]
herdr-hud nexus listen start|stop|status
```

The `nexus` subcommands back the Nexus dialog: `route` and `send` call the configured model and `hc send`, `log` reads the local command log, and `listen` controls `herdr-listen`.

`sys` measures CPU tick deltas and memory using gopsutil plus `vm_stat` on macOS or `/proc/meminfo` on Linux. Cache files live only in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud`; cache directories/files use private permissions.

`usage` reads Codex rate limits through `codex app-server`, Claude usage through its OAuth usage endpoint using the existing macOS keychain or credential file, and Gemini usage through `agy -p /usage`. It does not redeem credits. Provider backoff and minimum refresh floors apply, including 120 seconds for Claude and 300 seconds for Gemini. `--refresh` still respects provider floors and retry backoff.

With no cr registry, `usage` and `usage --selected` use ordinary homes (`~/.codex`, the default Claude login, and agy's own login). With a cr registry (`${CR_HOME:-$HOME/.local/share/cr}/registry.json`), `--selected` follows its current account-selection rules. An intentionally empty registry stays empty. `--terminals` identifies local terminal processes and their account homes, excludes remote addresses, and treats an explicit empty terminal list as empty; Gemini remains a machine-wide source.

`panes` reads `hc ls/get` for agent programs and launch model/effort. Without orch run files, `runs` is empty and terminals still appear; panes retain program names rather than acquiring head labels. If `${ORCH_HOME:-$HOME/.orch}/runs/*/run.json` exists, active runs add worker roles and head labels. Worker models come from `orch models --json` when available, cached once per helper process; otherwise the raw worker key is shown. Live Claude model/effort comes from that process's `sessions/<pid>.json` and a bounded transcript tail. For local Codex terminals, live model/effort metadata from the native process’s single open `rollout-*.jsonl` overrides launch argv and matching worker catalog values, preserving exact model IDs (including Astra). Only complete `turn_context` records in a bounded 4 MiB tail are used; a `/model` change may remain invisible until the next turn records that context. A bounded metadata-only `codex-models.json` cache (at most 256 entries) tracks PID, session path, file identity, size and modification time; unchanged sessions reuse it, and growing sessions retain verified metadata when it falls outside the tail. Ambiguous or unavailable process/session information leaves launch/catalog fallbacks intact. These integrations are read-only and no orch code is linked into the helper.

The usage bar polls system readings every second and selected-account usage every minute (`--max-age 45s`). Machine switches and agent completion trigger debounced reads. The space tree and agent list poll pane metadata every three seconds. See each mod's recipe for UI behavior.

## Privacy

There is no hosted collector or telemetry. Data is gathered and cached on the machine where the helper runs. Usage queries contact provider services only through your own existing logins; the mods receive JSON, never credentials. Account labels, paths, usage, model names, and terminal addresses may appear in local JSON/cache files. Claude and Codex transcript inspection emits no message contents; Codex reads only `turn_context` model/effort metadata from its bounded tail. The hub renders interactive terminal content inside the local layout. Herdr persists the grid layout and Head metadata in shared mod state. Hub does not save terminal screens or message text. Nexus sends the Head roster, the last 6 log entries and your command to the configured model provider through your own CLI login. It stores up to 50 command entries (text, target, reply) locally in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud/nexus-log.json` with private permissions. Voice audio is recognized on device and not stored. Review screenshots before sharing them.

## Develop

```sh
make build
make test
herdr-app check "$PWD/mods/usage-bar"
herdr-app check "$PWD/mods/space-tree"
herdr-app check "$PWD/mods/agent-list"
herdr-app check "$PWD/mods/hub-head"
```

`make setup` enables the tracked commit-message hook: English `type: imperative summary`, up to 72 characters, without a trailing period. Tests use synthetic fixtures and fake commands, with no provider network requests or personal app state.

## Uninstall

Switch to a shipped layout first. Remove only the installed `layouts/cockpit.json`, `themes/{styx,asphodel,elysium}.json`, `mods/usage-bar`, `mods/space-tree`, `mods/agent-list`, `mods/cockpit-tabs`, and `mods/hub*` from your Herdr app home, plus `$HOME/.local/bin/herdr-hud`. Optionally remove `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud`. Remove `global.ctrl-shift-h` from `keys.json` only if it still points to `space-tree.hub`; keep any replacement shortcut. Restore only bindings that still point to the installed wrappers:

| Key | Installed wrapper | Restore built-in |
| --- | --- | --- |
| `cmd-alt-left` | `space-tree.go-left` | `pane.go:left` |
| `cmd-alt-right` | `space-tree.go-right` | `pane.go:right` |
| `cmd-alt-up` | `space-tree.go-up` | `pane.go:up` |
| `cmd-alt-down` | `space-tree.go-down` | `pane.go:down` |
| `cmd-shift-enter` | `space-tree.zoom` | `pane.zoom` |

Keep any custom replacement binding. On remote machines remove the helper there as well. Your provider logins, cr/orch data, and other Herdr settings stay in place.

MIT licensed; see [LICENSE](LICENSE).
