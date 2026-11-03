# Herdr Cockpit

A compact cockpit for Herdr.app: provider usage across the top, a machine/space/tab/pane tree on the left, and an agent list underneath. The standalone `herdr-hud` helper supplies system readings, usage, and terminal models. It works with ordinary CLI logins; cr and orch are optional.

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

The installer builds the helper and installs it at `$HOME/.local/bin/herdr-hud`. If Go is absent, it uses the matching prebuilt instead. It copies `layouts/cockpit.json`, `themes/{styx,asphodel,elysium}.json`, and `mods/{usage-bar,space-tree,agent-list,cerberus,cerberus-bar,cerberus-cell}` into `${HERDR_APP_HOME:-$HOME/.config/herdr-app}`. Tests, package metadata, and generated editor files are excluded. Shipped mod/layout names are reserved and rejected before any writes. Repeating the install updates only these custom assets and the helper, preserving excluded editor files; it preserves app state, settings, and the selected layout. It merges missing bindings from `keys/*.json` into `keys.json`, backing up an existing file first. Existing bindings always win, including a conflicting Ctrl-Shift-H. `--dry-run` previews this merge without writing. Malformed key files are rejected before installation. Different existing theme files are preserved unless `--force` is given.

Select **cockpit** in Herdr's layout chooser (**Ctrl-Shift-L**), or invoke `layout.switch cockpit`. Keep the shipped layouts available as a fallback.

The mods call `sh -c 'exec "$HOME/.local/bin/herdr-hud" "$@"' hud ...`, so the same configuration works on another machine without personal paths or PATH assumptions. Usage follows the active space's machine; the sidebar reads terminal metadata from the local helper.

To install only the helper on connected Herdr machines:

```sh
./scripts/remote-install.sh --dry-run [machine ...]
./scripts/remote-install.sh [machine ...]
```

Omit machine names to target all connected machines. This explicitly writes to those machines. The script cross-builds for each detected Darwin/Linux arm64/amd64 platform, uploads in 7 MB parts with `hc file write`, verifies the joined SHA-256 before installation, and checks `sys`. It does not install remote mods or change layouts.

## cerberus: Head hub

Click the pinned **cerberus** row at the top of space-tree, or press **Ctrl-Shift-H**, to toggle a live Head hub over the current tab. It shows agent terminals excluding orch workers, ordered by space then tab index. Each cell uses the existing terminal and PTY: typing there reaches that agent directly. Click its tab name to select the source space/tab; click ↗ to give it two thirds of the view and stack the rest alongside. The × button closes the hub.

One to three Heads share a row, four use 2×2, five to six use three columns and two rows, and seven to nine use three columns and three rows. Larger sets have page controls; chips and broadcast selection cover all pages. Blocked Heads have a colored border. Changes to the Head set rebuild the window after a one-second debounce, using a named window to preserve placement. **A rebuild clears an unsent composer draft**, so finish messages before changing the grid or focus mode. Rebuilds and close requests wait for an active broadcast to complete.

The header chips toggle broadcast recipients; all Heads start included. Type in the composer and press Enter or Send. For multiple recipients, the first submit arms **Confirm N**, and a second submit sends to that exact selection. Editing text, toggling a chip, or pressing Esc cancels confirmation. Sending uses `hc send <address> <text>`, which pastes the text and presses Enter; it does not force past a blocked prompt. A partial failure identifies failed tabs and leaves the draft; retry individually to avoid duplicate messages to successful recipients.

The controller polls the local helper and each connected machine's helper every three seconds. Install `herdr-hud` on remote machines for their Heads to appear. Missing or incomplete helper data retains known cells and pauses broadcast until metadata recovers. The pinned count and cell headers keep updating while the hub is closed or open. Selection exclusions persist through Herdr's shared mod state; new Heads are included by default.

`layouts/cockpit.json` includes a zero-height `cerberus` controller block because Herdr delivers mod commands only to shown mod copies. For another custom layout, include that controller block as well as the desired entry point. `mod.open {name: "cerberus"}` forwards to the resident controller.

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
```

`sys` measures CPU tick deltas and memory using gopsutil plus `vm_stat` on macOS or `/proc/meminfo` on Linux. Cache files live only in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud`; cache directories/files use private permissions.

`usage` reads Codex rate limits through `codex app-server`, Claude usage through its OAuth usage endpoint using the existing macOS keychain or credential file, and Gemini usage through `agy -p /usage`. It does not redeem credits. Provider backoff and minimum refresh floors apply, including 120 seconds for Claude and 300 seconds for Gemini. `--refresh` still respects provider floors and retry backoff.

With no cr registry, `usage` and `usage --selected` use ordinary homes (`~/.codex`, the default Claude login, and agy's own login). With a cr registry (`${CR_HOME:-$HOME/.local/share/cr}/registry.json`), `--selected` follows its current account-selection rules. An intentionally empty registry stays empty. `--terminals` identifies local terminal processes and their account homes, excludes remote addresses, and treats an explicit empty terminal list as empty; Gemini remains a machine-wide source.

`panes` reads `hc ls/get` for agent programs and launch model/effort. Without orch run files, `runs` is empty and terminals still appear; panes retain program names rather than acquiring head labels. If `${ORCH_HOME:-$HOME/.orch}/runs/*/run.json` exists, active runs add worker roles and head labels. Worker models come from `orch models --json` when available, cached once per helper process; otherwise the raw worker key is shown. Live Claude model/effort comes from that process's `sessions/<pid>.json` and a bounded transcript tail. These integrations are read-only and no orch code is linked into the helper.

The usage bar polls system readings every second and selected-account usage every minute (`--max-age 45s`). Machine switches and agent completion trigger debounced reads. The space tree and agent list poll pane metadata every three seconds. See each mod's recipe for UI behavior.

## Privacy

There is no hosted collector or telemetry. Data is gathered and cached on the machine where the helper runs. Usage queries contact provider services only through your own existing logins; the mods receive JSON, never credentials. Account labels, paths, usage, model names, and terminal addresses may appear in local JSON/cache files. Claude transcript inspection reads only model/effort metadata from a bounded tail and emits no message contents. The cerberus hub displays live terminal content locally; broadcast sends only the text you submit to the selected terminal addresses. The mod does not save message text or terminal screens. Herdr persists Head metadata, selection exclusions, focus, and page state through its shared mod state. Terminal programs may retain messages as part of their own histories. Review screenshots before sharing them.

## Develop

```sh
make build
make test
herdr-app check "$PWD/mods/usage-bar"
herdr-app check "$PWD/mods/space-tree"
herdr-app check "$PWD/mods/agent-list"
for mod in cerberus cerberus-bar cerberus-cell; do
  herdr-app check "$PWD/mods/$mod"
done
```

`make setup` enables the tracked commit-message hook: English `type: imperative summary`, up to 72 characters, without a trailing period. Tests use synthetic fixtures and fake commands, with no provider network requests or personal app state.

## Uninstall

Switch to a shipped layout first. Remove only the installed `layouts/cockpit.json`, `themes/{styx,asphodel,elysium}.json`, `mods/usage-bar`, `mods/space-tree`, `mods/agent-list`, and `mods/cerberus*` from your Herdr app home, plus `$HOME/.local/bin/herdr-hud`. Optionally remove `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud`. Remove `global.ctrl-shift-h` from `keys.json` only if it still points to `cerberus.toggle`; keep any replacement shortcut. On remote machines remove the helper there as well. Your provider logins, cr/orch data, and other Herdr settings stay in place.

MIT licensed; see [LICENSE](LICENSE).
