#!/bin/sh
# Developer-only: never called by install.sh or make install.
set -eu
modern=0
case "${1:-}" in
    '') ;;
    --modern-deps) modern=1 ;;
    *) echo "Usage: $0 [--modern-deps]" >&2; exit 2 ;;
esac
cache=${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud
repo=$cache/laughter-detection
venv=$cache/laugh-eval-venv
revision=5d5e0327916959d832d95ffbef5f484efc93d799
url=https://github.com/jrgillick/laughter-detection
python=${LAUGH_EVAL_PYTHON:-python3}
printf '%s\n' "Will download jrgillick/laughter-detection at $revision (including model checkpoints)" \
    "from https://github.com/jrgillick/laughter-detection into $repo" \
    "and Python packages from your pip index into $venv using $python." \
    "No recordings are uploaded. Existing dirty checkouts or checkouts from a different remote are refused."
if [ "$modern" = 1 ]; then
    printf '%s\n' 'Compatibility mode: Python 3.10, torch 2.2.2, numpy 1.23.5; all other upstream requirements retained.'
    "$python" -c 'import sys; assert sys.version_info[:2] == (3, 10), "--modern-deps requires Python 3.10 (set LAUGH_EVAL_PYTHON)"'
fi
umask 077
mkdir -p "$cache"
if [ ! -e "$repo" ]; then
    git clone "$url" "$repo"
fi
if [ ! -d "$repo/.git" ]; then
    echo "Refusing to alter directory without .git; delete this exact path manually to retry: $repo" >&2
    exit 1
fi
if [ "$(git -C "$repo" config --get remote.origin.url || true)" != "$url" ]; then
    echo "Refusing to alter $repo: remote.origin.url differs from $url." >&2
    exit 1
fi
if ! worktree_status=$(git -C "$repo" status --porcelain --untracked-files=all); then
    echo "Refusing to alter $repo: cannot verify working tree is clean." >&2
    exit 1
fi
if [ -n "$worktree_status" ]; then
    echo "Refusing to alter dirty checkout $repo; preserve your changes before retrying." >&2
    exit 1
fi
if [ "$(git -C "$repo" rev-parse --verify HEAD 2>/dev/null || true)" != "$revision" ]; then
    git -C "$repo" fetch origin "$revision"
    git -C "$repo" checkout --detach "$revision"
fi
if [ ! -x "$venv/bin/python" ]; then "$python" -m venv "$venv"; fi
if [ "$modern" = 1 ]; then
    "$venv/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 10), "existing venv is not Python 3.10; use a fresh XDG_CACHE_HOME"'
    # Upstream torch 1.3.1 has no Apple Silicon wheel. Keep its other explicit
    # requirements and pin the numerical stack to versions librosa 0.8.1 supports.
    requirements=$venv/herdr-requirements.txt
    sed '/^torch==/d' "$repo/requirements.txt" > "$requirements"
    cat >> "$requirements" <<'REQ'
torch==2.2.2
numpy==1.23.5
scipy==1.10.1
numba==0.57.1
llvmlite==0.40.1
pandas==1.5.3
tqdm==4.66.5
setuptools<81
nltk==3.9.1
protobuf==3.20.3
REQ
else
    requirements=$repo/requirements.txt
fi
if ! "$venv/bin/python" -m pip install -r "$requirements"; then
    echo 'Upstream pins torch 1.3.1 (old Intel/Python environments). For Apple Silicon use Python 3.10 with --modern-deps in a fresh cache; see README.md.' >&2
    exit 1
fi
# The upstream requirements omit direct imports and need old protobuf APIs.
# Include them in the original-dependency path too; compatibility mode pins them.
if [ "$modern" = 0 ]; then "$venv/bin/python" -m pip install pandas tqdm nltk 'protobuf<4'; fi
printf '%s\n' "Ready: $venv/bin/python (upstream $revision)." \
    'Run compare.py; review the report manually before changing filtering.'
