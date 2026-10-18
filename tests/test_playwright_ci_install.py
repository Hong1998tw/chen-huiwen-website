from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PlaywrightCiInstallTests(unittest.TestCase):
    def workflow_job(self, workflow, name):
        headers = list(re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):[ \t]*$", workflow))
        selected = [index for index, header in enumerate(headers) if header.group(1) == name]
        self.assertEqual(len(selected), 1, f"expected one {name} job")
        index = selected[0]
        start = headers[index].start()
        end = headers[index + 1].start() if index + 1 < len(headers) else len(workflow)
        return workflow[start:end]

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
        workflow = (ROOT / ".github/workflows/donation-page-qa.yml").read_text(encoding="utf-8")
        activity = (ROOT / ".github/workflows/activity-schedule-qa.yml").read_text(encoding="utf-8")

        browser = self.workflow_job(workflow, "browser")
        visual_qa = self.workflow_job(workflow, "visual-qa")
        lighthouse = self.workflow_job(workflow, "lighthouse")
        base_reference_start = visual_qa.index("      - name: Fetch and verify only the pull request base commit for A-05 reference capture")
        base_reference_end = visual_qa.index("      - uses:", base_reference_start)
        base_reference = visual_qa[base_reference_start:base_reference_end]
        self.assertIn("if: github.event_name == 'pull_request'", base_reference)
        self.assertIn("set -euo pipefail", base_reference)
        self.assertIn('git fetch --no-tags --depth=1 origin "$BASE_SHA"', base_reference)
        self.assertIn("git worktree add --detach \"$BASE_ROOT\" \"$BASE_SHA\"", base_reference)
        self.assertIn('worktree_status="$(git -C "$BASE_ROOT" status --porcelain=v1 -uall)"', base_reference)
        self.assertIn('[[ -n "$worktree_status" ]]', base_reference)
        self.assertNotIn("continue-on-error:", base_reference)

        for name, job, minutes in (
            ("browser", browser, 18),
            ("visual-qa", visual_qa, 25),
            ("lighthouse", lighthouse, 20),
        ):
            with self.subTest(job=name):
                self.assertRegex(job, rf"(?m)^    timeout-minutes: {minutes}$")
                self.assertEqual(job.count("bash scripts/install_playwright_ci.sh"), 1)
                self.assertIn("run: npm ci --ignore-scripts --prefix tests/donation", job)
                self.assertNotIn("continue-on-error: true", job)

        # Each independent job installs the browser it needs and runs its own QA gate.
        self.assertIn("      - run: node tests/donation/browser.mjs", browser)
        self.assertIn("Run five-viewport production-readiness regression suite", browser)
        self.assertIn("run: npm run test:readiness --prefix tests/donation", browser)
        self.assertIn("Verify A-05 archive safety fixtures", visual_qa)
        self.assertIn("run: python -m unittest discover -s tests -p 'test_visual_qa_baseline_archive.py'", visual_qa)
        self.assertIn("      - run: npm run test:visual-qa --prefix tests/donation", visual_qa)
        self.assertIn("Capture A-05 local screenshots and live Cloudflare measurements", visual_qa)
        self.assertIn("A-05 independent base: NOT_APPLICABLE; this non-PR event has no pull-request base.", visual_qa)
        self.assertIn("Independent base-reference capture: NOT_APPLICABLE for this non-PR event.", visual_qa)
        self.assertIn("node tests/donation/visual-qa.mjs capture --environment local-http-uncompressed", visual_qa)
        self.assertIn("node tests/donation/visual-qa.mjs capture --environment cloudflare-production", visual_qa)
        self.assertIn("Compare local captures with the committed Git baseline or record baseline pending", visual_qa)
        self.assertIn("node tests/donation/visual-qa.mjs compare", visual_qa)
        self.assertIn("Verify the Lighthouse static server", lighthouse)
        self.assertIn("run: node tests/donation/static-server-check.mjs", lighthouse)
        self.assertIn("Verify the Lighthouse comparison refuses runs without identical-content evidence", lighthouse)
        self.assertIn("run: node tests/donation/lighthouse-compare-check.mjs", lighthouse)
        self.assertIn("Verify election Lighthouse trace and allowlisted snapshot evidence", lighthouse)
        self.assertIn("run: node tests/donation/election-lighthouse-evidence-check.mjs", lighthouse)
        self.assertIn("CANDIDATE_SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}", lighthouse)
        self.assertIn("npm run test:lighthouse --prefix tests/donation", lighthouse)

        self.assertEqual(activity.count("bash scripts/install_playwright_ci.sh"), 1)
        self.assertIn("node tests/donation/events.mjs", activity)


if __name__ == "__main__":
    unittest.main()
