#!/usr/bin/env python3
"""Offline laughter comparison. Python stdlib only; inference runs in a venv."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import wave

REVISION = "5d5e0327916959d832d95ffbef5f484efc93d799"
CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "herdr-hud"


def merge(ranges, limit=None):
    result = []
    for start, end in sorted((float(r["start"]), float(r["end"])) for r in ranges):
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise ValueError("invalid laughter range")
        if limit is not None:
            start, end = min(start, limit), min(end, limit)
        if start == end:
            continue
        if result and start <= result[-1][1]:
            result[-1][1] = max(end, result[-1][1])
        else:
            result.append([start, end])
    return result


def iou(left, right, duration):
    left, right = merge(left, duration), merge(right, duration)
    intersection = sum(max(0, min(b, d) - max(a, c)) for a, b in left for c, d in right)
    union = sum(b - a for a, b in left + right) - intersection
    return intersection / union if union else None


def kept(segment, ranges):
    start, duration = segment["start"], segment["duration"]
    if duration <= 0:
        return not any(a <= start <= b for a, b in merge(ranges))
    overlap = sum(max(0, min(start + duration, b) - max(start, a)) for a, b in merge(ranges))
    return overlap <= duration * 0.5


def cell(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("|", "&#124;").replace("\r", " ").replace("\n", " ")


def ranges_text(ranges):
    return ", ".join(f"{a:.3f}–{b:.3f}s" for a, b in merge(ranges)) or "none"


def textgrid_ranges(path):
    """Read Praat long or short TextGrid output from tgt (one laughter tier)."""
    text = path.read_text(encoding="utf-8-sig")
    number = r"[-+\d.eE]+"
    if "intervals [" in text:  # Long TextGrid
        matches = re.findall(r'intervals\s*\[\d+\]:\s*xmin\s*=\s*(' + number + r')\s*xmax\s*=\s*(' + number + r')\s*text\s*=\s*"([^"]*)"', text)
        if not matches:
            raise ValueError("cannot parse long TextGrid")
        return [{"start": float(a), "end": float(b)} for a, b, label in matches if label == "laugh"]
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    # A short interval is three lines: xmin, xmax, quoted label. Header/tier
    # entries are ignored by requiring the exact upstream 'laugh' label.
    if not any('TextGrid' in line for line in lines):
        raise ValueError("not a TextGrid")
    ranges = []
    for index, line in enumerate(lines):
        if line == '"laugh"' and index >= 2:
            ranges.append({"start": float(lines[index - 2]), "end": float(lines[index - 1])})
    return ranges


def gillick_ranges(wav, repo, python):
    if not (repo / "segment_laughter.py").is_file() or not python.is_file():
        raise RuntimeError("Gillick environment missing; run setup.sh (or use --apple-only)")
    revision = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    if revision != REVISION:
        raise RuntimeError(f"Gillick revision {revision} differs from pinned {REVISION}")
    with tempfile.TemporaryDirectory(prefix="herdr-laugh-eval-") as directory:
        # Upstream lacks a __main__ guard and starts DataLoader workers. Use fork
        # on macOS to avoid recursively importing its top-level segmenter on spawn.
        wrapper = """import functools
import multiprocessing
import runpy
import torch
multiprocessing.set_start_method('fork', force=True)
torch.set_num_threads(1)
# The distributed checkpoint contains CUDA storages; macOS is CPU-only.
torch.load = functools.partial(torch.load, map_location='cpu')
runpy.run_path('segment_laughter.py', run_name='__main__')
"""
        command = [str(python), "-c", wrapper,
                   "--input_audio_file", str(wav.resolve()), "--output_dir", directory,
                   "--threshold", "0.5", "--min_length", "0.2",
                   "--save_to_audio_files", "False", "--save_to_textgrid", "True"]
        env = dict(os.environ, OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run(command, cwd=repo, env=env, capture_output=True, text=True, timeout=300)
        if result.returncode:
            raise RuntimeError(f"Gillick exited {result.returncode}:\n{result.stderr[-4000:]}")
        grids = list(Path(directory).glob("*.TextGrid"))
        if grids:
            return textgrid_ranges(grids[0])
        # Upstream writes no TextGrid when there are zero instances. Require its
        # explicit success message so an unexpected missing output is an error.
        if re.search(r"found\s+0\s+laughs\.", result.stdout):
            return []
        raise RuntimeError("Gillick did not produce a TextGrid or report zero laughs")


def threshold_list(value):
    try:
        values = [float(item) for item in value.split(",")]
        if not values or any(not math.isfinite(t) or not 0.1 <= t <= 0.99 for t in values):
            raise ValueError()
        return values
    except ValueError as error:
        raise argparse.ArgumentTypeError("thresholds must be comma-separated numbers in 0.1..0.99") from error


def apple_rerun(wav, threshold, listener):
    # Re-evaluation must never inherit a keep-audio setting or produce new samples.
    result = subprocess.run([listener, "--file", str(wav.resolve()), "--debug-json",
                             "--laugh-threshold", str(threshold)], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"Apple re-evaluation exited {result.returncode}: {result.stderr[-2000:]} {result.stdout[-2000:]}")
    metadata = json.loads(result.stdout)
    if "laugh_ranges" not in metadata or "segments" not in metadata or not metadata.get("classifier_available", True):
        raise RuntimeError("Apple debug output missing or classifier unavailable")
    return metadata


def report_sample(stem, metadata, methods, gillick, duration):
    lines = [f"## {cell(stem)}", "", f"Final transcript: {cell(metadata.get('final', ''))}", "",
             f"Unfiltered transcript: {cell(metadata.get('formatted', ''))}", "",
             f"Duration: {duration:.3f}s; locale: {cell(metadata.get('locale', 'unknown'))}", ""]
    summary = []
    for label, data in methods:
        ranges = data["laugh_ranges"]
        segments = data["segments"]
        lines += [f"### {cell(label)}", "", f"Ranges: {ranges_text(ranges)}", "",
                  f"Windows: {len(data.get('windows', []))}; threshold: {data.get('threshold', 'unknown')}; "
                  f"trimmed: {data.get('trimmed', 'unknown')}", ""]
        if not data.get("classifier_available", True):
            lines += ["**Classifier unavailable: empty ranges are not a negative prediction.**", ""]
        summary.append((stem, label, sum(not kept(s, ranges) for s in segments), ranges, None))
    if gillick is not None:
        lines += ["### Gillick (threshold 0.5, minimum 0.2s)", "", f"Ranges: {ranges_text(gillick)}", ""]
        summary.append((stem, "Gillick", sum(not kept(s, gillick) for s in metadata["segments"]), gillick, None))
        for index, (label, data) in enumerate(methods):
            score = iou(data["laugh_ranges"], gillick, duration) if data.get("classifier_available", True) else None
            summary[index] = (*summary[index][:-1], score)
            lines += [f"IoU {cell(label)} / Gillick: {score:.3f}" if score is not None else f"IoU {cell(label)} / Gillick: N/A (no positive union or classifier unavailable)", ""]
    # Use original recognition segments for comparable deletion decisions. Apple
    # re-runs may produce different recognition text/timings: show those separately.
    for label, data in methods:
        columns = [label] + (["Gillick"] if gillick is not None else [])
        lines += [f"### Segment decisions ({cell(label)} recognition)", "",
                  "| Text | Start | Duration | " + " | ".join(cell(c) for c in columns) + " |",
                  "| --- | ---: | ---: | " + " | ".join("---" for _ in columns) + " |"]
        for segment in data["segments"]:
            marks = ["KEEP" if kept(segment, data["laugh_ranges"]) else "DROP"]
            if gillick is not None:
                marks.append("KEEP" if kept(segment, gillick) else "DROP")
            lines.append(f"| {cell(segment['text'])} | {segment['start']:.3f} | {segment['duration']:.3f} | " + " | ".join(marks) + " |")
        lines.append("")
    return lines, summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, default=CACHE / "listen-samples")
    parser.add_argument("--out", type=Path, default=Path("report.md"))
    parser.add_argument("--apple-only", action="store_true", help="skip Gillick, use saved Apple predictions")
    parser.add_argument("--thresholds", type=threshold_list, help="rerun Apple, e.g. 0.3,0.5,0.7")
    parser.add_argument("--listener", default=str(Path.home() / ".local/bin/herdr-listen"))
    parser.add_argument("--gillick-repo", type=Path, default=CACHE / "laughter-detection")
    parser.add_argument("--gillick-python", type=Path, default=CACHE / "laugh-eval-venv/bin/python")
    args = parser.parse_args(argv)
    if not args.samples.is_dir():
        parser.error(f"sample directory does not exist: {args.samples}")
    os.umask(0o077)
    lines = ["# Local laughter comparison", "", f"Gillick revision: `{REVISION}`" if not args.apple_only else "Apple only; Gillick skipped.", "",
             "Ranges and IoU measure detector agreement, not accuracy. Listen and label the audio before choosing a detector.", "",
             "Segment deletion uses the listener's >50% overlap rule (zero-duration segments drop inside a range). "
             "Ranges are clipped to audio duration for IoU; two empty sets have N/A IoU.", ""]
    details, rows, errors, count = [], [], [], 0
    for wav in sorted(args.samples.glob("*.wav")):
        sidecar = wav.with_suffix(".json")
        if not sidecar.is_file():
            errors.append(f"{wav.name}: missing JSON pair")
            continue
        count += 1
        try:
            metadata = json.loads(sidecar.read_text())
            for field in ("laugh_ranges", "windows", "segments"):
                if field not in metadata:
                    raise ValueError(f"missing {field} (sample needs --debug-json metadata)")
            with wave.open(str(wav), "rb") as audio:
                duration = audio.getnframes() / audio.getframerate()
            methods = [(f"Apple saved ({metadata.get('threshold', '?')})", metadata)]
            for threshold in args.thresholds or []:
                try:
                    methods.append((f"Apple {threshold:g}", apple_rerun(wav, threshold, args.listener)))
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    errors.append(f"{wav.name} Apple {threshold:g}: {error}")
            gillick = None
            if not args.apple_only:
                try:
                    gillick = gillick_ranges(wav, args.gillick_repo.resolve(), args.gillick_python.absolute())
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    errors.append(f"{wav.name} Gillick: {error}")
            content, summary = report_sample(wav.stem, metadata, methods, gillick, duration)
            details.extend(content)
            rows.extend(summary)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append(f"{wav.name}: {error}")
    if not count:
        errors.append("No WAV/JSON sample pairs found.")
    lines += ["## Summary", "", "| Sample | Method | Dropped segments | Ranges | IoU vs Gillick |",
              "| --- | --- | ---: | --- | ---: |"]
    for stem, label, drops, ranges, score in rows:
        lines.append(f"| {cell(stem)} | {cell(label)} | {drops} | {ranges_text(ranges)} | " + (f"{score:.3f}" if score is not None else "N/A") + " |")
    lines += [""] + details
    if errors:
        lines += ["## Errors", ""] + [f"- {cell(error)}" for error in errors] + [""]
    # Reports contain transcripts too: use private permissions even for an
    # existing report and atomically publish only a complete document.
    fd, temporary = tempfile.mkstemp(prefix=".laugh-report-", dir=args.out.resolve().parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write("\n".join(lines))
        os.replace(temporary, args.out)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"{args.out}: {count} sample pair(s), {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
