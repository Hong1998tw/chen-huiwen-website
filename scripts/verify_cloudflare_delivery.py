#!/usr/bin/env python3
"""Read-only delivery gate: the live origin must identify the exact reviewed artifact."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
ROOT = Path(__file__).resolve().parents[1]

def check_receipt(value, expected_sha, artifact_digest):
    return (isinstance(value, dict) and value.get('schemaVersion') == 1
            and value.get('provider') == 'cloudflare-static-assets'
            and value.get('sourceCommit') == expected_sha
            and value.get('publicArtifactDigest') == artifact_digest)

def verify(expected_sha, artifact_digest, base_url, attempts=90, delay=5):
    if not re.fullmatch(r'[a-f0-9]{40}', expected_sha):
        raise ValueError('An exact source commit is required')
    result = {'status':'PENDING','expectedSha':expected_sha,'expectedArtifactDigest':artifact_digest,'base':base_url}
    for attempt in range(1, attempts+1):
        request = Request(base_url.rstrip('/') + '/deployment.json?verify=' + expected_sha + '-' + str(time.time_ns()),
                          headers={'User-Agent':'huiwen-public-delivery-verifier','Cache-Control':'no-cache'})
        try:
            with urlopen(request, timeout=20) as response:
                value = json.loads(response.read())
            result.update(status='PASS' if check_receipt(value,expected_sha,artifact_digest) else 'PENDING',
                          observed=value,attempt=attempt)
            if result['status'] == 'PASS':
                return result
        except HTTPError as error:
            result.update(status='BLOCKED' if error.code in (401,403,429) else 'PENDING',httpStatus=error.code,attempt=attempt)
        except (URLError,OSError,ValueError) as error:
            result.update(status='PENDING',reason=type(error).__name__,attempt=attempt)
        if attempt < attempts:
            time.sleep(delay)
    if result['status'] != 'BLOCKED':
        result['status'] = 'FAIL'
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='https://www.huiwen.tw/')
    parser.add_argument('--expected-sha')
    parser.add_argument('--artifact',default='_site/publication-manifest.json')
    parser.add_argument('--attempts',type=int,default=90)
    parser.add_argument('--delay',type=float,default=5)
    parser.add_argument('--report',default='tests/donation/results/cloudflare-public-delivery/receipt.json')
    args = parser.parse_args()
    expected = args.expected_sha or subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    digest = hashlib.sha256(Path(args.artifact).read_bytes()).hexdigest()
    result = verify(expected,digest,args.base_url,args.attempts,args.delay)
    target=Path(args.report);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['status']=='PASS' else 1

if __name__ == '__main__':
    raise SystemExit(main())
