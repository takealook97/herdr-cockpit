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
if [ -n "$themes_to_copy" ]; then
    mkdir -p "$app/themes"
    for name in $themes_to_copy; do
        cp "$root/themes/$name.json" "$app/themes/$name.json"
    done
fi
echo "Installed herdr-hud and cockpit files. Select cockpit in the layout chooser."
