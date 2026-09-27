#!/usr/bin/env python3
"""Trusted path gate for Notion publisher pull requests.

CI runs this file from the PR *base* revision (never PR code) and pipes `git diff --name-only`
of the PR into stdin. Executor PRs (branch prefix `notion-publish/`, the configured App login,
or any Bot author) may only touch the data file and generated outputs of their own domain, so a
stolen App credential cannot change scripts, templates, workflows, tests or CNAME through a PR.
Human PRs are not restricted here; they remain under normal review.
"""
import os
import re
import sys

from publish_from_notion import ALLOWED_PATHS, BRANCH_PREFIX, DATA_FILES


def evaluate(head_ref, author, author_type, app_login, files):
    files = sorted({f.strip() for f in files if f.strip()})
    bot = author_type == 'Bot' or (app_login and author == app_login)
    if not head_ref.startswith(BRANCH_PREFIX):
        if bot:
            return False, f'Bot PR must use the {BRANCH_PREFIX}<domain>/ branch prefix'
        return True, 'not an executor pull request'
    parts = head_ref.split('/')
    domain = parts[1] if len(parts) > 2 else ''
    if domain not in ALLOWED_PATHS:
        return False, f'unknown publish domain: {domain!r}'
    if not files:
        return False, 'executor pull request changes no files'
    allowed = set(ALLOWED_PATHS[domain])
    if domain == 'editorial-page':
        from editorial_pages import PATH, SECTIONS
        record = '/'.join(parts[2:])
        match = re.fullmatch(r'(page-(?:news|press|service|council|achievement)-[a-z0-9-]+\.html)-[a-f0-9]{8}', record)
        page_path = match[1] if match else ''
        section = PATH.fullmatch(page_path) if page_path else None
        if not section:
            return False, 'invalid editorial page branch path'
        allowed.update((page_path, SECTIONS[section[1]][0]))
    outside = [f for f in files if f not in allowed]
    if outside:
        return False, 'paths outside the executor allowlist: ' + ', '.join(outside)
    if DATA_FILES[domain] not in files:
        return False, f'{DATA_FILES[domain]} must be part of an executor pull request'
    return True, f'{len(files)} allowed path(s) for {domain}'


def main():
    ok, reason = evaluate(os.environ.get('HEAD_REF', ''), os.environ.get('PR_AUTHOR', ''),
                          os.environ.get('PR_AUTHOR_TYPE', ''), os.environ.get('PUBLISHER_APP_LOGIN', ''),
                          sys.stdin.read().splitlines())
    print(('PASS: ' if ok else 'FAIL: ') + reason)
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
