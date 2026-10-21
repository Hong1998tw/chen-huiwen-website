"""Focused tests for the quality command's subprocess observations."""
import io
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("quality", ROOT / "scripts/quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class FlushCapture(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flush_count = 0

    def flush(self):
        self.flush_count += 1
        super().flush()


class QualityObservabilityTests(unittest.TestCase):
    def test_run_reports_success_with_flushed_start_and_end(self):
        command = ["python", "scripts/check.py", "--check"]
        stream = FlushCapture()
        with (
            mock.patch.object(quality, "_utc_now", side_effect=["2026-10-19T01:00:00.000Z", "2026-10-19T01:00:02.500Z"]),
            mock.patch.object(quality.time, "monotonic", side_effect=[10.0, 12.5]),
            mock.patch.object(quality.subprocess, "run", return_value=subprocess.CompletedProcess(command, 0)) as run,
            redirect_stdout(stream),
        ):
            quality.run(Path("/repo"), command, label="validator.check")

        run.assert_called_once_with(command, cwd=Path("/repo"), check=True)
        output = stream.getvalue()
        self.assertIn("QUALITY_SUBPROCESS_START stage='validator.check' utc=2026-10-19T01:00:00.000Z", output)
        self.assertIn("command=python scripts/check.py --check", output)
        self.assertIn("QUALITY_SUBPROCESS_END stage='validator.check' utc=2026-10-19T01:00:02.500Z elapsed_monotonic_seconds=2.500 returncode=0", output)
        self.assertEqual(stream.flush_count, 2)

    def test_run_reraises_the_original_called_process_error(self):
        command = ["python", "scripts/check.py"]
        failure = subprocess.CalledProcessError(23, command)
        stream = FlushCapture()
        with (
            mock.patch.object(quality, "_utc_now", side_effect=["2026-10-19T01:00:00.000Z", "2026-10-19T01:00:03.000Z"]),
            mock.patch.object(quality.time, "monotonic", side_effect=[4.0, 7.0]),
            mock.patch.object(quality.subprocess, "run", side_effect=failure),
            redirect_stdout(stream),
        ):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                quality.run(Path("/repo"), command, label="unittest.tests")

        self.assertIs(raised.exception, failure)
        self.assertIn("elapsed_monotonic_seconds=3.000 returncode=23", stream.getvalue())
        self.assertEqual(stream.flush_count, 2)

        second_failure = subprocess.CalledProcessError(24, command)
        failed_observation = FlushCapture()
        with (
            mock.patch.object(quality, "_utc_now", side_effect=["2026-10-19T01:00:00.000Z", RuntimeError("clock failure")]),
            mock.patch.object(quality.time, "monotonic", side_effect=[4.0, 7.0]),
            mock.patch.object(quality.subprocess, "run", side_effect=second_failure),
            redirect_stdout(failed_observation),
        ):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                quality.run(Path("/repo"), command, label="unittest.tests")
        self.assertIs(raised.exception, second_failure)
        self.assertIn("quality end observation failed: RuntimeError", raised.exception.__notes__[0])

    def test_main_keeps_both_native_discoveries_verbose_and_unbuffered(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch.object(sys, "argv", ["quality.py", "--root", directory]),
                mock.patch.dict(os.environ, {"WORKERS_CI": ""}),
                mock.patch.object(quality, "run") as run,
                mock.patch.object(quality, "generated"),
                mock.patch("sys.stdout", new_callable=io.StringIO),
            ):
                self.assertEqual(quality.main(), 0)

        commands = [call.args[1] for call in run.call_args_list]
        discoveries = [command for command in commands if command[1:4] == ["-u", "-m", "unittest"]]
        self.assertEqual(discoveries, [
            [sys.executable, "-u", "-m", "unittest", "discover", "-v", "-s", "tests", "-p", "test_*.py"],
            [sys.executable, "-u", "-m", "unittest", "discover", "-v", "-s", "tests/events"],
        ])

        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch.object(quality, "snapshot", side_effect=[{}, {}, {}]),
                mock.patch.object(quality, "BUILDERS", ("build_all.py",)),
                mock.patch.object(quality, "run") as run_builder,
            ):
                quality.generated(Path(directory))
        self.assertEqual(
            [call.kwargs["label"] for call in run_builder.call_args_list],
            ["generated.first_build.build_all.py", "generated.second_build.build_all.py"],
        )

    def test_workers_builds_deploy_skips_only_the_unit_suites(self):
        with tempfile.TemporaryDirectory() as directory:
            stream = io.StringIO()
            with (
                mock.patch.object(sys, "argv", ["quality.py", "--root", directory]),
                mock.patch.dict(os.environ, {"WORKERS_CI": "1"}),
                mock.patch.object(quality, "run") as run,
                mock.patch.object(quality, "generated") as generated,
                redirect_stdout(stream),
            ):
                self.assertEqual(quality.main(), 0)

        commands = [call.args[1] for call in run.call_args_list]
        self.assertFalse([command for command in commands if "unittest" in command])
        self.assertEqual([command[1] for command in commands[:len(quality.VALIDATORS)]],
                         ["scripts/" + name for name in quality.VALIDATORS])
        self.assertIn([sys.executable, "scripts/build_public.py", "--check"], commands)
        generated.assert_called_once()
        self.assertIn("QUALITY_UNIT_TESTS_SKIPPED reason=WORKERS_CI", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
