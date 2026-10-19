"""Contract for independent browser-suite execution and mandatory outcome gating."""
# GitHub documents `steps.<id>.outcome` before continue-on-error, with values
# success/failure/cancelled/skipped, and documents the default success status check:
# https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
# https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
import os
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/donation-page-qa.yml"
GATE = ROOT / "tests/donation/browser-suite-outcome-gate.mjs"

SUITES = (
    ("browser", "node tests/donation/browser.mjs"),
    ("min_font", "node tests/donation/min-font.mjs"),
    ("target_size", "node tests/donation/target-size.mjs"),
    ("sticky_navigation", "node tests/donation/sticky-navigation.mjs"),
    ("small_q", "node tests/donation/small-q.mjs"),
    ("public_service_audit", "node tests/donation/public-service-audit.mjs"),
    ("runtime_maturity", "node tests/donation/runtime-maturity.mjs"),
    ("site_maturity", "node tests/donation/site-maturity.mjs"),
    ("service_tools", "node tests/donation/service-tools.mjs"),
    ("legal_calendar", "node tests/donation/legal-calendar.mjs"),
    ("digital_civic", "node tests/donation/digital-civic.mjs"),
    ("ux_acceptance", "node tests/donation/ux-acceptance.mjs"),
    ("font_rendering", "node tests/donation/font-rendering.mjs"),
    ("p0", "node tests/donation/p0.mjs"),
    ("achievement_governance", "node tests/donation/achievement-governance.mjs"),
    ("achievement_list_mobile", "node tests/donation/achievement-list-mobile.mjs"),
    ("election_mode", "node tests/donation/election-mode.mjs"),
    ("lifecycle", "node tests/donation/lifecycle.mjs"),
    ("readiness", "npm run test:readiness --prefix tests/donation"),
)


def load_workflow():
    return yaml.load(WORKFLOW.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def run_gate(lines):
    environment = os.environ.copy()
    environment["BROWSER_SUITE_OUTCOMES"] = lines
    return subprocess.run(
        ["node", str(GATE)],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def outcome_lines(outcomes):
    return "\n".join(
        f"{suite_id}={outcomes[suite_id]}"
        for suite_id, _ in SUITES
        if suite_id in outcomes
    )


class DonationPageQaWorkflowTests(unittest.TestCase):
    def assert_artifact_and_gate_are_strict(self, steps):
        artifact = next(
            step for step in steps
            if step.get("uses", "").startswith("actions/upload-artifact@")
        )
        gate = next(
            step for step in steps
            if step.get("name") == "Require success from every independent browser suite"
        )
        self.assertNotEqual(
            artifact.get("continue-on-error"),
            "true",
            "artifact upload failure must fail the workflow",
        )
        self.assertNotEqual(
            gate.get("continue-on-error"),
            "true",
            "the final outcome gate failure must fail the workflow",
        )
        return artifact, gate

    def test_browser_suites_are_independent_and_final_gate_is_mandatory(self):
        workflow = load_workflow()
        self.assertEqual(workflow["on"], {"pull_request": ""})
        self.assertEqual(workflow["permissions"], {"contents": "read"})

        job = workflow["jobs"]["browser"]
        self.assertEqual(job["runs-on"], "ubuntu-latest")
        self.assertEqual(job["timeout-minutes"], "18")
        steps = job["steps"]
        prerequisite_index = next(
            index for index, step in enumerate(steps)
            if step.get("id") == "browser_prerequisites"
        )
        prerequisite = steps[prerequisite_index]
        self.assertEqual(
            prerequisite["run"], "bash scripts/install_playwright_ci.sh"
        )
        self.assertNotEqual(prerequisite.get("continue-on-error"), "true")

        suite_steps = [
            step for step in steps
            if step.get("id") in {suite_id for suite_id, _ in SUITES}
        ]
        self.assertEqual(
            [(step["id"], step["run"]) for step in suite_steps], list(SUITES)
        )
        for step in suite_steps:
            with self.subTest(suite=step["id"]):
                self.assertEqual(step["continue-on-error"], "true")
                self.assertNotIn("if", step)
                self.assertGreater(steps.index(step), prerequisite_index)

        # Preflight/build steps retain their default success gate; only browser suites
        # have continue-on-error, and the artifact/final gate are explicit always steps.
        for step in steps[:prerequisite_index + 1]:
            with self.subTest(preflight=step.get("name", step.get("run", step.get("uses")))):
                self.assertNotEqual(step.get("continue-on-error"), "true")

        artifact, gate = self.assert_artifact_and_gate_are_strict(steps)
        self.assertEqual(artifact["if"], "always()")
        self.assertIn("tests/donation/results/", artifact["with"]["path"])
        self.assertEqual(gate["if"], "always()")
        self.assertEqual(gate["run"], "node tests/donation/browser-suite-outcome-gate.mjs")
        self.assertGreater(steps.index(artifact), steps.index(suite_steps[-1]))
        self.assertGreater(steps.index(gate), steps.index(artifact))

        configured = {}
        for line in gate["env"]["BROWSER_SUITE_OUTCOMES"].splitlines():
            suite_id, expression = line.split("=", 1)
            self.assertNotIn(suite_id, configured)
            configured[suite_id] = expression
        self.assertEqual(
            configured,
            {suite_id: f"${{{{ steps.{suite_id}.outcome }}}}" for suite_id, _ in SUITES},
        )

    def test_workflow_contract_rejects_weak_final_gate_mutation(self):
        workflow = load_workflow()
        steps = workflow["jobs"]["browser"]["steps"]
        gate = next(
            step for step in steps
            if step.get("name") == "Require success from every independent browser suite"
        )
        gate["continue-on-error"] = "true"

        with self.assertRaisesRegex(AssertionError, "final outcome gate failure"):
            self.assert_artifact_and_gate_are_strict(steps)

    def test_outcome_gate_accepts_only_all_success(self):
        outcomes = {suite_id: "success" for suite_id, _ in SUITES}
        result = run_gate(outcome_lines(outcomes))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_outcome_gate_rejects_native_failure_skipped_cancelled_and_missing(self):
        for suite_id, outcome in (
            ("ux_acceptance", "failure"),
            ("font_rendering", "skipped"),
            ("readiness", "cancelled"),
        ):
            with self.subTest(suite=suite_id, outcome=outcome):
                outcomes = {item_id: "success" for item_id, _ in SUITES}
                outcomes[suite_id] = outcome
                result = run_gate(outcome_lines(outcomes))
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(suite_id, result.stdout + result.stderr)

        outcomes = {suite_id: "success" for suite_id, _ in SUITES}
        del outcomes["font_rendering"]
        result = run_gate(outcome_lines(outcomes))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("font_rendering: missing outcome", result.stderr)


if __name__ == "__main__":
    unittest.main()
