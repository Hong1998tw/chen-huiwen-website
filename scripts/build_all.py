#!/usr/bin/env python3
"""Explicit deterministic build graph. Source -> public data -> pages -> chrome -> index."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILD_STEPS = (
    ('build_public.py', '--projection-only'),
    ('build_cases.py',),
    ('build_platforms.py',),
    ('build_events.py',),
    ('build_service.py',),
    ('build_election_page.py',),
    ('build_profile.py',),
    ('build_civic.py',),
    ('build_shared.py',),
    ('build_search.py',),
    ('build_sitemap.py',),
)


def build(root=ROOT):
    for script, *args in BUILD_STEPS:
        subprocess.run([sys.executable, 'scripts/' + script, *args], cwd=root, check=True)


if __name__ == '__main__':
    build()
