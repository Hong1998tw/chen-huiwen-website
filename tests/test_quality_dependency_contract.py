from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
FULL_QUALITY_CONSUMERS = (
    ".github/workflows/validate-source.yml",
    ".github/workflows/pages.yml",
    ".github/workflows/cms-publisher.yml",
    ".github/workflows/publish-executor.yml",
)


class QualityDependencyContractTests(unittest.TestCase):
    def test_full_quality_consumers_pin_pyyaml(self):
        for relative_path in FULL_QUALITY_CONSUMERS:
            with self.subTest(workflow=relative_path):
                workflow = (ROOT / relative_path).read_text(encoding="utf-8")
                install_lines = [line for line in workflow.splitlines() if "pip install" in line]
                self.assertTrue(
                    any("PyYAML==6.0.3" in line for line in install_lines),
                    f"{relative_path} runs quality.py but does not pin its YAML test dependency",
                )

    def test_local_and_cloudflare_quality_runbooks_name_the_pinned_parser(self):
        maintenance = (ROOT / "docs/MAINTENANCE.md").read_text(encoding="utf-8")
        cloudflare = (ROOT / "docs/CLOUDFLARE-PUBLIC-MIGRATION.md").read_text(encoding="utf-8")
        self.assertIn("PyYAML==6.0.3", maintenance)
        self.assertIn("PyYAML==6.0.3", cloudflare)


if __name__ == "__main__":
    unittest.main()
