from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PlaywrightCiInstallTests(unittest.TestCase):
    def test_installer_uses_bounded_retries_and_keeps_apt_signatures(self):
        script = (ROOT / "scripts/install_playwright_ci.sh").read_text(encoding="utf-8")
        self.assertIn("https://archive.ubuntu.com/ubuntu", script)
        self.assertIn('Acquire::Retries "2";', script)
        self.assertIn('Acquire::http::Timeout "20";', script)
        self.assertIn('Acquire::https::Timeout "20";', script)
        self.assertIn("for attempt in 1 2; do", script)
        self.assertIn("timeout --kill-after=15s 180s", script)
        self.assertIn("playwright install --with-deps chromium", script)
        self.assertNotIn("trusted=yes", script)
        self.assertNotIn("AllowUnauthenticated", script)
        self.assertNotIn("--allow-unauthenticated", script)

    def test_timed_out_jobs_use_the_shared_installer_without_skipping_qa(self):
        browser = (ROOT / ".github/workflows/donation-page-qa.yml").read_text(encoding="utf-8")
        activity = (ROOT / ".github/workflows/activity-schedule-qa.yml").read_text(encoding="utf-8")
        self.assertEqual(browser.count("bash scripts/install_playwright_ci.sh"), 2)
        self.assertEqual(activity.count("bash scripts/install_playwright_ci.sh"), 1)
        self.assertIn("node tests/donation/browser.mjs", browser)
        self.assertIn("npm run test:lighthouse --prefix tests/donation", browser)
        self.assertIn("node tests/donation/events.mjs", activity)


if __name__ == "__main__":
    unittest.main()
