#!/usr/bin/env python3
"""Single deterministic quality entry point. Never contacts production or private registries."""
import argparse, hashlib, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BUILDERS=('build_cases.py','build_platforms.py','build_events.py','build_search.py')
VALIDATORS=('validate_achievements.py','validate_site.py','validate_donation.py','validate_seo.py','validate_p0.py','validate_public_copy.py','validate_domain_migration.py')

def snapshot(root):
    paths=list(root.glob('*.html'))+[root/'data/search-index.json']
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

def run(root,args):
    subprocess.run(args,cwd=root,check=True)

def generated(root):
    before=snapshot(root)
    for name in BUILDERS: run(root,[sys.executable,'scripts/'+name])
    if before != snapshot(root):
        raise RuntimeError('GENERATED_STALE: rebuild, review and commit generated outputs before checking')
    for name in BUILDERS: run(root,[sys.executable,'scripts/'+name])
    if before != snapshot(root): raise RuntimeError('GENERATED_NONDETERMINISTIC')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=ROOT)
    p.add_argument('--baseline-ref');p.add_argument('--generated-only',action='store_true');p.add_argument('--browser',action='store_true')
    a=p.parse_args();root=a.root.resolve()
    try:
        if not a.generated_only:
            for name in VALIDATORS:
                extra=['--baseline-ref',a.baseline_ref] if name=='validate_achievements.py' and a.baseline_ref else []
                run(root,[sys.executable,'scripts/'+name,*extra])
        generated(root)
        if not a.generated_only:
            run(root,[sys.executable,'-m','unittest','discover','-s','tests','-p','test_*.py'])
            run(root,[sys.executable,'-m','unittest','discover','-s','tests/events'])
        if a.browser:
            for name in ('browser','digital-civic','p0','achievement-governance','election-mode','lifecycle'):
                run(root,['node','tests/donation/'+name+'.mjs'])
        print('PASS: deterministic quality'+(' and browser regression' if a.browser else ''))
        return 0
    except (subprocess.CalledProcessError,RuntimeError) as exc:
        print(str(exc),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
