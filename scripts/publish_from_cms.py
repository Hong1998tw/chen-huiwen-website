#!/usr/bin/env python3
"""Authenticated CMS queue adapter. Uses the existing guarded publisher; never direct-merges."""
import json
import copy
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
import publish_from_notion as engine
from page_authority import catalog

ORIGIN = 'https://huiwen-cms.lihong.workers.dev'
ROOT = Path(__file__).resolve().parents[1]


class RunnerError(Exception):
    """Only static stage/status diagnostics, never remote bodies or token values."""


def fetch_json(request, stage, timeout):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        edge = ' (edge challenge)' if error.headers.get('cf-mitigated') == 'challenge' else ''
        raise RunnerError(f'{stage}: HTTP {error.code}{edge}') from None
    except urllib.error.URLError:
        raise RunnerError(f'{stage}: network/TLS failure') from None
    except (ValueError, KeyError):
        raise RunnerError(f'{stage}: invalid response format') from None


def api(path, value):
    # Short-lived OIDC JWT is requested per call, never persisted or logged.
    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + urllib.parse.quote(ORIGIN, safe='')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    token = fetch_json(req, 'GitHub OIDC', 20)['value']
    req = urllib.request.Request(ORIGIN + path, data=json.dumps(value).encode(),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                          'User-Agent': 'huiwen-cms-publisher/1.0'})
    return fetch_json(req, 'CMS ' + path, 30)


def sources(repo):
    events = json.loads((repo / engine.DATA_FILES['events']).read_text())
    legal = json.loads((repo / engine.DATA_FILES['legal-schedule']).read_text())
    result = [{'id': e['id'], 'domain': 'events', 'record_key': e['id'], 'hash': engine.sha(e),
               'payload': {k: e.get(k) for k in engine.EVENT_FIELDS}} for e in events['events']]
    result.append({'id': 'legal-current', 'domain': 'legal-schedule', 'record_key': 'current',
                   'hash': engine.sha(legal), 'payload': {k: legal[k] for k in ('month','observedAt','sourceUrl','sourceTitle','nextReviewAt','sessions')}})
    return result


def prepare(item, text):
    domain = item['domain']
    if domain not in engine.PREPARE:
        raise engine.PublishError('VALIDATION', ['不支援的發布類型'])
    data = engine.load_data(domain, text)
    current = next((e for e in data['events'] if e['id'] == item['record_key']), None) if domain == 'events' else data
    expected = engine.sha(current) if current is not None else 'absent'
    if expected != item['base_hash']:
        raise engine.PublishError('BASE_DRIFT', ['網站已有新版本；請在後台載入網站版本，再重新編輯。'])
    payload = json.loads(item['payload'])
    row = {'pageId': item['document_id'], 'fields': payload,
           'sessions': payload.get('sessions', []),
           'system': {'siteId': item['record_key'] if domain == 'events' else None,
                      'syncedHash': None if expected == 'absent' else expected, 'requestPublish': True}}
    candidate = engine.PREPARE[domain](row, text)
    if candidate.errors:
        raise engine.PublishError('VALIDATION', candidate.errors)
    return candidate


def page_text(root=ROOT):
    return (root / 'data/page-content.json').read_text(encoding='utf-8')


def current_page_lastmod(root, path):
    location = '' if path == 'index.html' else path[:-10] if path.endswith('/index.html') else path
    target = 'https://www.huiwen.tw/' + location
    ns = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
    for entry in ET.parse(root / 'sitemap.xml').getroot():
        loc = entry.find(ns + 'loc')
        lastmod = entry.find(ns + 'lastmod')
        if loc is not None and loc.text == target and lastmod is not None:
            return lastmod.text
    metadata = json.loads((root / 'data/page-metadata.json').read_text(encoding='utf-8'))
    return metadata.get(path, {}).get('contentUpdated')


def validate_page_payload(value):
    if not isinstance(value, dict) or set(value) != {'fields'} or not isinstance(value['fields'], dict) or len(value['fields']) > 250:
        raise engine.PublishError('VALIDATION', ['頁面草稿格式不正確'])
    fields = {}
    field_id = re.compile(r'^main(?:>[a-z][a-z0-9-]*:nth-of-type\([1-9]\d{0,2}\))*$')
    for key, item in value['fields'].items():
        if not isinstance(key, str) or not field_id.fullmatch(key) or not isinstance(item, dict) or set(item) != {'sourceHash', 'value'}:
            raise engine.PublishError('VALIDATION', ['頁面文字欄位不在允許範圍'])
        text = item['value']
        if not isinstance(text, str) or len(text) > 4000 or re.search(r'[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]', text):
            raise engine.PublishError('VALIDATION', ['頁面文字包含不允許的格式'])
        if not isinstance(item['sourceHash'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sourceHash']):
            raise engine.PublishError('VALIDATION', ['頁面文字來源版本不正確'])
        fields[key] = {'sourceHash': item['sourceHash'], 'value': unicodedata.normalize('NFC', text)}
    return fields


def page_candidate(item, root=ROOT):
    path, operation = item.get('path'), item.get('operation')
    if not isinstance(path, str) or not re.fullmatch(r'(?:[a-z0-9-]+/)*[a-z0-9-]+\.html', path):
        raise engine.PublishError('VALIDATION', ['頁面路徑不在公開頁面範圍'])
    if operation not in {'publish', 'unpublish', 'delete', 'restore'}:
        raise engine.PublishError('VALIDATION', ['頁面操作類型不支援'])
    pages = {row['path']: row for row in catalog(root)}
    page = pages.get(path)
    if not page or page['kind'] in {'system', 'legacy-redirect', 'excluded-intake'}:
        raise engine.PublishError('VALIDATION', ['此頁目前不開放編輯'])
    live_sha = engine.run(['git', 'rev-parse', 'HEAD'], root).stdout.strip()
    if item.get('base_commit') != live_sha:
        raise engine.PublishError('STALE_CHECKOUT')
    try:
        state = json.loads(page_text(root))
    except (ValueError, OSError):
        raise engine.PublishError('UNKNOWN_SCHEMA', ['data/page-content.json']) from None
    if not isinstance(state, dict) or state.get('schemaVersion') != 1 or not isinstance(state.get('pages'), dict):
        raise engine.PublishError('UNKNOWN_SCHEMA', ['data/page-content.json'])
    entry = copy.deepcopy(state['pages'].get(path, {'edits': {}}))
    if not isinstance(entry, dict) or set(entry) - {'edits', 'status', 'lastmod'}:
        raise engine.PublishError('FORMAT_DRIFT', ['data/page-content.json'])
    fields = validate_page_payload(json.loads(item['payload']))
    if operation == 'publish':
        changed_fields = entry.get('edits', {}) != fields or entry.get('status', 'published') != 'published'
        entry['edits'] = fields
        entry['status'] = 'published'
        if changed_fields:
            entry['lastmod'] = engine.datetime.now(engine.TAIPEI).date().isoformat()
    elif operation == 'restore':
        changed_status = entry.get('status', 'published') != 'published'
        entry['status'] = 'published'
        if changed_status:
            entry['lastmod'] = engine.datetime.now(engine.TAIPEI).date().isoformat()
    else:
        entry.setdefault('edits', fields)
        entry['status'] = 'unpublished' if operation == 'unpublish' else 'deleted'
        if not entry.get('lastmod'):
            entry['lastmod'] = current_page_lastmod(root, path)
        if not entry.get('lastmod'):
            raise engine.PublishError('VALIDATION', ['此頁缺少可追溯的公開更新日期'])
    state['pages'][path] = entry
    new_text = json.dumps(state, ensure_ascii=False, indent=2) + '\n'
    current_text = page_text(root)
    digest = engine.sha({'path': path, 'operation': operation, 'version': item['version'], 'state': entry})
    return engine.Candidate('page-copy', item['id'], path, entry, item['base_commit'], new_text,
                            new_text != current_text, f'頁面：{path}\n操作：{operation}', digest)


def publish_page(item, gh):
    receipt = {'id': item['id'], 'lease': item['lease']}
    try:
        engine.gate_preflight(gh, single_maintainer=True, auto_publish=True)
        candidate = page_candidate(item)
        if not candidate.changed:
            return {**receipt, 'status': 'no_change', 'message': '與目前頁面版本相同，沒有建立重複發布。'}
        base = engine.run(['git', 'rev-parse', 'HEAD'], ROOT).stdout.strip()
        title = f"Website CMS: {item['operation']} {item['path']}"
        with engine.Worktree(ROOT, base) as wt:
            engine.materialize(candidate, wt)
            if gh.branch_sha('main') != base:
                raise engine.PublishError('STALE_CHECKOUT')
            outcome, pr = engine.ensure_pull_request(gh, candidate,
                lambda: engine.git_push(os.environ['GH_TOKEN'])(wt, candidate, title), title,
                f"Owner-approved page revision {item['version']}.\n\nPage: `{item['path']}`\nOperation: `{item['operation']}`\nBuild, canonical source, publication path and required checks are enforced.\nCandidate digest: `{candidate.digest}`")
            if outcome != 'ALREADY_MERGED':
                gh.enable_auto_merge(pr['number'], expected_head_sha=gh.branch_sha(candidate.branch))
        return {**receipt, 'status': 'pr_created', 'pr_number': pr['number'], 'message': '頁面發布請求已建立；正在等待必要檢查與正式站部署。'}
    except engine.PublishError as error:
        return {**receipt, 'status': 'failed', 'message': error.plain()[:1500]}


def reconcile_page(item, gh):
    _, pr = gh.request('GET', f"/pulls/{int(item['pr_number'])}")
    if pr.get('state') == 'closed' and not pr.get('merged_at'):
        return {'id': item['id'], 'status': 'closed', 'message': '發布請求已關閉，頁面維持原狀。'}
    layers, revision = engine.layered_status(gh, item['pr_number'], 'page-copy', item['path'], item['operation'],
        single_maintainer=True, auto_publish=True, publisher_login=os.environ.get('PUBLISHER_APP_LOGIN', ''))
    state = 'verified' if all(v == 'PASS' for v in layers.values()) else 'deployed' if layers['deployed'] == 'PASS' else 'merged' if layers['merged'] == 'PASS' else 'pr_created'
    details = '；'.join(f'{engine.LAYER_ZH[k]}：{v}' for k, v in layers.items())
    return {'id': item['id'], 'status': state, 'message': details, 'commit_sha': revision.get('deployedSha')}


def publish(item, gh):
    receipt = {'id': item['id'], 'lease': item['lease']}
    try:
        engine.gate_preflight(gh, single_maintainer=True, auto_publish=True)
        text = (ROOT / engine.DATA_FILES[item['domain']]).read_text()
        candidate = prepare(item, text)
        if not candidate.changed:
            return {**receipt, 'status': 'no_change', 'message': '與網站目前版本相同，沒有建立重複發布。'}
        base = engine.run(['git','rev-parse','HEAD'], ROOT).stdout.strip()
        title = f"Website CMS: {candidate.domain} {candidate.record_key}"
        with engine.Worktree(ROOT, base) as wt:
            engine.materialize(candidate, wt)
            if gh.branch_sha('main') != base:
                raise engine.PublishError('STALE_CHECKOUT')
            outcome, pr = engine.ensure_pull_request(gh, candidate,
                lambda: engine.git_push(os.environ['GH_TOKEN'])(wt,candidate,title), title,
                f"Owner-approved CMS revision {item['version']}.\n\nBuild, canonical source, and publication path checks are required.\nCandidate digest: {candidate.digest}")
            if outcome != 'ALREADY_MERGED':
                gh.enable_auto_merge(pr['number'], expected_head_sha=gh.branch_sha(candidate.branch))
        return {**receipt, 'status':'pr_created', 'pr_number':pr['number'], 'message':'發布請求已建立；正在等待必要檢查及自動合併。'}
    except engine.PublishError as error:
        return {**receipt, 'status':'failed', 'message': error.plain()[:1500]}


def reconcile(item, gh):
    _, pr = gh.request('GET', f"/pulls/{int(item['pr_number'])}")
    if pr.get('state') == 'closed' and not pr.get('merged_at'):
        return {'id':item['id'],'status':'closed','message':'發布請求已關閉，未上線。請修改草稿後重新發布。'}
    layers, revision = engine.layered_status(gh, item['pr_number'], item['domain'],
        json.loads(item['payload']).get('month') if item['domain']=='legal-schedule' else item['record_key'],
        single_maintainer=True,auto_publish=True,publisher_login=os.environ.get('PUBLISHER_APP_LOGIN',''))
    state = ('verified' if all(v=='PASS' for v in layers.values()) else 'deployed' if layers['deployed']=='PASS' else 'merged' if layers['merged']=='PASS' else 'pr_created')
    # A CI failure can be re-run without closing its PR. Keep reconciling the same request.
    details='；'.join(f'{engine.LAYER_ZH[k]}：{v}' for k,v in layers.items())
    return {'id':item['id'],'status':state,'message':details,'commit_sha':revision.get('deployedSha')}


def main():
    commit = engine.run(['git','rev-parse','HEAD'],ROOT).stdout.strip()
    api('/internal/sync',{'commit':commit,'sources':sources(ROOT),'pages':catalog(ROOT)})
    gh=engine.GitHub(os.environ['GH_TOKEN'],os.environ['GITHUB_REPOSITORY'])
    for item in api('/internal/pending',{})['publications']:
        api('/internal/receipt',reconcile(item,gh))
    for item in api('/internal/pending-pages',{})['publications']:
        api('/internal/receipt-page',reconcile_page(item,gh))
    if os.environ.get('CMS_PUBLISH_ENABLED') != 'true':
        print('CMS source sync complete; publishing not enabled.')
        return
    queue = api('/internal/queue-head',{}).get('next')
    if queue == 'page':
        item=api('/internal/claim-page',{})['publication']
        if item:
            api('/internal/receipt-page',publish_page(item,gh))
            print('CMS page publication processed; see authenticated dashboard for result.')
        else:
            print('CMS source sync complete; page queue changed before claim.')
        return
    item=api('/internal/claim',{})['publication'] if queue == 'document' else None
    if item:
        api('/internal/receipt',publish(item,gh))
        print('CMS publication processed; see authenticated dashboard for result.')
    else:
        print('CMS source sync complete; no queued publication.')

if __name__ == '__main__':
    try:
        main()
    except RunnerError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # Do not echo remote bodies, private drafts, credentials, or stack traces.
        print('CMS runner interrupted. Any leased request remains persisted and can resume after its lease expires.',file=sys.stderr)
        raise SystemExit(1)
