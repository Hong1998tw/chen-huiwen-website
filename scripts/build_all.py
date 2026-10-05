#!/usr/bin/env python3
"""Explicit deterministic build graph. Source -> public data -> pages -> chrome -> index."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILD_STEPS = (
    ('build_legal_shared.py',),
    ('build_public.py', '--projection-only'),
    ('build_cases.py',),
    ('build_platforms.py',),
    ('build_events.py',),
    ('build_service.py',),
    ('build_guides.py',),
    ('build_service_print.py',),
    ('build_updates.py',),
    ('build_election_page.py',),
    ('build_profile.py',),
    ('build_home.py',),
    ('build_civic.py',),
    ('editorial_pages.py',),
    ('build_shared.py',),
    ('build_page_content.py',),
    ('build_sitemap.py',),
    ('build_search.py',),
)


def build(root=ROOT):
    for script, *args in BUILD_STEPS:
        subprocess.run([sys.executable, 'scripts/' + script, *args], cwd=root, check=True)


if __name__ == '__main__':
    build()
