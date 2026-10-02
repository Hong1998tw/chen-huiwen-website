#!/usr/bin/env python3
"""Compare four complete read-only snapshots. Never publishes or contacts an app."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import unicodedata

REPOSITORY = 'Hong1998tw/chen-huiwen-website'
PUBLIC_STATUSES = {'持續追蹤', '爭取規劃', '已完成', '政策實施'}
ACTIVE = {'queued', 'processing', 'pr_created', 'merged'}
TERMINAL = {'deployed', 'verified', 'no_change'}
SHA = re.compile(r'[a-f0-9]{40}')
ID = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')


class InputError(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise InputError('Snapshot time must include its timezone') from None


def collection(value, name, key):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise InputError(name + ': incomplete or malformed collection')
    keys = [key(row) for row in value]
    if any(not isinstance(k, str) or not k for k in keys) or len(set(keys)) != len(keys):
        raise InputError(name + ': missing or duplicate identity')
    return dict(zip(keys, value))


def normalize(value):
    if isinstance(value, str):
        return unicodedata.normalize('NFC', value.replace('\r\n', '\n')).strip()
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    return value


def requested(value):
    if value is True or value == '__YES__':
        return True
    if value is False or value is None or value == '__NO__':
        return False
    raise InputError('Notion request flag must be a native checkbox value')


def notion_content(row):
    if 'expected' in row:
        expected = row['expected']
    else:
        text = row.get('公開敘事')
        if not isinstance(text, str):
            raise InputError('Requested Notion row is missing reviewed narrative')
        text = re.sub(r'<br\s*/?>', '\n', text, flags=re.I)
        expected = {'title': row.get('政績標題'), 'summary': row.get('摘要'),
                    'paragraphs': [part for part in text.split('\n\n') if part.strip()]}
    if (not isinstance(expected, dict) or not {'title', 'summary', 'paragraphs'} <= set(expected)
            or not isinstance(expected['title'], str) or not expected['title'].strip()
            or not isinstance(expected['summary'], str) or not expected['summary'].strip()
            or not isinstance(expected['paragraphs'], list) or not expected['paragraphs']
            or any(not isinstance(p, str) or not p.strip() for p in expected['paragraphs'])):
        raise InputError('Requested Notion row lacks complete compared public fields')
    allowed = {'title', 'summary', 'paragraphs', 'status', 'categories', 'subcategories', 'scope', 'district', 'history', 'sources'}
    if not set(expected) <= allowed:
        raise InputError('Notion expected fields exceed the public comparison contract')
    return normalize(expected)


def latest_requests(rows, page=False):
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise InputError('CMS publication history is incomplete')
    result = {}
    for row in rows:
        key = row.get('path') if page else str(row.get('domain', '')) + ':' + str(row.get('record_key', ''))
        if not key or (not page and (not row.get('domain') or not row.get('record_key'))) or type(row.get('version')) is not int:
            raise InputError('CMS publication identity or version is invalid')
        if key in result and row['version'] == result[key]['version']:
            raise InputError('CMS contains duplicate current versions')
        if key not in result or row['version'] > result[key]['version']:
            result[key] = row
    return result


def report(snapshot, *, now=None, max_age_hours=4, previous=None):
    now = now or datetime.now(timezone.utc)
    output = {'schemaVersion': 1, 'readOnly': True, 'publicationActions': 0,
              'observedAt': now.isoformat(), 'status': 'BLOCKED', 'differences': [], 'blockers': [], 'newDifferences': []}
    try:
        if not isinstance(snapshot, dict) or snapshot.get('schemaVersion') != 1:
            raise InputError('Unsupported snapshot contract')
        for name in ('notion', 'cms', 'github', 'live'):
            source = snapshot.get(name)
            if not isinstance(source, dict) or source.get('complete') is not True:
                raise InputError(name + ': complete native readback is required')
            age = now - timestamp(source.get('observedAt'))
            if age < -timedelta(minutes=5) or age > timedelta(hours=max_age_hours):
                raise InputError(name + ': snapshot is stale or from the future')
        notion, cms, github, live = (snapshot[name] for name in ('notion', 'cms', 'github', 'live'))
        sha = github.get('commitSha')
        if (github.get('repository') != REPOSITORY or github.get('ref') != 'refs/heads/main'
                or not isinstance(sha, str) or not SHA.fullmatch(sha)):
            raise InputError('GitHub snapshot must pin this repository canonical main')
        output['expectedMainSha'] = sha
        records = collection(github.get('records'), 'Canonical records', lambda row: row.get('id'))
        public = collection(github.get('publicRecords'), 'Public projection', lambda row: row.get('id'))
        expected_ids = {key for key, row in records.items() if row.get('status') in PUBLIC_STATUSES}
        if set(public) != expected_ids:
            raise InputError('Canonical public projection is incomplete')
        pages = collection(github.get('pages'), 'Canonical catalog', lambda row: row.get('path'))
        cms_pages = collection(cms.get('pages'), 'CMS catalog', lambda row: row.get('path'))
        sources = collection(github.get('sources'), 'Canonical CMS sources', lambda row: row.get('domain', '') + ':' + row.get('record_key', ''))
        cms_sources = collection(cms.get('sources'), 'CMS sources', lambda row: row.get('domain', '') + ':' + row.get('record_key', ''))
        intent_rows = collection(notion.get('rows'), 'Notion rows', lambda row: row.get('網站 ID', row.get('id')))
        desired = {key: row for key, row in intent_rows.items() if requested(row.get('要求發布', row.get('requestPublish')))}
        if any(not ID.fullmatch(key) for key in desired):
            raise InputError('Requested Notion stable ID is invalid')
        document_latest = latest_requests(cms.get('publications'))
        page_latest = latest_requests(cms.get('pagePublications'), True)
        ignored = sum(row.get('status') == 'failed' and row['version'] < document_latest[row['domain'] + ':' + row['record_key']]['version'] for row in cms['publications'])
        ignored += sum(row.get('status') == 'failed' and row['version'] < page_latest[row['path']]['version'] for row in cms['pagePublications'])
        counts = {'notionRequested': len(desired), 'canonicalPublic': len(public), 'cmsPages': len(cms_pages),
                  'historicalFailedIgnored': ignored}
        output['counts'] = counts

        def difference(kind, target, needs_codex, action, *, expected=None, observed=None, fields=None, url=None):
            item = {'kind': kind, 'target': target, 'needsCodex': needs_codex, 'action': action,
                    'expectedHash': digest(expected), 'observedHash': digest(observed)}
            if fields:
                item['fields'] = sorted(fields)
            if url:
                item['notionUrl'] = url
            item['fingerprint'] = digest(item)
            output['differences'].append(item)

        release = github.get('release')
        if (not isinstance(release, dict) or release.get('sourceCommit') != sha
                or release.get('provider') != 'cloudflare-static-assets'
                or release.get('publicRecordCount') != len(public)
                or not re.fullmatch(r'[a-f0-9]{64}', str(release.get('publicArtifactDigest', '')))):
            raise InputError('Canonical release receipt is invalid')
        live_ok = live.get('httpStatus') == 200 and live.get('baseUrl') == 'https://www.huiwen.tw/'
        observed_release = live.get('release')
        live_ok = live_ok and isinstance(observed_release, dict) and observed_release.get('provider') == 'cloudflare-static-assets'
        live_records = {}
        if not live_ok:
            output['blockers'].append({'kind': 'LIVE_READBACK_BLOCKED', 'needsCodex': None})
        else:
            live_records = collection(live.get('records'), 'Live public records', lambda row: row.get('id'))
            if observed_release.get('publicRecordCount') != len(live_records):
                raise InputError('Live collection is incomplete relative to its release')
            keys = ('sourceCommit', 'publicArtifactDigest', 'publicRecordCount', 'publicFileCount', 'provider')
            if any(release.get(key) != observed_release.get(key) for key in keys):
                difference('LIVE_RELEASE_DIFF', 'production', True, '核對既有部署與exact SHA，不重送內容',
                           expected={k: release.get(k) for k in keys}, observed={k: observed_release.get(k) for k in keys})
            for key in sorted(set(public) | set(live_records)):
                if normalize(public.get(key)) != normalize(live_records.get(key)):
                    difference('LIVE_PUBLIC_RECORD_DIFF', key, True, '核對正式公開內容與原有發布鏈', expected=public.get(key), observed=live_records.get(key))

        for key, row in desired.items():
            expected = notion_content(row)
            actual = records.get(key)
            compared = {field: actual.get(field) for field in expected} if actual else None
            changed = [field for field in expected if not actual or expected[field] != normalize(actual.get(field))]
            approved = (row.get('敘事狀態', row.get('reviewStatus')) == '已審定'
                        and row.get('證據狀態', row.get('evidenceStatus')) == '已確認'
                        and row.get('發佈疑慮判讀', row.get('concern')) in {'無疑慮', '低'})
            if changed or (actual and key not in public):
                kind = 'NOTION_NOT_IN_CANONICAL' if not actual else 'NOTION_CONTENT_DIFF'
                action = '準備受控PR與完整驗證' if approved else '先原生查核與審定；不可自動公開'
                difference(kind, key, approved, action, expected=expected, observed=compared, fields=changed, url=row.get('url'))
            elif live_ok and normalize(public.get(key)) == normalize(live_records.get(key)) and release == observed_release:
                difference('NOTION_RECEIPT_PENDING', key, False, '原生回填已核同版本收據及發布請求，不新增內容PR',
                           expected=expected, observed=expected, url=row.get('url'))

        for key in sorted(set(pages) | set(cms_pages)):
            expected = pages.get(key)
            actual = cms_pages.get(key)
            fields = {'title': 'title', 'source': 'source_path', 'kind': 'source_kind', 'editorScope': 'editor_scope'}
            wanted = {name: expected.get(name) for name in fields} if expected else None
            cached = {name: actual.get(source) for name, source in fields.items()} if actual else None
            if wanted != cached:
                difference('CMS_CATALOG_DIFF', key, False, '使用現役publisher對齊目錄；不直接寫D1', expected=wanted, observed=cached)
        for key in sorted(set(sources) | set(cms_sources)):
            expected = sources.get(key, {}).get('hash')
            actual = cms_sources.get(key, {}).get('source_hash')
            if expected != actual:
                difference('CMS_SOURCE_CACHE_DIFF', key, False, '使用現役publisher對齊來源快取', expected=expected, observed=actual)

        active_count = 0
        for page, latest in ((False, document_latest), (True, page_latest)):
            for key, row in latest.items():
                state = row.get('status')
                if state in TERMINAL:
                    continue
                if state not in ACTIVE | {'failed'}:
                    raise InputError('Unknown current CMS publication state')
                desired_hash = row.get('desiredHash')
                current_hash = row.get('canonicalHash') if page else sources.get(key, {}).get('hash')
                if desired_hash is not None and current_hash is not None:
                    if desired_hash != current_hash:
                        difference('CMS_REQUEST_CONTENT_DIFF', key, state == 'failed',
                                   '檢查既有publisher失敗；不自動重送' if state == 'failed' else '由現役受控publisher處理',
                                   expected=desired_hash, observed=current_hash)
                else:
                    output['blockers'].append({'kind': 'CMS_REQUEST_COMPARISON_REQUIRED', 'target': key,
                                               'needsCodex': state == 'failed', 'status': state})
                active_count += state in ACTIVE
        counts['activeCmsRequests'] = active_count
        output['differences'].sort(key=lambda item: (item['kind'], item['target']))
        if previous is not None:
            if not isinstance(previous, dict) or previous.get('schemaVersion') != 1 or not isinstance(previous.get('differences'), list):
                raise InputError('Previous report is invalid')
            old = {item['fingerprint'] for item in previous['differences']}
        else:
            old = set()
        output['newDifferences'] = [item for item in output['differences'] if item['fingerprint'] not in old]
        output['status'] = 'BLOCKED' if output['blockers'] else 'DIFFERENCES' if output['differences'] else 'OK'
    except (InputError, KeyError, TypeError, AttributeError) as error:
        message = str(error) if isinstance(error, InputError) else 'Malformed snapshot structure'
        output['differences'] = []
        output['newDifferences'] = []
        output['blockers'] = [{'kind': 'INPUT_BLOCKED', 'message': message, 'needsCodex': None}]
        output['status'] = 'BLOCKED'
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--previous-report', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--at', help='Timezone-aware historical replay time; never represents a new live read')
    args = parser.parse_args()
    try:
        snapshot = json.loads(args.snapshot.read_text())
        previous = json.loads(args.previous_report.read_text()) if args.previous_report else None
        result = report(snapshot, previous=previous, now=timestamp(args.at) if args.at else None)
    except (OSError, ValueError):
        result = {'schemaVersion': 1, 'readOnly': True, 'publicationActions': 0, 'status': 'BLOCKED',
                  'differences': [], 'newDifferences': [], 'blockers': [{'kind': 'INPUT_FILE_BLOCKED', 'needsCodex': None}]}
    text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text, end='')
    return 2 if result['status'] == 'BLOCKED' else 1 if result['status'] == 'DIFFERENCES' else 0


if __name__ == '__main__':
    raise SystemExit(main())
