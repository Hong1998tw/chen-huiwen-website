#!/usr/bin/env python3
"""Publisher candidate preflight for an uncommitted disposable worktree.

Runs every quality.py validator (with the base revision for stable IDs), the generated stale and
determinism checks, and build_public.py --check. This is only a candidate preflight, not the full
quality gate: the unit, negative and E2E suites need a clean committed tree, so they run in the
required `validate` check (`scripts/quality.py`) on the exact PR head before GitHub auto-merge.
"""
from python_guard import require_supported_python
require_supported_python()
import argparse, os, subprocess, sys
from pathlib import Path
import quality


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=quality.ROOT)
    p.add_argument('--baseline-ref',required=True,help='Committed base of the candidate worktree (stable-ID preservation)')
    a=p.parse_args(argv);root=a.root.resolve()
    # The Workers deploy-build shortcut never applies here: candidates always rebuild for determinism.
    os.environ.pop('WORKERS_CI',None)
    try:
        for name in quality.VALIDATORS:
            extra=['--baseline-ref',a.baseline_ref] if name=='validate_achievements.py' else []
            quality.run(root,[sys.executable,'scripts/'+name,*extra])
        quality.generated(root)
        quality.run(root,[sys.executable,'scripts/build_public.py','--check'])
    except (subprocess.CalledProcessError,RuntimeError) as exc:
        print(str(exc),file=sys.stderr);return 1
    print('PASS: candidate preflight only (full quality runs in the required validate check on the committed PR head)')
    return 0
if __name__=='__main__':raise SystemExit(main())
