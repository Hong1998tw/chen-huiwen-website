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
from validate_achievements import validate as validate_achievements, valid_date
from case_media import classify as classify_media
from achievement_metadata import is_public
from page_seo import validate as validate_seo_overlay
from editorial_pages import read as read_editorial, validate_page as validate_editorial_page, validate_blocks

ORIGIN = 'https://huiwen-cms.lihong.workers.dev'
ROOT = Path(__file__).resolve().parents[1]


class RunnerError(Exception):
    """Only static stage/status diagnostics, never remote bodies or token values."""


def receipt_for_publish_error(receipt, error):
    return {**receipt, 'status': 'queued' if error.retryable else 'failed',
            'message': error.plain()[:1500]}


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


CASE_FIELDS = {'title', 'summary', 'updated', 'paragraphs', 'history', 'sources', 'media', 'imageMetadata'}
CASE_ORDER_FIELDS = {'images', 'sectionOrder'}
DEFAULT_SECTION_ORDER = ['overview', 'media', 'history', 'sources']


def case_candidate(item, root, path, draft):
    if draft.get('fields'):
        raise engine.PublishError('VALIDATION', ['政績結構化草稿不能同時包含舊式頁面文字覆寫'])
    edits = draft.get('case')
    if not isinstance(edits, dict) or set(edits) not in (CASE_FIELDS, CASE_FIELDS | CASE_ORDER_FIELDS):
        raise engine.PublishError('VALIDATION', ['政績專頁欄位格式不正確'])
    baseline = draft.get('caseBase')
    if not isinstance(baseline, dict) or set(baseline) != set(edits):
        raise engine.PublishError('VALIDATION', ['政績草稿缺少原始版本；請重新載入頁面'])
    has_order = CASE_ORDER_FIELDS <= set(edits)
    if has_order and (not isinstance(edits['images'], list) or len(edits['images']) > 24 or
                      not all(isinstance(name, str) and re.fullmatch(r'[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|avif)', name) for name in edits['images']) or
                      not isinstance(edits['sectionOrder'], list) or len(edits['sectionOrder']) != len(DEFAULT_SECTION_ORDER) or
                      not all(isinstance(key, str) for key in edits['sectionOrder']) or
                      sorted(edits['sectionOrder']) != sorted(DEFAULT_SECTION_ORDER)):
        raise engine.PublishError('VALIDATION', ['照片或區塊排序不正確'])
    if not isinstance(edits['title'], str) or not edits['title'].strip() or not isinstance(edits['summary'], str) or not valid_date(edits['updated']):
        raise engine.PublishError('VALIDATION', ['標題、摘要或整理日期不正確'])
    if not isinstance(edits['paragraphs'], list) or len(edits['paragraphs']) > 30 or any(not isinstance(p, str) or not p.strip() or len(p) > 4000 for p in edits['paragraphs']):
        raise engine.PublishError('VALIDATION', ['背景段落格式不正確'])
    if not isinstance(edits['history'], list) or len(edits['history']) > 50 or any(not isinstance(h, dict) or set(h) != {'date', 'title', 'text'} for h in edits['history']):
        raise engine.PublishError('VALIDATION', ['推動歷程格式不正確'])
    if not isinstance(edits['sources'], list) or not 0 < len(edits['sources']) <= 50 or any(not isinstance(s, dict) or set(s) - {'title', 'url', 'sourceType', 'sourceDate'} for s in edits['sources']):
        raise engine.PublishError('VALIDATION', ['資料來源格式不正確'])
    for source in edits['sources']:
        link = source.get('url')
        try:
            parsed = urllib.parse.urlsplit(link)
            host = (parsed.hostname or '').lower()
            safe = (isinstance(link, str) and len(link) <= 1200 and parsed.scheme == 'https' and
                    bool(host) and '.' in host and not parsed.username and not parsed.password and
                    parsed.port in (None, 443) and not re.fullmatch(r'[\d.]+', host) and
                    host not in {'drive.google.com', 'docs.google.com'} and
                    not host.endswith(('.local', '.internal', '.lan', '.home', '.corp')) and
                    not re.search(r'(?:token|api_key|secret|password)=', parsed.query, re.I))
        except (TypeError, ValueError):
            safe = False
        if not safe:
            raise engine.PublishError('VALIDATION', ['資料來源必須是公開 HTTPS 網址'])
    if not isinstance(edits['media'], list) or len(edits['media']) > 24 or any(not isinstance(m, dict) or set(m) != {'kind', 'url', 'alt', 'caption', 'credit', 'publicAccessConfirmed'} or m.get('publicAccessConfirmed') is not True or not classify_media(m.get('url',''), m.get('kind','')) for m in edits['media']):
        raise engine.PublishError('VALIDATION', ['照片或影片網址、公開權限確認不正確'])
    if not isinstance(edits['imageMetadata'], dict):
        raise engine.PublishError('VALIDATION', ['原有照片說明格式不正確'])
    source_path = root / 'data/achievements.json'
    cases = json.loads(source_path.read_text(encoding='utf-8'))
    case_id = path.removeprefix('achievement-').removesuffix('.html')
    match = next((c for c in cases if c.get('id') == case_id), None)
    if not match:
        raise engine.PublishError('VALIDATION', ['找不到此政績專頁的原始資料'])
    for key in CASE_FIELDS:
        default = [] if key == 'media' else {} if key == 'imageMetadata' else None
        if match.get(key, default) != baseline[key]:
            raise engine.PublishError('BASE_DRIFT', ['這筆政績資料已有更新；請重新載入正式頁面後再編輯'])
    if has_order:
        if sorted(edits['images']) != sorted(match.get('images', [])):
            raise engine.PublishError('VALIDATION', ['既有照片只能調整順序，不能在此新增或刪除'])
        if match.get('images', []) != baseline['images'] or match.get('sectionOrder', DEFAULT_SECTION_ORDER) != baseline['sectionOrder']:
            raise engine.PublishError('BASE_DRIFT', ['照片或區塊排序已有更新；請重新載入正式頁面後再編輯'])
    if set(edits['imageMetadata']) - set(match.get('images', [])):
        raise engine.PublishError('VALIDATION', ['照片說明不屬於此頁'])
    overlay = json.loads(page_text(root)).get('pages', {}).get(path, {})
    if overlay.get('edits'):
        raise engine.PublishError('VALIDATION', ['此頁有舊式文字覆寫；請先由網站工程維護對齊後再發布'])
    revised = copy.deepcopy(cases)
    target = next(c for c in revised if c['id'] == case_id)
    target.update(edits)
    if has_order and edits['sectionOrder'] == DEFAULT_SECTION_ORDER and 'sectionOrder' not in match:
        target.pop('sectionOrder', None)
    if not edits['media'] and 'media' not in match:
        target.pop('media', None)
    if not edits['imageMetadata'] and 'imageMetadata' not in match:
        target.pop('imageMetadata', None)
    villages = json.loads((root / 'data/villages.json').read_text(encoding='utf-8'))
    errors, _ = validate_achievements(revised, villages)
    if errors:
        raise engine.PublishError('VALIDATION', ['政績來源或內容檢查未通過；請檢查日期、公開來源與媒體權限'] + errors[:3])
    new_text = json.dumps(revised, ensure_ascii=False, indent=2) + '\n'
    old_text = source_path.read_text(encoding='utf-8')
    digest = engine.sha({'path': path, 'version': item['version'], 'case': edits})
    return engine.Candidate('achievement-content', item['id'], path, edits, item['base_commit'], new_text,
                            new_text != old_text, f'政績：{path}\n操作：publish', digest)


def home_candidate(item, root, draft):
    fields = validate_page_payload({'fields': draft.get('fields', {})})
    published_fields = json.loads(page_text(root)).get('pages', {}).get('index.html', {}).get('edits', {})
    if fields and fields != published_fields:
        raise engine.PublishError('VALIDATION', ['首頁專題選片請與尚未發布的首頁文字分開發布；先發布文字後重新載入'])
    edits, baseline = draft.get('home'), draft.get('homeBase')
    def valid(value):
        if not isinstance(value, dict) or set(value) != {'featured', 'reading', 'summaries'}:
            return False
        ids = [value['featured'], *(value['reading'] if isinstance(value['reading'], list) else [])]
        return (2 <= len(ids) <= 13 and all(isinstance(i, str) and re.fullmatch(r'[a-z0-9-]{1,100}', i) for i in ids)
                and len(set(ids)) == len(ids) and isinstance(value['summaries'], dict)
                and set(value['summaries']) == set(ids)
                and all(isinstance(s, str) and s.strip() and len(s) <= 500 and
                        not re.search(r'[\x00-\x1f\x7f]|<\s*/?[a-z!?]', s, re.I) for s in value['summaries'].values()))
    if not valid(edits) or not valid(baseline):
        raise engine.PublishError('VALIDATION', ['首頁專題排序格式不正確'])
    source = root / 'data/civic-home.json'
    original_text = source.read_text(encoding='utf-8')
    current = json.loads(original_text)
    if current != baseline:
        raise engine.PublishError('BASE_DRIFT', ['首頁專題已有更新；請重新載入正式頁面後再排序'])
    public = {row['id'] for row in json.loads((root / 'data/achievements.json').read_text(encoding='utf-8')) if is_public(row)}
    if not set([edits['featured'], *edits['reading']]) <= public:
        raise engine.PublishError('VALIDATION', ['首頁專題必須是可公開的資料'])
    updated = json.dumps(edits, ensure_ascii=False, indent=2) + '\n'
    digest = engine.sha({'path': 'index.html', 'version': item['version'], 'home': edits})
    return engine.Candidate('home-content', item['id'], 'index.html', edits, item['base_commit'], updated,
                            updated != original_text, '首頁專題順序：index.html\n操作：publish', digest)


def editorial_candidate(item, root, draft):
    path = item['path']
    if draft.get('fields') or not isinstance(draft.get('editorial'), dict):
        raise engine.PublishError('VALIDATION', ['新增專頁不能混用舊式文字覆寫'])
    live_sha = engine.run(['git', 'rev-parse', 'HEAD'], root).stdout.strip()
    try:
        revised = validate_editorial_page(path, draft['editorial'], root)
        source = read_editorial(root)
    except ValueError as error:
        raise engine.PublishError('VALIDATION', [str(error)]) from None
    current = source['pages'].get(path)
    if current != draft.get('editorialBase'):
        raise engine.PublishError('BASE_DRIFT', ['這個專頁已有較新內容；請重新載入'])
    if current is None and (root / path).exists():
        raise engine.PublishError('VALIDATION', ['頁面網址已被現有官網使用'])
    source['pages'][path] = revised
    old_text = (root / 'data/editorial-pages.json').read_text(encoding='utf-8')
    new_text = json.dumps(source, ensure_ascii=False, indent=2) + '\n'
    digest = engine.sha({'path':path,'version':item['version'],'editorial':revised})
    return engine.Candidate('editorial-page', item['id'], path, revised, live_sha, new_text,
                            new_text != old_text, f'新增或編輯專頁：{path}\n操作：publish', digest)


def page_candidate(item, root=ROOT):
    path, operation = item.get('path'), item.get('operation')
    if not isinstance(path, str) or not re.fullmatch(r'(?:[a-z0-9-]+/)*[a-z0-9-]+\.html', path):
        raise engine.PublishError('VALIDATION', ['頁面路徑不在公開頁面範圍'])
    if operation not in {'publish', 'unpublish', 'delete', 'restore'}:
        raise engine.PublishError('VALIDATION', ['頁面操作類型不支援'])
    draft = json.loads(item['payload'])
    if operation == 'publish' and 'editorial' in draft and draft.get('editorial') != draft.get('editorialBase'):
        return editorial_candidate(item, root, draft)
    pages = {row['path']: row for row in catalog(root)}
    page = pages.get(path)
    if not page or page['kind'] in {'system', 'legacy-redirect', 'excluded-intake'}:
        raise engine.PublishError('VALIDATION', ['此頁目前不開放編輯'])
    live_sha = engine.run(['git', 'rev-parse', 'HEAD'], root).stdout.strip()
    stale_base = item.get('base_commit') != live_sha
    structured_case_edit = (operation == 'publish' and isinstance(draft.get('case'), dict) and
                            draft.get('case') != draft.get('caseBase'))
    structured_home_edit = (operation == 'publish' and isinstance(draft.get('home'), dict) and
                            draft.get('home') != draft.get('homeBase'))
    if stale_base and not (structured_case_edit or structured_home_edit):
        raise engine.PublishError('BASE_DRIFT', ['此頁草稿基準早於目前官網版本。草稿已保留；請先確認目前正式頁面，再重新整理草稿。'])
    try:
        state = json.loads(page_text(root))
    except (ValueError, OSError):
        raise engine.PublishError('UNKNOWN_SCHEMA', ['data/page-content.json']) from None
    if not isinstance(state, dict) or state.get('schemaVersion') != 1 or not isinstance(state.get('pages'), dict):
        raise engine.PublishError('UNKNOWN_SCHEMA', ['data/page-content.json'])
    entry = copy.deepcopy(state['pages'].get(path, {'edits': {}}))
    if not isinstance(entry, dict) or set(entry) - {'edits', 'status', 'lastmod', 'seo', 'blocks'}:
        raise engine.PublishError('FORMAT_DRIFT', ['data/page-content.json'])
    if operation == 'publish' and 'case' in draft and (draft.get('case') != draft.get('caseBase') or 'seo' not in draft):
        if 'seo' in draft and draft.get('seo') != draft.get('seoBase'):
            raise engine.PublishError('VALIDATION', ['政績內容與 SEO 請分次發布，避免兩種來源同時改動'])
        if draft.get('blocks') != draft.get('blocksBase'):
            raise engine.PublishError('VALIDATION', ['政績內容與延伸區塊請分次發布，避免兩種來源同時改動'])
        candidate_item = {**item, 'base_commit': live_sha} if stale_base else item
        return case_candidate(candidate_item, root, path, draft)
    if operation == 'publish' and 'home' in draft and draft.get('home') != draft.get('homeBase'):
        if path != 'index.html':
            raise engine.PublishError('VALIDATION', ['首頁專題排序只能用於首頁'])
        if 'seo' in draft and draft.get('seo') != draft.get('seoBase'):
            raise engine.PublishError('VALIDATION', ['首頁專題與 SEO 請分次發布，避免兩種來源同時改動'])
        if draft.get('blocks') != draft.get('blocksBase'):
            raise engine.PublishError('VALIDATION', ['首頁專題與延伸區塊請分次發布，避免兩種來源同時改動'])
        candidate_item = {**item, 'base_commit': live_sha} if stale_base else item
        return home_candidate(candidate_item, root, draft)
    fields = validate_page_payload({'fields': draft.get('fields', {})})
    if operation == 'publish':
        blocks = draft.get('blocks')
        if blocks is not None:
            try:
                blocks = validate_blocks(blocks)
            except ValueError as error:
                raise engine.PublishError('VALIDATION', [str(error)]) from None
            if entry.get('blocks', []) != draft.get('blocksBase', []):
                raise engine.PublishError('BASE_DRIFT', ['頁面區塊已有新版本，請重新載入後台'])
        seo = draft.get('seo')
        if seo is not None:
            try:
                seo = validate_seo_overlay(seo, root)
            except ValueError as error:
                raise engine.PublishError('VALIDATION', [str(error)]) from None
        changed_fields = entry.get('edits', {}) != fields or entry.get('status', 'published') != 'published' or (seo is not None and entry.get('seo') != seo) or (blocks is not None and entry.get('blocks', []) != blocks)
        entry['edits'] = fields
        if blocks is not None:
            entry['blocks'] = blocks
        if seo is not None:
            entry['seo'] = seo
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
                raise engine.PublishError('STALE_CHECKOUT', retryable=True)
            outcome, pr = engine.ensure_pull_request(gh, candidate,
                lambda: engine.git_push(os.environ['GH_TOKEN'])(wt, candidate, title), title,
                f"Owner-approved page revision {item['version']}.\n\nPage: `{item['path']}`\nOperation: `{item['operation']}`\nBuild, canonical source, publication path and required checks are enforced.\nCandidate digest: `{candidate.digest}`")
            if outcome != 'ALREADY_MERGED':
                gh.enable_auto_merge(pr['number'], expected_head_sha=gh.branch_sha(candidate.branch))
        return {**receipt, 'status': 'pr_created', 'pr_number': pr['number'], 'message': '頁面發布請求已建立；正在等待必要檢查與正式站部署。'}
    except engine.PublishError as error:
        return receipt_for_publish_error(receipt, error)


def reconcile_page(item, gh):
    _, pr = gh.request('GET', f"/pulls/{int(item['pr_number'])}")
    if pr.get('state') == 'closed' and not pr.get('merged_at'):
        return {'id': item['id'], 'status': 'closed', 'message': '發布請求已關閉，頁面維持原狀。'}
    payload = json.loads(item['payload'])
    domain = 'editorial-page' if item['operation'] == 'publish' and payload.get('editorial') != payload.get('editorialBase') and 'editorial' in payload else \
        'achievement-content' if item['operation'] == 'publish' and 'case' in payload and (payload.get('case') != payload.get('caseBase') or 'seo' not in payload) else \
        'home-content' if item['operation'] == 'publish' and payload.get('home') != payload.get('homeBase') and 'home' in payload else 'page-copy'
    layers, revision = engine.layered_status(gh, item['pr_number'], domain, item['path'], item['operation'],
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
                raise engine.PublishError('STALE_CHECKOUT', retryable=True)
            outcome, pr = engine.ensure_pull_request(gh, candidate,
                lambda: engine.git_push(os.environ['GH_TOKEN'])(wt,candidate,title), title,
                f"Owner-approved CMS revision {item['version']}.\n\nBuild, canonical source, and publication path checks are required.\nCandidate digest: {candidate.digest}")
            if outcome != 'ALREADY_MERGED':
                gh.enable_auto_merge(pr['number'], expected_head_sha=gh.branch_sha(candidate.branch))
        return {**receipt, 'status':'pr_created', 'pr_number':pr['number'], 'message':'發布請求已建立；正在等待必要檢查及自動合併。'}
    except engine.PublishError as error:
        return receipt_for_publish_error(receipt, error)


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
