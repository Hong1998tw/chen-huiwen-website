#!/usr/bin/env python3
"""Single deterministic quality entry point. Never contacts production or private registries."""
from python_guard import require_supported_python
require_supported_python()
import argparse, hashlib, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BUILDERS=('build_all.py',)
VALIDATORS=('validate_achievements.py','validate_site.py','validate_donation.py','validate_seo.py','validate_p0.py','validate_public_copy.py','validate_domain_migration.py')

def snapshot(root):
    paths=list(root.glob('*.html'))+[root/name for name in ('data/search-index.json','data/achievement-map.json','data/achievements-public.json','sitemap.xml','updates.xml')]
    paths=[p for p in paths if p.exists()]
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

def run(root,args):
    subprocess.run(args,cwd=root,check=True)

def generated(root):
    before=snapshot(root)
    # Diagnostics only: a mismatch still fails the same publication gate.
    before_text={name:(root/name).read_text() for name in before}
    for name in BUILDERS: run(root,[sys.executable,'scripts/'+name])
    after=snapshot(root)
    if before != after:
        changed=sorted(name for name in set(before)|set(after) if before.get(name)!=after.get(name))
        print('Generated output differences: '+', '.join(changed),file=sys.stderr)
        for name in changed[:8]:
            old=before_text.get(name,'');new=(root/name).read_text() if (root/name).exists() else ''
            offset=next((i for i,(a,b) in enumerate(zip(old,new)) if a!=b),min(len(old),len(new)))
            print(f'{name}: first difference at {offset}; before={old[max(0,offset-60):offset+120]!r}; after={new[max(0,offset-60):offset+120]!r}',file=sys.stderr)
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
        run(root,[sys.executable,'scripts/build_public.py','--check'])
        if not a.generated_only:
            run(root,[sys.executable,'-m','unittest','discover','-s','tests','-p','test_*.py'])
            run(root,[sys.executable,'-m','unittest','discover','-s','tests/events'])
        if a.browser:
            for name in ('browser','digital-civic','p0','achievement-governance','election-mode','lifecycle','runtime-maturity','site-maturity','service-tools'):
                run(root,['node','tests/donation/'+name+'.mjs'])
        print('PASS: deterministic quality'+(' and browser regression' if a.browser else ''))
        return 0
    except (subprocess.CalledProcessError,RuntimeError) as exc:
        print(str(exc),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
