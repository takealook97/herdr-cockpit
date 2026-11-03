#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
app=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
dry_run=false
force=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) dry_run=true ;;
        --force) force=true ;;
        --help|-h) echo 'Usage: scripts/install.sh [--dry-run] [--force]'; echo '  --force  overwrite an existing, different theme file'; exit 0 ;;
        *) echo 'Unknown arguments' >&2; exit 2 ;;
    esac
    shift
done
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
            if section == "global" and key == "ctrl-shift-h" and target.get(key) == "cerberus.toggle":
                target[key] = action
                changes.append(section + ":" + key + " (migrate cerberus.toggle)")
            elif key not in target:
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
legacy_mods() {
    python3 - "$root/scripts/legacy-cerberus.json" "$app/mods" "$1" <<'PYLEGACY'
import hashlib, json, pathlib, shutil, sys
manifest, mods, mode = sys.argv[1:]
for name, expected in json.loads(pathlib.Path(manifest).read_text()).items():
    folder = pathlib.Path(mods) / name
    if not folder.exists() and not folder.is_symlink():
        continue
    entries = list(folder.rglob("*")) if folder.is_dir() and not folder.is_symlink() else []
    if folder.is_symlink() or not folder.is_dir() or any(p.is_symlink() for p in entries):
        print("Preserve legacy mod (not an unmodified install): " + str(folder))
        continue
    files = {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in entries if p.is_file()}
    # Extra files, including editor files, belong to the user: keep the directory.
    dirs = {str(p.relative_to(folder)) for p in entries if p.is_dir()}
    expected_dirs = {str(parent) for file in expected for parent in pathlib.Path(file).parents if str(parent) != "."}
    if files != expected or dirs != expected_dirs:
        print("Preserve legacy mod (modified or extra files): " + str(folder))
        continue
    print(("Would remove" if mode == "dry-run" else "Remove") + " unmodified legacy mod: " + str(folder))
    if mode != "dry-run":
        shutil.rmtree(folder)
PYLEGACY
}
merge_keys validate
# Themes: only the shipped names; never replace a different file unless --force.
theme_names='styx asphodel elysium'
themes_to_copy=
for name in $theme_names; do
    src="$root/themes/$name.json"
    dest="$app/themes/$name.json"
    [ -f "$src" ] || continue
    [ ! -L "$dest" ] || { echo "Refusing symlink theme: $dest" >&2; exit 1; }
    if [ -e "$dest" ] && ! cmp -s "$src" "$dest" && ! "$force"; then
        echo "Refusing to overwrite a different theme: $dest (use --force)" >&2; exit 1
    fi
    themes_to_copy="$themes_to_copy $name"
done
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
    legacy_mods dry-run
    for name in $themes_to_copy; do
        if [ -e "$app/themes/$name.json" ]; then
            if cmp -s "$root/themes/$name.json" "$app/themes/$name.json"; then echo "Theme $name: unchanged"; else echo "Theme $name: overwrite (--force)"; fi
        else
            echo "Theme $name: copy to $app/themes/$name.json"
        fi
    done
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
legacy_mods write
if [ -n "$themes_to_copy" ]; then
    mkdir -p "$app/themes"
    for name in $themes_to_copy; do
        cp "$root/themes/$name.json" "$app/themes/$name.json"
    done
fi
echo "Installed herdr-hud and cockpit files. Select cockpit in the layout chooser."
