#!/usr/bin/env python3
"""Trusted path gate for Notion publisher pull requests.

CI runs this file from the PR *base* revision (never PR code) and pipes `git diff --name-only`
of the PR into stdin. Executor PRs (branch prefix `notion-publish/`, the configured App login,
or any Bot author) may only touch the data file and generated outputs of their own domain, so a
stolen App credential cannot change scripts, templates, workflows, tests or CNAME through a PR.
Human PRs are not restricted here; they remain under normal review.
"""
import os
import json
import subprocess
from pathlib import Path

import build_events
import re
import sys

from publish_from_notion import ALLOWED_PATHS, BRANCH_PREFIX, DATA_FILES, EVENT_FIELDS


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
    # deployment-control has exactly one non-public metadata path; no runtime/config writes.
    allowed = set(ALLOWED_PATHS[domain])
    if domain == 'events':
        event_id = event_branch_id(head_ref)
        if event_id:
            allowed.add(build_events.event_path({'id': event_id}))
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


def event_branch_id(head_ref):
    match = re.fullmatch(re.escape(BRANCH_PREFIX) + r'events/([a-z0-9]+(?:-[a-z0-9]+)*)-[a-f0-9]{8}', head_ref)
    return match[1] if match else None


def verify_event_source(head_ref, base_text, head_text, read_head, template):
    """Trusted-base renderer verifies head data without executing any head code."""
    event_id = event_branch_id(head_ref)
    if not event_id:
        raise ValueError('invalid event branch id')
    before, after = json.loads(base_text), json.loads(head_text)
    base_events, head_events = build_events.public_events(before), build_events.public_events(after)
    if {k: v for k, v in before.items() if k != 'events'} != {k: v for k, v in after.items() if k != 'events'}:
        raise ValueError('event source envelope changed')
    if [item for item in base_events if item['id'] != event_id] != [item for item in head_events if item['id'] != event_id]:
        raise ValueError('unrelated event records changed')
    event = next((item for item in head_events if item['id'] == event_id), None)
    if event is None:
        raise ValueError('event source record missing; use cancellation to retain its URL')
    original = next((item for item in base_events if item['id'] == event_id), None)
    managed = set(EVENT_FIELDS) | {'previousSchedule'}
    if original is not None:
        if {key: value for key, value in original.items() if key not in managed} != {key: value for key, value in event.items() if key not in managed}:
            raise ValueError('unmanaged event fields must remain unchanged')
    elif set(event) - managed - {'id'}:
        raise ValueError('new event includes unmanaged fields')
    for path, selected in [('activities.html', None), (build_events.event_path(event), event)]:
        expected = build_events.render_page(template, head_events, selected)
        if build_events.generated_projection(read_head(path)) != build_events.generated_projection(expected):
            raise ValueError('event source and generated page differ: ' + path)


def main():
    ok, reason = evaluate(os.environ.get('HEAD_REF', ''), os.environ.get('PR_AUTHOR', ''),
                          os.environ.get('PR_AUTHOR_TYPE', ''), os.environ.get('PUBLISHER_APP_LOGIN', ''),
                          sys.stdin.read().splitlines())
    if ok and os.environ.get('HEAD_REF', '').startswith(BRANCH_PREFIX + 'events/'):
        try:
            base, head = os.environ['BASE_SHA'], os.environ['HEAD_SHA']
            if not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (base, head)):
                raise ValueError('invalid immutable revision')
            def read_revision(revision, path):
                return subprocess.run(['git', 'show', revision + ':' + path], check=True, capture_output=True, text=True).stdout
            verify_event_source(os.environ['HEAD_REF'], read_revision(base, 'data/events.json'),
                                read_revision(head, 'data/events.json'), lambda path: read_revision(head, path),
                                Path('templates/events-page.html').read_text())
        except (KeyError, ValueError, OSError, subprocess.CalledProcessError):
            ok, reason = False, 'event source/generated consistency check failed'
    print(('PASS: ' if ok else 'FAIL: ') + reason)
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())

