"""Regression checks for interval comparison and offline reports (no downloads)."""
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import wave
from unittest import mock

import compare


class ComparisonTests(unittest.TestCase):
    def test_iou_merges_overlapping_ranges_and_clips_padding(self):
        apple = [{"start": 0, "end": 0.6}, {"start": 0.4, "end": 1.15}]
        gillick = [{"start": 0.5, "end": 1.1}]
        self.assertAlmostEqual(compare.iou(apple, gillick, 1.0), 0.5)
        self.assertIsNone(compare.iou([], [], 1.0))
        self.assertEqual(compare.iou(apple, [], 1.0), 0)

    def test_segment_overlap_boundaries(self):
        ranges = [{"start": 0.5, "end": 1.0}]
        self.assertTrue(compare.kept({"start": 0, "duration": 1}, ranges))
        self.assertFalse(compare.kept({"start": 0.1, "duration": 0.9}, ranges))
        self.assertFalse(compare.kept({"start": 0.5, "duration": 0}, ranges))
        self.assertTrue(compare.kept({"start": 1.1, "duration": 0}, ranges))

    def test_long_and_short_textgrid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.TextGrid"
            for text in [
                'File type = "ooTextFile"\nObject class = "TextGrid"\nintervals [1]:\nxmin = 0\nxmax = .5\ntext = ""\nintervals [2]:\nxmin = .5\nxmax = 1e0\ntext = "laugh"\n',
                'File type = "ooTextFile"\nObject class = "TextGrid"\n0\n1\n<exists>\n1\n"IntervalTier"\n"laughter"\n0\n1\n2\n0\n.5\n""\n.5\n1\n"laugh"\n',
            ]:
                path.write_text(text)
                self.assertEqual(compare.textgrid_ranges(path), [{"start": 0.5, "end": 1.0}])

    def test_offline_report_failure_is_not_silently_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wav = root / "sample.wav"
            with wave.open(str(wav), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\0\0" * 16000)
            wav.with_suffix(".json").write_text(json.dumps({
                "final": "kept", "formatted": "laugh kept", "threshold": 0.5,
                "laugh_ranges": [{"start": 0, "end": 0.6}], "windows": [], "trimmed": 1,
                "segments": [{"text": "laugh", "start": 0, "duration": 0.5, "kept": False},
                             {"text": "kept", "start": 0.7, "duration": 0.2, "kept": True}],
            }))
            report = root / "report.md"
            # Existing public report must be replaced with a private file.
            report.write_text("old")
            report.chmod(0o644)
            original_umask = os.umask(0o077)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(compare.main(["--samples", directory, "--apple-only", "--out", str(report)]), 0)
                text = report.read_text()
                self.assertIn("| laugh | 0.000 | 0.500 | DROP |", text)
                self.assertIn("| kept | 0.700 | 0.200 | KEEP |", text)
                self.assertEqual(stat.S_IMODE(report.stat().st_mode), 0o600)
                with mock.patch.object(compare, "gillick_ranges", side_effect=RuntimeError("model failed")):
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(compare.main(["--samples", directory, "--out", str(report)]), 1)
                text = report.read_text()
                self.assertIn("model failed", text)
                self.assertIn("Final transcript: kept", text)
                self.assertNotIn("### Gillick", text)
            finally:
                os.umask(original_umask)

    def test_gillick_explicit_zero_and_missing_output(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "segment_laughter.py").touch()
            python = repo / "python"
            python.touch()
            for stdout, success in [("found 0 laughs.", True), ("unexpected result", False)]:
                results = [SimpleNamespace(stdout=compare.REVISION),
                           SimpleNamespace(returncode=0, stdout=stdout, stderr="")]
                with mock.patch.object(compare.subprocess, "run", side_effect=results):
                    if success:
                        self.assertEqual(compare.gillick_ranges(repo / "audio.wav", repo, python), [])
                    else:
                        with self.assertRaisesRegex(RuntimeError, "did not produce"):
                            compare.gillick_ranges(repo / "audio.wav", repo, python)

    def test_invalid_thresholds(self):
        import argparse
        for invalid in ["nan", "inf", "0.01", "0.5,", "1"]:
            with self.assertRaises(argparse.ArgumentTypeError):
                compare.threshold_list(invalid)


if __name__ == "__main__":
    unittest.main()
