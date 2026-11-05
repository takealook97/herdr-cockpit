"""Exercise setup recovery without downloading repositories or packages."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class SetupRecoveryTests(unittest.TestCase):
    def run_setup(self, head="wrong", dirty=False, remote=None, has_git=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "herdr-hud/laughter-detection"
            repo.mkdir(parents=True)
            if has_git:
                (repo / ".git").mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            log = root / "commands"
            git = bin_dir / "git"
            git.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
shift 2
case "$1" in
config) printf '%s\\n' "$TEST_REMOTE" ;;
status) [ "$TEST_DIRTY" = 0 ] || printf '%s\\n' '?? local.txt' ;;
rev-parse) [ "$TEST_HEAD" != missing ] || exit 1; printf '%s\\n' "$TEST_HEAD" ;;
fetch|checkout) exit 0 ;;
*) exit 99 ;;
esac
exit 0
''')
            git.chmod(0o700)
            venv_python = root / "herdr-hud/laugh-eval-venv/bin/python"
            venv_python.parent.mkdir(parents=True)
            venv_python.write_text("#!/bin/sh\nexit 0\n")
            venv_python.chmod(0o700)
            env = dict(os.environ, XDG_CACHE_HOME=tmp,
                       PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                       COMMAND_LOG=str(log), TEST_HEAD=head,
                       TEST_DIRTY=str(int(dirty)),
                       TEST_REMOTE=remote or "https://github.com/jrgillick/laughter-detection")
            result = subprocess.run(["sh", str(Path(__file__).with_name("setup.sh"))],
                                    env=env, capture_output=True, text=True)
            return result, log.read_text() if log.exists() else "", str(repo)

    def test_recovers_wrong_or_missing_head(self):
        for head in ("wrong", "missing"):
            with self.subTest(head=head):
                result, log, _ = self.run_setup(head=head)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("fetch origin 5d5e0327916959d832d95ffbef5f484efc93d799", log)
                self.assertIn("checkout --detach 5d5e0327916959d832d95ffbef5f484efc93d799", log)

    def test_pinned_checkout_needs_no_fetch(self):
        result, log, _ = self.run_setup(head="5d5e0327916959d832d95ffbef5f484efc93d799")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("fetch", log)

    def test_refuses_dirty_or_foreign_checkout(self):
        for options in ({"dirty": True}, {"remote": "https://example.com/other"}):
            with self.subTest(options=options):
                result, log, _ = self.run_setup(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("fetch", log)
                self.assertNotIn("checkout --detach", log)

    def test_missing_git_reports_exact_path(self):
        result, log, repo = self.run_setup(has_git=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("delete this exact path manually to retry: " + repo, result.stderr)
        self.assertEqual(log, "")
