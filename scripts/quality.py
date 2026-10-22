#!/usr/bin/env python3
"""Single deterministic quality entry point. Never contacts production or private registries."""
from python_guard import require_supported_python
require_supported_python()
import argparse, hashlib, os, shlex, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BUILDERS=('build_all.py',)
VALIDATORS=('validate_achievements.py','validate_site.py','validate_donation.py','validate_seo.py','validate_p0.py','validate_public_copy.py','validate_domain_migration.py')

def snapshot(root):
    paths=list(root.glob('*.html'))+[root/name for name in ('data/search-index.json','data/achievement-map.json','data/achievements-public.json','sitemap.xml','llms.txt','updates.xml','styles.css','sw.js','digital.js','site.js')]
    generated_fonts=root/'assets/fonts/huiwen-site-sans/generated'
    if generated_fonts.is_dir(): paths.extend(generated_fonts.glob('*.woff2'))
    paths=[p for p in paths if p.exists()]
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def run(root,args,label=None):
    command=shlex.join(str(arg) for arg in args)
    stage=label or command
    started=time.monotonic()
    print(f'QUALITY_SUBPROCESS_START stage={stage!r} utc={_utc_now()} command={command}',flush=True)
    def report_end(returncode):
        elapsed=time.monotonic()-started
        print(f'QUALITY_SUBPROCESS_END stage={stage!r} utc={_utc_now()} elapsed_monotonic_seconds={elapsed:.3f} returncode={returncode}',flush=True)
    try:
        result=subprocess.run(args,cwd=root,check=True)
    except subprocess.CalledProcessError as exc:
        try:
            report_end(exc.returncode)
        except Exception as observation_error:
            exc.add_note(f'quality end observation failed: {type(observation_error).__name__}')
        raise
    except OSError as exc:
        try:
            report_end('not-started')
        except Exception as observation_error:
            exc.add_note(f'quality end observation failed: {type(observation_error).__name__}')
        raise
    report_end(result.returncode)

def generated(root):
    before=snapshot(root)
    # Diagnostics only: a mismatch still fails the same publication gate.
    before_bytes={name:(root/name).read_bytes() for name in before}
    for name in BUILDERS: run(root,[sys.executable,'scripts/'+name],label=f'generated.first_build.{name}')
    after=snapshot(root)
    if before != after:
        changed=sorted(name for name in set(before)|set(after) if before.get(name)!=after.get(name))
        print('Generated output differences: '+', '.join(changed),file=sys.stderr)
        for name in changed[:8]:
            old_bytes=before_bytes.get(name,b'');new_bytes=(root/name).read_bytes() if (root/name).exists() else b''
            try:
                old=old_bytes.decode('utf-8');new=new_bytes.decode('utf-8')
            except UnicodeDecodeError:
                old_hash=hashlib.sha256(old_bytes).hexdigest() if name in before else 'missing'
                new_hash=hashlib.sha256(new_bytes).hexdigest() if name in after else 'missing'
                print(f'{name}: binary output differs; before_sha256={old_hash}; after_sha256={new_hash}',file=sys.stderr)
                continue
            offset=next((i for i,(a,b) in enumerate(zip(old,new)) if a!=b),min(len(old),len(new)))
            print(f'{name}: first difference at {offset}; before={old[max(0,offset-60):offset+120]!r}; after={new[max(0,offset-60):offset+120]!r}',file=sys.stderr)
        raise RuntimeError('GENERATED_STALE: rebuild, review and commit generated outputs before checking')
    for name in BUILDERS: run(root,[sys.executable,'scripts/'+name],label=f'generated.second_build.{name}')
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
        # Cloudflare Workers Builds (WORKERS_CI=1) stops a deploy build at 20 minutes. The unit
        # suite alone outgrew that budget, and it already runs as the required `validate` check on
        # every pull request, so the deploy build keeps validators and generated checks only.
        if not a.generated_only and os.environ.get('WORKERS_CI')=='1':
            print('QUALITY_UNIT_TESTS_SKIPPED reason=WORKERS_CI (covered by the required validate check)',flush=True)
        elif not a.generated_only:
            run(root,[sys.executable,'-u','-m','unittest','discover','-v','-s','tests','-p','test_*.py'])
            run(root,[sys.executable,'-u','-m','unittest','discover','-v','-s','tests/events'])
        if a.browser:
            for name in ('browser','digital-civic','p0','achievement-governance','election-mode','lifecycle','runtime-maturity','site-maturity','service-tools'):
                run(root,['node','tests/donation/'+name+'.mjs'])
        print('PASS: deterministic quality'+(' and browser regression' if a.browser else ''))
        return 0
    except (subprocess.CalledProcessError,RuntimeError) as exc:
        print(str(exc),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
