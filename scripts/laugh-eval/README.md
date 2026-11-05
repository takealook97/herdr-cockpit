# Local laughter evaluation

Collect a few representative voice commands, chuckles and mixed speech/laughter,
then compare Apple's built-in classifier with
[jrgillick/laughter-detection](https://github.com/jrgillick/laughter-detection).
This developer tool is not installed by `make install` and adds no Python dependency
to the application. Neither detector nor threshold is changed automatically.

## Retain samples (opt in)

Merge these fields into `${XDG_CONFIG_HOME:-~/.config}/herdr-hud/nexus.json`:

```json
{"model":"claude-medium-m","keepAudio":10,"laughThreshold":0.5}
```

`keepAudio` is an integer from 0 to 100, default **0 (off)**. `laughThreshold` is
optional, from 0.1 to 0.99, default 0.5. Invalid settings fall back independently;
the `model` field continues to work. Changes apply on the next `listen start`.

When enabled, successfully completed listening sessions save the audio buffers fed
to on-device recognition as 16 kHz mono 16-bit PCM WAV and a matching JSON sidecar
in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud/listen-samples`. The UTC filename
starts `yyyyMMdd-HHmmss`, with milliseconds and a unique suffix to avoid collisions.
Only the newest N pairs remain after a successful save. The directory is 0700,
and files are 0600. A private `.lock` serializes publication and pruning.

JSON includes `created`, `locale`, `threshold`, `final` (filtered transcript),
`formatted` (unfiltered transcript), `trimmed`, `laugh_ranges` (`start`, `end`),
`windows` (`start`, `end`, `score`) and `segments` (`text`, `start`, `duration`,
`kept`). `classifier_available` distinguishes an unavailable classifier from an
empty prediction. Scores are the maximum confidence across the six laughter labels.
Microphone PCM copies exist only when retention is enabled, and only until exit.

For a local file (no microphone access):

```sh
herdr-listen --file /path/to/audio.wav --debug-json --keep-audio 10
```

File mode saves the decoded source audio. `--debug-json` adds the same metadata to
stdout even without retention; normal file-mode JSON remains compatible. File
mode still needs on-device Speech recognition enabled and speech permission.
Do not pass `--no-laugh-filter` when gathering classifier evidence.

## Compare saved Apple predictions

Only Python 3's standard library is needed:

```sh
python3 scripts/laugh-eval/compare.py --apple-only --out /tmp/laugh-apple.md
python3 scripts/laugh-eval/compare.py --apple-only \
  --thresholds 0.3,0.5,0.7 --listener "$HOME/.local/bin/herdr-listen" \
  --out /tmp/laugh-thresholds.md
```

Stop listening before comparing so retention pruning cannot remove samples during
evaluation. `--samples DIR` overrides the sample directory. Threshold sweeps rerun the Apple
classifier and recognition on each WAV; no samples are created by these reruns.
Recognition can vary, so each sweep shows its own segment timestamps and decisions.
Missing/invalid samples or detector failures are reported explicitly and return a
nonzero exit status; they never count as a negative detection.

## Install the optional Gillick environment

Pinned upstream commit: **5d5e0327916959d832d95ffbef5f484efc93d799**.
The repository includes its model checkpoints. `setup.sh` prints the download
sources/destinations before any downloads, clones the pinned code, and creates a
venv in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud/laugh-eval-venv`; the clone lives
alongside it at `laughter-detection`. Re-running is safe for an unchanged pinned
checkout. Dirty or differently pinned checkouts are refused rather than reset.

The original requirements target Python 3.6-era environments (`torch==1.3.1`,
`librosa==0.8.1`). That torch wheel is unavailable for current Apple Silicon/Python.
An explicit compatibility option keeps the other upstream requirements, replaces
torch with 2.2.2, and pins numpy/scipy/numba/pandas for librosa 0.8.1. It requires
an already installed Python 3.10; this script does not install Python.

```sh
# Recommended on Apple Silicon; point to your existing Python 3.10.
LAUGH_EVAL_PYTHON=python3.10 scripts/laugh-eval/setup.sh --modern-deps

# Original requirements, for an environment supporting torch 1.3.1:
# LAUGH_EVAL_PYTHON=/path/to/compatible/python scripts/laugh-eval/setup.sh

python3 scripts/laugh-eval/compare.py --out /tmp/laugh-comparison.md
```

Use a fresh `XDG_CACHE_HOME` when switching Python/dependency modes. The numerical
stack differs in compatibility mode, so compare results with that limitation in
mind. `compare.py` invokes upstream `segment_laughter.py` through the venv Python,
with threshold 0.5, minimum length 0.2 seconds and TextGrid output; it parses those
ranges without Python dependencies in the report process. On macOS it selects
`fork` for upstream's unguarded multiprocessing entry point and maps checkpoint
storages to the CPU without editing upstream code. The setup also supplies omitted
NLTK/pandas/tqdm imports and a protobuf version compatible with tensorboardX 1.9. Each detector run has
a timeout and failures appear in the report. `--gillick-repo` and
`--gillick-python` can point to an environment in a separate cache.

Reports contain a summary, final and unfiltered transcripts, ranges, segment
KEEP/DROP decisions under each method, and intersection-over-union (IoU). Deletion
uses the listener's rule: drop a word when more than half its duration overlaps
laughter (zero-length words drop inside a range). Apple uses its existing
confidence smoothing and padding; Gillick ranges are shown as emitted. IoU uses
merged ranges clipped to the WAV duration; two empty sets have N/A IoU.
**Agreement is not accuracy.** Listen to the recordings and label laughter,
speech and mixed regions manually. Pay particular attention to real words dropped
by either method before deciding to tune Apple or convert a dedicated model.

## Privacy and deletion

Audio and transcripts stay local. Setup downloads source, checkpoints and Python
packages, but evaluation does not upload recordings. Saved samples can contain
nearby speech or sensitive information. The generated Markdown also contains
transcripts and uses 0600 permissions. Keep it private and delete after evaluation.
Setting `keepAudio` back to 0 stops future retention but **does not erase** old files.
After stopping listening, delete the sample directory you used:

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/herdr-hud/listen-samples"
rm -f /tmp/laugh-apple.md /tmp/laugh-thresholds.md /tmp/laugh-comparison.md
```

Optional downloaded dependencies can also be removed by deleting the
`laugh-eval-venv` and `laughter-detection` directories in that same cache.

To check report logic without a model download:

```sh
python3 -m unittest discover -s scripts/laugh-eval -p 'test_*.py'
```
