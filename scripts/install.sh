#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
app=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
dry_run=false
case "${1:-}" in
    --dry-run) dry_run=true; shift ;;
    --help|-h) echo 'Usage: scripts/install.sh [--dry-run]'; exit 0 ;;
esac
[ "$#" -eq 0 ] || { echo 'Unknown arguments' >&2; exit 2; }
# Validate all names and destinations before building or writing anything.
for mod in "$root"/mods/*; do
    [ -d "$mod" ] || continue
    name=${mod##*/}
    case "$name" in spaces|agents|tabs|menu|prompt|toast|help|confirm|files|changes|peek|picker|pane|worktree|workspace-chrome|workspace-status|new-menu|terminals-bar|terminals-pane|win98|machine-add)
        echo "Refusing shipped mod: $name" >&2; exit 1 ;; esac
    [ ! -L "$mod" ] && [ ! -L "$app/mods/$name" ] || { echo 'Refusing symlink mod directory' >&2; exit 1; }
done
for layout in "$root"/layouts/*.json; do
    [ -f "$layout" ] || continue
    name=${layout##*/}
    case "$name" in main.json|terminals.json|win98.json)
        echo "Refusing shipped layout: $name" >&2; exit 1 ;; esac
    [ ! -L "$app/layouts/$name" ] || { echo 'Refusing symlink layout' >&2; exit 1; }
done
command -v python3 >/dev/null || { echo 'Python 3 is required to merge key snippets' >&2; exit 1; }
[ ! -L "$app/keys.json" ] || { echo 'Refusing symlink keys.json' >&2; exit 1; }
merge_keys() {
    python3 - "$root/keys" "$app/keys.json" "$1" <<'PYKEYS'
import glob, json, os, shutil, stat, sys, tempfile, time
snippets, destination, mode = sys.argv[1:]
def object_json(path):
    with open(path, encoding="utf-8") as source:
        data = json.load(source)
    if not isinstance(data, dict):
        raise ValueError("Key config must be an object: " + path)
    return data
existing = os.path.exists(destination)
data = object_json(destination) if existing else {}
changes = []
for path in sorted(glob.glob(os.path.join(snippets, "*.json"))):
    for section, bindings in object_json(path).items():
        if not isinstance(bindings, dict) or not isinstance(data.get(section, {}), dict):
            raise ValueError("Key section must be an object: " + section)
        target = data.setdefault(section, {})
        for key, action in bindings.items():
            if key not in target:
                target[key] = action
                changes.append(section + ":" + key)
if mode == "validate":
    sys.exit(0)
if not changes:
    print("Key bindings already present; preserving existing bindings")
    sys.exit(0)
if mode == "dry-run":
    print("Merge missing keys: " + ", ".join(changes))
    print("Back up existing keys.json before merging" if existing else "Create keys.json")
    sys.exit(0)
os.makedirs(os.path.dirname(destination), exist_ok=True)
if existing:
    backup = destination + ".bak-" + str(time.time_ns())
    shutil.copy2(destination, backup)
    print("Backed up keys.json: " + backup)
fd, staged = tempfile.mkstemp(prefix=".keys-", dir=os.path.dirname(destination))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(data, output, indent=2)
        output.write("\n")
    os.chmod(staged, stat.S_IMODE(os.stat(destination).st_mode) if existing else 0o600)
    os.replace(staged, destination)
finally:
    if os.path.exists(staged):
        os.unlink(staged)
print("Merged missing keys: " + ", ".join(changes))
PYKEYS
}
merge_keys validate
command -v rsync >/dev/null || { echo 'rsync is required' >&2; exit 1; }
case $(uname -s) in Darwin) goos=darwin ;; Linux) goos=linux ;; *) echo 'Unsupported OS' >&2; exit 1 ;; esac
case $(uname -m) in arm64|aarch64) goarch=arm64 ;; x86_64|amd64) goarch=amd64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
prebuilt="$root/bin/$goos-$goarch/herdr-hud"
if command -v go >/dev/null; then
    build=true
elif [ -f "$prebuilt" ]; then
    build=false
else
    echo "Go is required, or supply $prebuilt" >&2; exit 1
fi
if "$dry_run"; then
    if "$build"; then echo "Build hud/cmd/herdr-hud for $goos/$goarch"; else echo "Use prebuilt $prebuilt"; fi
    echo "Install helper: $HOME/.local/bin/herdr-hud"
    echo "Sync custom mods: $app/mods (exclude tests and editor files)"
    echo "Copy custom layouts: $app/layouts"
    merge_keys dry-run
    exit 0
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if "$build"; then
    CGO_ENABLED=0 go -C "$root/hud" build -trimpath -ldflags '-s -w' -o "$scratch/herdr-hud" ./cmd/herdr-hud
else
    cp "$prebuilt" "$scratch/herdr-hud"
fi
mkdir -p "$HOME/.local/bin" "$app/mods" "$app/layouts"
# Stage next to the destination so the final rename is atomic.
helper_tmp=$(mktemp "$HOME/.local/bin/.herdr-hud.XXXXXX")
trap 'rm -f "${helper_tmp:-}"; rm -rf "$scratch"' EXIT
cp "$scratch/herdr-hud" "$helper_tmp"
chmod 755 "$helper_tmp"
mv -f "$helper_tmp" "$HOME/.local/bin/herdr-hud"
for mod in "$root"/mods/*; do
    [ -d "$mod" ] || continue
    mkdir -p "$app/mods/${mod##*/}"
    rsync -a --delete --exclude='*.test.mjs' --exclude=package.json --exclude=gpui-kit.d.ts --exclude=jsconfig.json "$mod/" "$app/mods/${mod##*/}/"
done
for layout in "$root"/layouts/*.json; do
    [ -f "$layout" ] || continue
    cp "$layout" "$app/layouts/"
done
merge_keys write
echo "Installed herdr-hud and cockpit files. Select cockpit in the layout chooser."
