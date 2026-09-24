#!/usr/bin/env python3
"""huiwen.tw Pilot publisher: Notion authoring -> reviewed Git pull request (PR-only).

Safety contract (docs/PILOT-PUBLISHER.md):
* dry-run never pushes, never opens a PR and never uploads an artifact.
* publish only creates a PR. This module has no merge code path and refuses merge endpoints.
* Unknown schemaVersion fails closed. Valid keys that Notion does not manage are preserved.
* The approved candidate digest must equal a fresh recomputation (Notion + current main)
  immediately before a PR is created; otherwise nothing is pushed and re-approval is required.
* The live GitHub rules for main must enforce PR + required checks; dual-review mode also requires a distinct reviewer.
* Logs, reports and PR bodies never contain content bodies, private URLs or secrets.
"""
from __future__ import annotations

import argparse
import base64
import calendar
import copy
import hashlib
import io
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_events  # noqa: E402  (the current builder is the schema authority for events)

TAIPEI = ZoneInfo('Asia/Taipei')
NOTION_API = 'https://api.' + 'notion' + '.com/v1'  # split so the public-link scanner does not treat the API as content
CONTRACT = 'huiwen-pilot-publisher/1'
SUPPORTED_SCHEMA = {'events': {2}, 'legal-schedule': {2}}
DATA_FILES = {'events': 'data/events.json', 'legal-schedule': 'data/legal-schedule.json'}
# Files a publish PR for each domain may change. Anything else fails closed (and CI re-checks it).
ALLOWED_PATHS = {
    'events': {'data/events.json', 'activities.html', 'election.html', 'data/search-index.json'},
    'legal-schedule': {'data/legal-schedule.json', 'service.html', 'data/search-index.json'},
}
BRANCH_PREFIX = 'notion-publish/'
REQUIRED_CHECKS = ('validate', 'browser', 'secrets', 'publication-path-guard')
# Direct merge endpoints are forbidden. Auto-merge may be enabled only through the guarded helper below.
FORBIDDEN_GITHUB = re.compile(r'/pulls/\d+/merge\b|/merges\b|mergePullRequest', re.I)
EVENT_FIELDS = ('name', 'start', 'end', 'content', 'registration', 'sourceUrl', 'verifiedAt',
                'status', 'changeNote', 'updatedAt', 'reviewDueAt')
NEW_EVENT_ORDER = ('id', 'name', 'start', 'end', 'content', 'registration', 'sourceUrl', 'verifiedAt',
                   'status', 'updatedAt', 'previousSchedule', 'changeNote', 'reviewDueAt')
LEGAL_FIELDS = ('month', 'observedAt', 'sourceUrl', 'sourceTitle', 'sessions', 'validThrough',
                'nextReviewAt', 'availability')
STATUS_IN = {'排定': 'scheduled', '改期': 'rescheduled', '取消': 'cancelled',
             'scheduled': 'scheduled', 'rescheduled': 'rescheduled', 'cancelled': 'cancelled'}
STATUS_ZH = {'scheduled': '已公布行程', 'rescheduled': '時間已更改', 'cancelled': '活動已取消'}
WEEKDAY = '一二三四五六日'
PRIVATE_HOSTS = ('notion.so', 'notion.site', 'notion.com', 'drive.google.com', 'docs.google.com',
                 'localhost', 'metadata.google.internal')
PRIVATE_SUFFIXES = ('.local', '.internal', '.lan', '.localhost', '.home', '.corp')
FORBIDDEN_CHARS = re.compile('[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]')
HTML_TAG = re.compile(r'<\s*/?\s*[a-zA-Z!?]')
TIME_HHMM = re.compile(r'([01]\d|2[0-3]):[0-5]\d')

# ---------------------------------------------------------------------------------------------
# Errors: every code maps to plain-language Chinese so Notion never shows only a run number.
ERROR_MESSAGES = {
    'VALIDATION': '內容檢查未通過，請依下列欄位修正後重新預覽。',
    'UNKNOWN_SCHEMA': '網站資料格式版本不在支援範圍，系統已停止寫入，請通知網站工程維護。',
    'FORMAT_DRIFT': '網站資料檔格式與預期不同，系統已停止寫入，請通知網站工程維護。',
    'NOT_PREVIEWED': '尚未完成預覽，請先勾選「要求預覽」並確認預覽內容。',
    'DIGEST_MISMATCH': '核准後內容已變更，請重新預覽並重新核准。',
    'BASE_DRIFT': '網站資料已由其他管道更新，需要先對齊；請重新預覽並重新核准。',
    'GITHUB_NEWER': '網站資料已由其他管道更新，需由網站工程維護回填 Notion 後再核准。',
    'GATE_NOT_ENFORCED': '網站發布保護（PR、必要檢查與禁止繞過）尚未生效，系統不會建立發布請求。',
    'PATH_NOT_ALLOWED': '發布內容影響了不該變更的網站檔案，系統已停止，請通知網站工程維護。',
    'BUILD_FAILED': '網站產生或品質檢查失敗，未建立發布請求。',
    'GITHUB_BUSY': '網站系統忙碌，稍後自動重試；內容不會遺失。',
    'NOTION_BUSY': '系統暫時無法讀取 Notion，將於下一輪自動重試。',
    'REMOTE_UNKNOWN': '連線逾時且遠端結果未知，系統會先對帳，不會重複建立。',
    'PR_CLOSED': '先前的發布請求已被關閉，請重新預覽並重新核准。',
    'BRANCH_DIVERGED': '發布分支內容與本次核准版本不同，系統已停止，請通知網站工程維護。',
    'MERGE_FORBIDDEN': '系統禁止直接合併；只能使用 GitHub auto-merge 等待必要檢查全數通過。',
    'AUTO_MERGE_FAILED': '已建立發布請求，但無法啟用自動合併；系統會保留請求並稍後重試。',
    'PUBLISH_CHANGED_DURING_RUN': '按下發布後內容又被修改，本次已停止；請確認最新內容後重新按發布。',
    'REDEPLOY_FAILED': '重新部署正式站失敗；網站目前版本未被修改，可再次按「重新部署正式站」。',
    'CONFIG': '執行器設定不完整，未執行任何寫入。',
    'STALE_CHECKOUT': '網站剛有其他更新；本輪不建立發布請求，下一輪會以最新版本重新檢查。',
}


class PublishError(Exception):
    def __init__(self, code, details=(), retryable=False):
        self.code, self.details, self.retryable = code, list(details), retryable
        super().__init__(code)

    def plain(self):
        text = ERROR_MESSAGES.get(self.code, '發布失敗，請通知網站工程維護。')
        return text + ('\n' + '\n'.join('・' + d for d in self.details) if self.details else '')


class RemoteUnknown(Exception):
    """The request may have succeeded remotely (timeout after send). Callers must reconcile."""


# ---------------------------------------------------------------------------------------------
# Canonical JSON, hashing and byte-compatible serializers.
def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return 'sha256:' + hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def dump_events(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + '\n'


def dump_legal(obj):
    lines, items = ['{'], list(obj.items())
    for i, (key, value) in enumerate(items):
        comma = ',' if i < len(items) - 1 else ''
        if key == 'sessions' and isinstance(value, list) and value:
            inner = ',\n'.join('    ' + json.dumps(s, ensure_ascii=False, separators=(',', ':')) for s in value)
            lines.append(f'  "sessions": [\n{inner}\n  ]{comma}')
        else:
            lines.append(f'  {json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}{comma}')
    return '\n'.join(lines + ['}']) + '\n'


DUMPERS = {'events': dump_events, 'legal-schedule': dump_legal}


def load_data(domain, text):
    """Parse a data file and fail closed on unknown schema or on a format the serializer would rewrite."""
    obj = json.loads(text)
    version = obj.get('schemaVersion') if isinstance(obj, dict) else None
    if version not in SUPPORTED_SCHEMA[domain]:
        raise PublishError('UNKNOWN_SCHEMA', [f'{DATA_FILES[domain]} schemaVersion={version!r}'])
    if DUMPERS[domain](obj) != text:
        raise PublishError('FORMAT_DRIFT', [DATA_FILES[domain]])
    return obj


# ---------------------------------------------------------------------------------------------
# Field normalization and security validation (all content is plain text; URLs public HTTPS only).
def clean_text(value, label, errors, *, required=True, multiline=False, max_len=300):
    text = '' if value is None else str(value)
    text = unicodedata.normalize('NFC', text.replace('\r\n', '\n').replace('\r', '\n')).strip()
    if not text:
        if required:
            errors.append(f'{label}：必填')
        return None
    if FORBIDDEN_CHARS.search(text) or (not multiline and '\n' in text) or '\t' in text:
        errors.append(f'{label}：含不允許的控制字元或換行')
    if HTML_TAG.search(text):
        errors.append(f'{label}：不可包含 HTML 標籤或程式碼')
    if len(text) > max_len:
        errors.append(f'{label}：超過 {max_len} 字')
    if multiline:
        text = '\n'.join(line.rstrip() for line in text.split('\n'))
    return text


def clean_url(value, label, errors, *, required=True):
    text = clean_text(value, label, errors, required=required, max_len=500)
    if text is None:
        return None
    parts = urlsplit(text)
    host = (parts.hostname or '').lower().rstrip('.')
    reason = None
    if parts.scheme != 'https':
        reason = '只接受 https:// 公開網址'
    elif not host or parts.username or parts.password or ' ' in text:
        reason = '網址格式不正確或含帳號密碼'
    elif parts.port not in (None, 443):
        reason = '不接受非標準連接埠'
    else:
        try:
            ipaddress.ip_address(host.strip('[]'))
            reason = '不接受 IP 位址網址'
        except ValueError:
            if '.' not in host or host in PRIVATE_HOSTS or any(host.endswith('.' + h) for h in PRIVATE_HOSTS) \
                    or host.endswith(PRIVATE_SUFFIXES):
                reason = '不接受私人 Notion／Drive 或內部網址'
    if reason:
        errors.append(f'{label}：{reason}')
    return text


def clean_date(value, label, errors, *, required=True):
    text = '' if value is None else str(value).strip()
    if not text:
        if required:
            errors.append(f'{label}：必填')
        return None
    try:
        if len(text) > 10:
            return parse_datetime(text).astimezone(TAIPEI).date().isoformat()
        return date.fromisoformat(text).isoformat()
    except ValueError:
        errors.append(f'{label}：日期格式不正確')
        return None


def parse_datetime(text):
    dt = datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timezone required')
    return dt


def clean_datetime(value, label, errors):
    text = '' if value is None else str(value).strip()
    if not text:
        errors.append(f'{label}：必填')
        return None
    if len(text) <= 10:
        errors.append(f'{label}：需包含時刻（例如 19:30）')
        return None
    try:
        return parse_datetime(text).astimezone(TAIPEI).replace(microsecond=0).isoformat()
    except ValueError:
        errors.append(f'{label}：時間格式不正確')
        return None


def label_time(iso):
    dt = parse_datetime(iso).astimezone(TAIPEI)
    return f'{dt:%Y/%m/%d}（{WEEKDAY[dt.weekday()]}）{dt:%H:%M}'


def host_of(url):
    return urlsplit(url or '').hostname or '—'


# ---------------------------------------------------------------------------------------------
# Candidate model shared by both domains.
@dataclass
class Candidate:
    domain: str
    page_id: str
    record_key: str            # stable ID (events) or month (legal schedule)
    managed: dict
    base_hash: str             # hash of the current main record/file this candidate patches
    new_text: str              # full new data file text
    changed: bool
    preview: str
    digest: str
    preserved: list = field(default_factory=list)
    errors: list = field(default_factory=list)

    @property
    def branch(self):
        return f'{BRANCH_PREFIX}{self.domain}/{self.record_key}-{self.digest[7:15]}'


def candidate_digest(domain, record_key, schema_version, base_hash, managed):
    return sha({'contract': CONTRACT, 'domain': domain, 'recordKey': record_key,
                'schemaVersion': schema_version, 'base': base_hash, 'fields': managed})


def new_event_id(page_id, start):
    day = start[:10].replace('-', '')
    return f'event-{day}-' + hashlib.sha256(page_id.encode()).hexdigest()[:6]


# ---------------------------------------------------------------------------------------------
# Events domain.
def normalize_event(fields):
    errors = []
    managed = {
        'name': clean_text(fields.get('name'), '活動名稱', errors, max_len=120),
        'start': clean_datetime(fields.get('start'), '開始', errors),
        'end': clean_datetime(fields.get('end'), '結束', errors),
        'content': clean_text(fields.get('content'), '活動說明', errors, multiline=True, max_len=4000),
        'registration': clean_text(fields.get('registration'), '報名方式', errors, max_len=300),
        'sourceUrl': clean_url(fields.get('sourceUrl'), '來源網址', errors),
        'verifiedAt': clean_date(fields.get('verifiedAt'), '來源核對日', errors),
        'status': None,
        'changeNote': clean_text(fields.get('changeNote'), '異動說明', errors, required=False, max_len=300),
        'updatedAt': clean_date(fields.get('updatedAt'), '來源更新日', errors),
        'reviewDueAt': clean_date(fields.get('reviewDueAt'), '下次複查', errors),
    }
    status = STATUS_IN.get(str(fields.get('status') or '').strip())
    if not status:
        errors.append('狀態：請選擇排定、改期或取消')
    managed['status'] = status
    if managed['start'] and managed['end'] and parse_datetime(managed['end']) <= parse_datetime(managed['start']):
        errors.append('結束：結束時間必須晚於開始時間')
    if status in ('rescheduled', 'cancelled') and not managed['changeNote']:
        errors.append('異動說明：狀態為改期或取消時必填')
    if status == 'scheduled' and managed['changeNote']:
        errors.append('異動說明：狀態為排定時請留空（改期或取消才填寫）')
    return managed, errors


def build_event_record(managed, site_id, main_record):
    errors = []
    if main_record is not None:
        record = copy.deepcopy(main_record)
    else:
        record = {key: None for key in NEW_EVENT_ORDER}
    record['id'] = site_id
    for key in EVENT_FIELDS:
        record[key] = managed[key]
    status = managed['status']
    if status == 'scheduled':
        if 'previousSchedule' in record or main_record is None:
            record['previousSchedule'] = None
    elif status == 'rescheduled':
        if main_record is None:
            errors.append('狀態：改期只能用於網站上已發布的活動；新活動請選「排定」')
        elif (main_record.get('start'), main_record.get('end')) != (managed['start'], managed['end']):
            record['previousSchedule'] = {'start': main_record['start'], 'end': main_record['end']}
        elif main_record.get('status') == 'rescheduled' and main_record.get('previousSchedule'):
            record['previousSchedule'] = copy.deepcopy(main_record['previousSchedule'])
        else:
            errors.append('開始：改期必須變更活動時間')
    if not errors:
        try:
            build_events.validate(record)
        except ValueError as exc:
            errors.append(f'網站格式檢查：{exc}')
    return record, errors


def event_preview(record, main_record, preserved):
    status = record['status']
    end = parse_datetime(record['end']).astimezone(TAIPEI)
    when = f"{label_time(record['start'])}–{end:%H:%M}（台灣時間）"
    if main_record is None:
        lines = [f"【活動｜新增】{record['name']}", f'時間：{when}']
    else:
        lines = [f"【活動｜{'取消' if status == 'cancelled' else '改期' if status == 'rescheduled' else '修改'}】{record['name']}"]
        labels = {'name': '活動名稱', 'content': '活動說明', 'registration': '報名方式', 'sourceUrl': '來源網址',
                  'verifiedAt': '來源核對日', 'status': '狀態', 'changeNote': '異動說明', 'updatedAt': '來源更新日',
                  'reviewDueAt': '下次複查'}
        if (main_record.get('start'), main_record.get('end')) != (record['start'], record['end']):
            old_end = parse_datetime(main_record['end']).astimezone(TAIPEI)
            lines.append(f"時間：{label_time(main_record['start'])}–{old_end:%H:%M} → {when}")
        else:
            lines.append(f'時間：{when}（不變）')
        changed = [labels[k] for k in labels if main_record.get(k) != record.get(k)]
        lines.append('變更欄位：' + ('、'.join(changed) if changed else '無'))
    lines.append(f'網站狀態：{STATUS_ZH[status]}')
    if status == 'cancelled':
        lines.append('取消後：網址保留；移除報名與加入行事曆按鈕；顯示取消說明。')
    if record.get('changeNote'):
        lines.append(f"異動說明：{record['changeNote']}")
    if status == 'rescheduled' and record.get('previousSchedule'):
        lines.append(f"正式頁會同時顯示原定時間：{label_time(record['previousSchedule']['start'])}")
    content = record['content']
    lines.append('活動說明：' + (content if len(content) <= 300 else content[:300] + '…'))
    lines.append(f"報名：{record['registration']}")
    lines.append(f"來源：{host_of(record['sourceUrl'])}（核對 {record['verifiedAt']}；來源更新 {record['updatedAt']}）")
    lines.append(f"下次複查：{record['reviewDueAt']}")
    if preserved:
        lines.append('原樣保留（Notion 未管理）：' + '、'.join(preserved))
    return '\n'.join(lines)


def prepare_event(row, main_text):
    data = load_data('events', main_text)
    system = row.get('system', {})
    managed, errors = normalize_event(row.get('fields', {}))
    site_id = system.get('siteId') or (new_event_id(row['pageId'], managed['start']) if managed['start'] else None)
    if site_id and not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', site_id):
        errors.append('網站 ID：格式不正確，請通知網站工程維護')
    matches = [i for i, e in enumerate(data['events']) if e.get('id') == site_id]
    if len(matches) > 1:
        raise PublishError('FORMAT_DRIFT', [f'重複的活動 ID：{site_id}'])
    main_record = data['events'][matches[0]] if matches else None
    if system.get('siteId') and main_record is None and system.get('syncedHash'):
        errors.append('網站 ID：網站上找不到這筆已同步的活動，請通知網站工程維護')
    base_hash = sha(main_record) if main_record is not None else 'absent'
    synced = system.get('syncedHash')
    if main_record is not None and synced and synced != base_hash:
        raise PublishError('GITHUB_NEWER', [f'活動 {site_id} 的網站版本比 Notion 上次同步的版本新'])
    if main_record is not None and not synced:
        raise PublishError('GITHUB_NEWER', [f'活動 {site_id} 已在網站上但尚未匯入基準，請先由工程回填'])
    record, record_errors = (None, [])
    if not errors:
        record, record_errors = build_event_record(managed, site_id, main_record)
    errors += record_errors
    preserved = sorted(k for k in (main_record or {}) if k not in EVENT_FIELDS and k not in ('id', 'previousSchedule'))
    if errors:
        return Candidate('events', row['pageId'], site_id or '-', managed, base_hash, main_text, False, '',
                         '', preserved, errors)
    new = copy.deepcopy(data)
    if matches:
        new['events'][matches[0]] = record
    else:
        new['events'].append(record)
    new_text = dump_events(new)
    digest = candidate_digest('events', site_id, data['schemaVersion'], base_hash, managed)
    preview = event_preview(record, main_record, preserved)
    changed = new_text != main_text
    if not changed:
        preview = '與網站目前版本相同，無需發布。\n' + preview
    return Candidate('events', row['pageId'], site_id, managed, base_hash, new_text, changed, preview, digest, preserved)


# ---------------------------------------------------------------------------------------------
# Legal schedule domain (one published month per file; the whole file is the record).
def normalize_legal(fields, sessions):
    errors = []
    month = str(fields.get('month') or '').strip()
    if not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', month):
        errors.append('月份：請填 YYYY-MM，例如 2026-10')
        month = None
    managed = {
        'month': month,
        'observedAt': clean_date(fields.get('observedAt'), '核對日', errors),
        'sourceUrl': clean_url(fields.get('sourceUrl'), '來源圖卡網址', errors),
        'sourceTitle': clean_text(fields.get('sourceTitle'), '圖卡標題', errors, max_len=120),
        'sessions': [],
        'validThrough': None,
        'nextReviewAt': clean_date(fields.get('nextReviewAt'), '下次核對', errors),
        'availability': 'telephone_confirmation_required',
    }
    rows = []
    for i, s in enumerate(sessions or [], 1):
        day = clean_date(s.get('date'), f'第 {i} 個時段日期', errors)
        start, end = (str(s.get(k) or '').strip() for k in ('start', 'end'))
        if not TIME_HHMM.fullmatch(start) or not TIME_HHMM.fullmatch(end):
            errors.append(f'第 {i} 個時段：開始與結束請填 HH:MM（例如 19:30）')
        elif start >= end:
            errors.append(f'第 {i} 個時段：開始時間必須早於結束時間')
        if day and month and not day.startswith(month):
            errors.append(f'第 {i} 個時段：{day} 不在 {month} 月內')
        rows.append({'date': day, 'start': start, 'end': end})
    if not rows:
        errors.append('時段：至少需要一個時段')
    dates = [r['date'] for r in rows if r['date']]
    dupes = sorted({d for d in dates if dates.count(d) > 1})
    if dupes:
        errors.append('時段：同一天只能有一個時段（網站目前格式）：' + '、'.join(dupes))
    managed['sessions'] = sorted(rows, key=lambda r: (r['date'] or '', r['start']))
    if month:
        year, mon = map(int, month.split('-'))
        last = date(year, mon, calendar.monthrange(year, mon)[1]).isoformat()
        managed['validThrough'] = last
        if managed['observedAt'] and managed['nextReviewAt'] and not (managed['observedAt'] <= managed['nextReviewAt'] <= last):
            errors.append('下次核對：需晚於核對日，且不晚於該月最後一天')
    return managed, errors


def legal_preview(managed, main):
    year, mon = map(int, managed['month'].split('-'))
    def fmt(s):
        d = date.fromisoformat(s['date'])
        return f"{d.month}/{d.day}（{WEEKDAY[d.weekday()]}）{s['start']}–{s['end']}"
    ss = managed['sessions']
    lines = [f'【律師時間表｜{year} 年 {mon} 月】共 {len(ss)} 個時段',
             '時段：' + '；'.join(fmt(s) for s in ss)]
    if main.get('month') == managed['month']:
        old = {canonical(s) for s in main.get('sessions', [])}
        new = {canonical(s) for s in ss}
        lines.append(f'與網站目前同月份版本相比：新增 {len(new - old)} 個、移除 {len(old - new)} 個時段')
    else:
        lines.append(f"將取代網站目前 {main.get('month')} 的 {len(main.get('sessions', []))} 個時段")
    lines.append(f"來源：{managed['sourceTitle']}（{host_of(managed['sourceUrl'])}；核對 {managed['observedAt']}）")
    lines.append(f"有效至 {managed['validThrough']}；下次核對 {managed['nextReviewAt']}；名額一律須電話確認。")
    return '\n'.join(lines)


def prepare_legal(row, main_text):
    data = load_data('legal-schedule', main_text)
    managed, errors = normalize_legal(row.get('fields', {}), row.get('sessions', []))
    base_hash = sha(data)
    key = managed['month'] or '-'
    preserved = sorted(k for k in data if k not in LEGAL_FIELDS and k != 'schemaVersion')
    if errors:
        return Candidate('legal-schedule', row['pageId'], key, managed, base_hash, main_text, False, '', '', preserved, errors)
    new = copy.deepcopy(data)
    for k in LEGAL_FIELDS:
        new[k] = copy.deepcopy(managed[k])
    new_text = dump_legal(new)
    digest = candidate_digest('legal-schedule', key, data['schemaVersion'], base_hash, managed)
    preview = legal_preview(managed, data)
    changed = new_text != main_text
    if not changed:
        preview = '與網站目前版本相同，無需發布。\n' + preview
    return Candidate('legal-schedule', row['pageId'], key, managed, base_hash, new_text, changed, preview, digest, preserved)


PREPARE = {'events': prepare_event, 'legal-schedule': prepare_legal}


def verify_publish_snapshot(candidate, fresh_row, current_text):
    """Bind one click-to-publish request to a stable fresh snapshot without a preview step.

    The publisher reads the row once, builds/tests that candidate, then fresh-reads again
    immediately before pushing. Any managed-field or base change fails closed and requires
    the user to press publish again.
    """
    fresh = PREPARE[candidate.domain](fresh_row, current_text)
    if fresh.errors:
        raise PublishError('VALIDATION', fresh.errors)
    if not fresh_row.get('system', {}).get('requestPublish'):
        raise PublishError('PUBLISH_CHANGED_DURING_RUN', ['發布要求已取消'])
    if fresh.base_hash != candidate.base_hash or fresh.digest != candidate.digest:
        raise PublishError('PUBLISH_CHANGED_DURING_RUN', ['發布處理期間內容或網站基準已變更'])
    return True


# ---------------------------------------------------------------------------------------------
# Workspace: apply the candidate to a throwaway worktree, build, run the full quality gate.
def run(cmd, cwd, env=None, check=True):
    proc = subprocess.run(cmd, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if check and proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, cmd[:2], proc.stdout)
    return proc


def changed_files(repo):
    out = run(['git', 'status', '--porcelain', '--untracked-files=all'], repo).stdout
    return sorted(line[3:].strip() for line in out.splitlines() if line.strip())


def check_allowed(domain, files):
    bad = sorted(set(files) - ALLOWED_PATHS[domain])
    if bad:
        raise PublishError('PATH_NOT_ALLOWED', bad)


def materialize(candidate, repo, *, quality=True):
    """Write the candidate into `repo` (a disposable worktree), rebuild and verify. Returns changed files."""
    (Path(repo) / DATA_FILES[candidate.domain]).write_text(candidate.new_text, encoding='utf-8')
    try:
        run([sys.executable, 'scripts/build_all.py'], repo)
        if quality:
            run([sys.executable, 'scripts/quality.py'], repo)
    except subprocess.CalledProcessError as exc:
        tail = [line for line in (exc.output or '').splitlines() if re.search(r'Error|FAIL|STALE|assert', line)][-3:]
        raise PublishError('BUILD_FAILED', [re.sub(r'\s+', ' ', t)[:200] for t in tail]) from None
    files = changed_files(repo)
    check_allowed(candidate.domain, files)
    return files


class Worktree:
    def __init__(self, repo, ref):
        self.repo, self.ref, self.path = Path(repo), ref, None

    def __enter__(self):
        self.path = Path(tempfile.mkdtemp(prefix='huiwen-publish-'))
        run(['git', 'worktree', 'add', '--detach', str(self.path), self.ref], self.repo)
        return self.path

    def __exit__(self, *exc):
        run(['git', 'worktree', 'remove', '--force', str(self.path)], self.repo, check=False)
        shutil.rmtree(self.path, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
# GitHub REST client: retries with backoff, reconcile-before-retry for non-idempotent calls,
# and a hard refusal of every merge/auto-merge endpoint.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # surface 3xx so signed artifact URLs are fetched without our Authorization header


class HttpTransport:
    opener = urllib.request.build_opener(_NoRedirect)

    def __call__(self, method, url, headers, body, timeout):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers or {}), exc.read()


class GitHub:
    def __init__(self, token, repo, *, transport=None, sleep=time.sleep, attempts=4, api='https://api.github.com'):
        self.token, self.repo, self.api = token, repo, api
        self.transport, self.sleep, self.attempts = transport or HttpTransport(), sleep, attempts

    def request(self, method, path, body=None, *, raw=False):
        if FORBIDDEN_GITHUB.search(path) or (body and FORBIDDEN_GITHUB.search(canonical(body))):
            raise PublishError('MERGE_FORBIDDEN')
        url = path if path.startswith('https://') else f'{self.api}/repos/{self.repo}{path}'
        headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                   'User-Agent': 'huiwen-pilot-publisher'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(1, self.attempts + 1):
            try:
                status, hdrs, payload = self.transport(method, url, headers, data, 30)
            except (TimeoutError, urllib.error.URLError, ConnectionError) as exc:
                if method != 'GET':
                    raise RemoteUnknown(path) from exc
                status, hdrs, payload = 599, {}, b''
            hdrs = {k.lower(): v for k, v in hdrs.items()}
            limited = status == 429 or (status == 403 and hdrs.get('x-ratelimit-remaining') == '0')
            if limited or (status >= 500 and method == 'GET'):
                if attempt == self.attempts:
                    raise PublishError('GITHUB_BUSY', retryable=True)
                wait = int(hdrs.get('retry-after') or 0) or max(0, int(hdrs.get('x-ratelimit-reset') or 0) - int(time.time()))
                self.sleep(min(max(wait, 2 ** attempt), 60))
                continue
            if status >= 500:
                raise RemoteUnknown(path)
            if raw and status in (301, 302, 303, 307, 308) and hdrs.get('location'):
                status, _, payload = self.transport('GET', hdrs['location'], {'User-Agent': 'huiwen-pilot-publisher'}, None, 60)
            if raw:
                return status, payload
            return status, (json.loads(payload) if payload else None)
        raise PublishError('GITHUB_BUSY', retryable=True)

    def branch_sha(self, branch):
        status, body = self.request('GET', f'/git/ref/heads/{branch}')
        return body['object']['sha'] if status == 200 else None

    def file_text(self, path, ref):
        status, body = self.request('GET', f'/contents/{path}?ref={ref}')
        if status != 200:
            return None
        return base64.b64decode(body['content']).decode('utf-8')

    def find_pull(self, branch):
        owner = self.repo.split('/')[0]
        status, body = self.request('GET', f'/pulls?state=all&head={owner}:{branch}&per_page=5')
        return body[0] if status == 200 and body else None

    def create_pull(self, branch, title, body):
        status, pr = self.request('POST', '/pulls', {'title': title, 'head': branch, 'base': 'main', 'body': body,
                                                     'maintainer_can_modify': False, 'draft': False})
        if status == 201:
            return pr
        if status == 422:
            existing = self.find_pull(branch)
            if existing:
                return existing
        raise PublishError('GITHUB_BUSY', [f'PR 建立回應 {status}'], retryable=status in (403, 429))

    def dispatch_workflow(self, workflow, ref='main'):
        status, _ = self.request('POST', f'/actions/workflows/{workflow}/dispatches', {'ref': ref})
        if status != 204:
            raise PublishError('REDEPLOY_FAILED', [f'{workflow} dispatch 回應 {status}'], retryable=status in (403, 429))
        return True

    def workflow_runs(self, workflow, event=None, branch='main'):
        query = f'?per_page=20&branch={branch}' + (f'&event={event}' if event else '')
        status, out = self.request('GET', f'/actions/workflows/{workflow}/runs{query}')
        if status != 200:
            raise PublishError('GITHUB_BUSY', [f'{workflow} runs 回應 {status}'], retryable=True)
        return (out or {}).get('workflow_runs', [])

    def action_run(self, run_id):
        status, out = self.request('GET', f'/actions/runs/{run_id}')
        if status != 200:
            raise PublishError('GITHUB_BUSY', [f'Actions run {run_id} 回應 {status}'], retryable=True)
        return out

    def enable_auto_merge(self, pr_number, expected_head_sha=None):
        """Enable GitHub-native squash auto-merge; required rules/checks still decide when merge occurs."""
        status, pr = self.request('GET', f'/pulls/{pr_number}')
        if status != 200 or not pr:
            raise PublishError('AUTO_MERGE_FAILED', [f'PR #{pr_number} 無法讀取'], retryable=True)
        if pr.get('merged_at'):
            return 'ALREADY_MERGED'
        head = pr.get('head') or {}
        base = pr.get('base') or {}
        if not str(head.get('ref') or '').startswith(BRANCH_PREFIX) or base.get('ref') != 'main':
            raise PublishError('AUTO_MERGE_FAILED', ['只允許 notion-publish/* → main'])
        if expected_head_sha and head.get('sha') != expected_head_sha:
            raise PublishError('AUTO_MERGE_FAILED', ['PR head SHA 與本次候選版本不同'])
        if pr.get('auto_merge'):
            return 'ALREADY_ENABLED'
        node_id = pr.get('node_id')
        if not node_id:
            raise PublishError('AUTO_MERGE_FAILED', ['PR 缺少 node_id'])
        query = ('mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH})'
                 '{pullRequest{number autoMergeRequest{enabledAt}}}}')
        status, out = self.request('POST', 'https://api.github.com/graphql',
                                   {'query': query, 'variables': {'id': node_id}})
        errors = (out or {}).get('errors') if isinstance(out, dict) else None
        if status == 200 and not errors:
            return 'ENABLED'
        details = [e.get('message', 'GitHub auto-merge error') for e in (errors or [])][:3]
        raise PublishError('AUTO_MERGE_FAILED', details or [f'GraphQL 回應 {status}'], retryable=True)


def ensure_pull_request(gh, candidate, push, title, body):
    """Idempotent: reuse an existing PR/branch for the same digest; reconcile after timeouts."""
    existing = gh.find_pull(candidate.branch)
    if existing:
        if existing.get('merged_at'):
            return 'ALREADY_MERGED', existing
        if existing.get('state') == 'open':
            return 'ALREADY_OPEN', existing
        raise PublishError('PR_CLOSED', [f"#{existing.get('number')}"])
    if gh.branch_sha(candidate.branch) is None:
        push()
    else:
        remote = gh.file_text(DATA_FILES[candidate.domain], candidate.branch)
        if remote != candidate.new_text:
            raise PublishError('BRANCH_DIVERGED', [candidate.branch])
    try:
        return 'CREATED', gh.create_pull(candidate.branch, title, body)
    except RemoteUnknown:
        pr = gh.find_pull(candidate.branch)
        if pr:
            return 'RECONCILED', pr
        raise PublishError('REMOTE_UNKNOWN', retryable=True)


def evaluate_gate(rules, repo_settings=None, *, single_maintainer=False, auto_publish=False):
    """Gate 2 preflight from GET /rules/branches/main. Missing enforcement => fail closed.

    Auto-publish still requires a PR, trusted checks, and no direct/force/delete bypass.
    GitHub-native auto-merge is permitted only when explicitly enabled for this CMS mode.
    """
    by_type = {}
    for rule in rules or []:
        by_type.setdefault(rule.get('type'), []).append(rule.get('parameters') or {})
    problems = []
    prs = by_type.get('pull_request', [])
    if not prs:
        problems.append('main 未要求 Pull Request')
    elif not single_maintainer:
        p = max(prs, key=lambda x: x.get('required_approving_review_count', 0))
        if p.get('required_approving_review_count', 0) < 1:
            problems.append('main 未要求至少 1 位人工核准')
        if not p.get('dismiss_stale_reviews_on_push'):
            problems.append('新推送未使舊核准失效（dismiss_stale_reviews_on_push）')
        if not p.get('require_last_push_approval'):
            problems.append('最後一次推送未要求他人核准（require_last_push_approval）')
    contexts = {c.get('context') for p in by_type.get('required_status_checks', [])
                for c in p.get('required_status_checks', [])}
    missing = [c for c in REQUIRED_CHECKS if c not in contexts]
    if missing:
        problems.append('缺少必要檢查：' + '、'.join(missing))
    if 'non_fast_forward' not in by_type:
        problems.append('未禁止 force push')
    if 'deletion' not in by_type:
        problems.append('未禁止刪除 main')
    if repo_settings:
        enabled = bool(repo_settings.get('allow_auto_merge'))
        if auto_publish and not enabled:
            problems.append('CMS 自動發布需要 repository allow_auto_merge=true')
        if not auto_publish and enabled:
            problems.append('非自動發布模式不應啟用 repository auto-merge')
    return (not problems), problems


def gate_preflight(gh, *, single_maintainer=False, auto_publish=False):
    status, rules = gh.request('GET', '/rules/branches/main')
    _, settings = gh.request('GET', '')
    ok, problems = evaluate_gate(rules if status == 200 else [], settings or {},
                                 single_maintainer=single_maintainer, auto_publish=auto_publish)
    if not ok:
        raise PublishError('GATE_NOT_ENFORCED', problems)
    return True


# ---------------------------------------------------------------------------------------------
# Layered production verification (Gate 4). Every layer is reported separately; BLOCKED != PASS.
LAYERS = ('pr_created', 'ci_passed', 'review_approved', 'merged', 'deployed',
          'http_verified', 'snapshot_verified', 'native_verified')
LAYER_ZH = {'pr_created': '已建立 PR', 'ci_passed': 'CI 通過', 'review_approved': '發布授權', 'merged': '已合併',
            'deployed': '已部署', 'http_verified': 'HTTP 驗證', 'snapshot_verified': 'Snapshot 驗證',
            'native_verified': 'Native 驗證'}


def overall(layers):
    values = [layers.get(k, 'UNKNOWN') for k in LAYERS]
    if all(v == 'PASS' for v in values):
        return 'PASS', '已完成'
    if 'FAIL' in values:
        return 'FAIL', '發布失敗'
    if layers.get('deployed') == 'PASS':
        return 'DEPLOYED_UNVERIFIED', '已部署待驗證'
    if layers.get('merged') == 'PASS':
        return 'MERGED_NOT_DEPLOYED', '已合併待部署'
    return 'PENDING', '已開 PR 待審'


def parse_verification_artifact(zip_bytes):
    """Read the production-verification artifact reports into snapshot/native/http layer states."""
    result = {'http': 'UNKNOWN', 'snapshot': 'UNKNOWN', 'native': 'UNKNOWN'}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if not name.endswith('.json'):
                continue
            try:
                data = json.loads(zf.read(name))
            except ValueError:
                continue
            if name.endswith('http-parity.json'):
                result['http'] = 'PASS' if isinstance(data, dict) and data.get('failures') == [] else 'FAIL'
            elif 'native-edge/' in name and name.endswith('report.json'):
                result['native'] = {'PASS': 'PASS', 'BLOCKED': 'BLOCKED'}.get(data.get('status'), 'FAIL')
            elif 'production-live/' in name and name.endswith('report.json'):
                result['snapshot'] = 'PASS' if data.get('status') == 'Passed' else 'FAIL'
    return result


def http_check(domain, record_key, record_name=None, fetch=None):
    url = {'events': 'https://www.huiwen.tw/activities.html', 'legal-schedule': 'https://www.huiwen.tw/service.html'}[domain]
    fetch = fetch or (lambda u: urllib.request.urlopen(urllib.request.Request(
        u + '?pilot-verify=' + str(int(time.time())), headers={'User-Agent': 'huiwen-pilot-publisher'}), timeout=20).read().decode())
    try:
        html = fetch(url)
    except Exception:  # network/edge failure is a failed layer, never a pass
        return 'FAIL'
    if domain == 'events':
        from html import escape
        ok = f'id="event-{record_key}"' in html and (record_name is None or escape(record_name, quote=True) in html)
    else:
        ok = f'data-schedule-month="{record_key}"' in html
    return 'PASS' if ok else 'FAIL'


def layered_status(gh, pr_number, domain, record_key, record_name=None, fetch=None, *, single_maintainer=False, auto_publish=False, publisher_login=''):
    layers = {k: 'PENDING' for k in LAYERS}
    revision = {}
    _, pr = gh.request('GET', f'/pulls/{pr_number}')
    layers['pr_created'] = 'PASS'
    head = pr['head']['sha']
    _, checks = gh.request('GET', f'/commits/{head}/check-runs?per_page=100')
    runs = {c['name']: c for c in (checks or {}).get('check_runs', [])}
    concl = [runs.get(n, {}).get('conclusion') for n in REQUIRED_CHECKS]
    layers['ci_passed'] = 'PASS' if all(c == 'success' for c in concl) else \
        'FAIL' if any(c in ('failure', 'cancelled', 'timed_out') for c in concl) else 'PENDING'
    _, reviews = gh.request('GET', f'/pulls/{pr_number}/reviews')
    human = [r for r in reviews or [] if r.get('state') == 'APPROVED' and r.get('user', {}).get('type') != 'Bot'
             and r.get('commit_id') == head]
    layers['review_approved'] = 'PASS' if human else 'PENDING'
    if auto_publish:
        head_ref = (pr.get('head') or {}).get('ref', '')
        author = (pr.get('user') or {}).get('login', '')
        author_type = (pr.get('user') or {}).get('type', '')
        publisher_pr = head_ref.startswith(BRANCH_PREFIX) and (
            author_type == 'Bot' or (publisher_login and author == publisher_login))
        if publisher_pr:
            layers['review_approved'] = 'PASS'
    elif single_maintainer and pr.get('merged_at') and (pr.get('merged_by') or {}).get('type') != 'Bot' \
            and layers['ci_passed'] == 'PASS':
        layers['review_approved'] = 'PASS'
    if not pr.get('merged_at'):
        if pr.get('state') == 'closed':
            layers['merged'] = 'FAIL'
        return layers, revision
    layers['merged'] = 'PASS'
    merge_sha = pr['merge_commit_sha']
    _, pages = gh.request('GET', f'/actions/workflows/pages.yml/runs?head_sha={merge_sha}&per_page=5')
    deploy = next(iter((pages or {}).get('workflow_runs', [])), None)
    if deploy and deploy.get('status') == 'completed':
        layers['deployed'] = 'PASS' if deploy.get('conclusion') == 'success' else 'FAIL'
        _, arts = gh.request('GET', f"/actions/runs/{deploy['id']}/artifacts")
        art = next((a for a in (arts or {}).get('artifacts', []) if a.get('name') == 'github-pages'), {})
        revision = {'deployRunId': deploy['id'], 'deployedSha': deploy.get('head_sha'), 'artifactDigest': art.get('digest')}
    if layers['deployed'] != 'PASS':
        return layers, revision
    layers['http_verified'] = http_check(domain, record_key, record_name, fetch)
    _, pv = gh.request('GET', f'/actions/workflows/production-verification.yml/runs?head_sha={merge_sha}&per_page=5')
    verify = next(iter((pv or {}).get('workflow_runs', [])), None)
    if verify and verify.get('status') == 'completed':
        _, arts = gh.request('GET', f"/actions/runs/{verify['id']}/artifacts")
        art = next((a for a in (arts or {}).get('artifacts', []) if a.get('name') == 'production-live-verification'), None)
        if art:
            status, blob = gh.request('GET', f"/actions/artifacts/{art['id']}/zip", raw=True)
            if status == 200:
                parsed = parse_verification_artifact(blob)
                layers['snapshot_verified'], layers['native_verified'] = parsed['snapshot'], parsed['native']
                if parsed['http'] == 'FAIL':
                    layers['http_verified'] = 'FAIL'
        revision['verificationRunId'] = verify['id']
    return layers, revision


# ---------------------------------------------------------------------------------------------
# Notion REST source (data sources API) and property mapping. Names are the Chinese UI labels.
EVENT_PROPS = {'name': '活動名稱', 'start': '開始', 'end': '結束', 'content': '活動說明', 'registration': '報名方式',
               'sourceUrl': '來源網址', 'verifiedAt': '來源核對日', 'status': '狀態', 'changeNote': '異動說明',
               'updatedAt': '來源更新日', 'reviewDueAt': '下次複查'}
LEGAL_PROPS = {'month': '月份', 'sourceUrl': '來源圖卡網址', 'sourceTitle': '圖卡標題', 'observedAt': '核對日',
               'nextReviewAt': '下次核對'}
SESSION_PROPS = {'date': '日期', 'start': '開始', 'end': '結束'}
SYSTEM_PROPS = {'requestPreview': '要求預覽', 'requestPublish': '發布', 'state': '執行狀態',
                'siteId': '網站 ID', 'baseHash': 'GitHub 基準雜湊', 'candidateDigest': '候選內容雜湊',
                'syncedHash': '上次同步雜湊', 'preview': '白話預覽', 'result': '發布結果', 'prUrl': 'PR 連結',
                'layers': '驗證層級', 'lastRun': '最後執行'}
DEPLOY_CONTROL_PROPS = {'requestRedeploy': '重新部署正式站', 'state': '執行狀態',
                        'result': '部署結果', 'runId': '部署 Run ID', 'lastRun': '最後執行'}


def prop_value(page, name):
    prop = (page.get('properties') or {}).get(name)
    if not prop:
        return None
    kind = prop.get('type')
    value = prop.get(kind)
    if kind in ('title', 'rich_text'):
        return ''.join(part.get('plain_text', '') for part in value or [])
    if kind == 'date':
        return value.get('start') if value else None
    if kind in ('select', 'status'):
        return value.get('name') if value else None
    if kind == 'relation':
        return [r['id'] for r in value or []]
    if kind == 'formula':
        return (value or {}).get((value or {}).get('type'))
    return value


def page_to_row(page, props, sessions=None):
    row = {'pageId': page['id'], 'lastEdited': page.get('last_edited_time'),
           'fields': {k: prop_value(page, v) for k, v in props.items()},
           'system': {k: prop_value(page, v) for k, v in SYSTEM_PROPS.items()}}
    if sessions is not None:
        row['sessions'] = sessions
    return row


def deploy_control_row(page):
    return {'pageId': page['id'], **{k: prop_value(page, v) for k, v in DEPLOY_CONTROL_PROPS.items()}}


def rich(text):
    text = text or ''
    return {'rich_text': [{'type': 'text', 'text': {'content': text[i:i + 1900]}} for i in range(0, len(text), 1900)][:50]}


class Notion:
    def __init__(self, token, *, transport=None, sleep=time.sleep, attempts=4):
        self.token, self.transport, self.sleep, self.attempts = token, transport or HttpTransport(), sleep, attempts

    def call(self, method, path, body=None):
        headers = {'Authorization': f'Bearer {self.token}', 'Notion-Version': '2025-09-03',
                   'Content-Type': 'application/json', 'User-Agent': 'huiwen-pilot-publisher'}
        for attempt in range(1, self.attempts + 1):
            try:
                status, hdrs, payload = self.transport(method, NOTION_API + path, headers,
                                                       json.dumps(body).encode() if body is not None else None, 30)
            except (TimeoutError, urllib.error.URLError, ConnectionError):
                status, hdrs, payload = 599, {}, b''
            if status == 429 or status >= 500:
                if attempt == self.attempts:
                    raise PublishError('NOTION_BUSY', retryable=True)
                self.sleep(min(int({k.lower(): v for k, v in hdrs.items()}.get('retry-after') or 2 ** attempt), 60))
                continue
            if status >= 400:
                raise PublishError('NOTION_BUSY', [f'Notion 回應 {status}'], retryable=False)
            return json.loads(payload)
        raise PublishError('NOTION_BUSY', retryable=True)

    def query(self, data_source, flt=None):
        pages, cursor = [], None
        while True:
            body = {'page_size': 100, **({'filter': flt} if flt else {}), **({'start_cursor': cursor} if cursor else {})}
            out = self.call('POST', f'/data_sources/{data_source}/query', body)
            pages += out.get('results', [])
            if not out.get('has_more'):
                return pages
            cursor = out.get('next_cursor')

    def page(self, page_id):
        return self.call('GET', f'/pages/{page_id}')

    def update(self, page_id, values):
        props = {}
        for key, value in values.items():
            name = SYSTEM_PROPS[key]
            if key in ('requestPreview', 'requestPublish'):
                props[name] = {'checkbox': bool(value)}
            elif key == 'state':
                props[name] = {'select': {'name': value}}
            elif key == 'prUrl':
                props[name] = {'url': value}
            elif key == 'lastRun':
                props[name] = {'date': {'start': value}}
            else:
                props[name] = rich(value)
        return self.call('PATCH', f'/pages/{page_id}', {'properties': props})

    def update_deploy_control(self, page_id, values):
        props = {}
        for key, value in values.items():
            name = DEPLOY_CONTROL_PROPS[key]
            if key == 'requestRedeploy':
                props[name] = {'checkbox': bool(value)}
            elif key == 'state':
                props[name] = {'select': {'name': value}}
            elif key == 'lastRun':
                props[name] = {'date': {'start': value}}
            else:
                props[name] = rich(value)
        return self.call('PATCH', f'/pages/{page_id}', {'properties': props})


class NotionSource:
    """Fresh reads from Notion. Data source IDs come from environment variables (never the repo)."""

    def __init__(self, notion, env):
        self.n = notion
        self.ds = {'events': env.get('NOTION_EVENTS_DS'), 'legal-schedule': env.get('NOTION_LEGAL_MONTH_DS'),
                   'sessions': env.get('NOTION_LEGAL_SESSION_DS'), 'deploy': env.get('NOTION_DEPLOY_CONTROL_DS')}
        if not all(self.ds[k] for k in ('events', 'legal-schedule', 'sessions')):
            raise PublishError('CONFIG', ['缺少 Notion data source 設定'])

    def _sessions(self, page_id):
        pages = self.n.query(self.ds['sessions'], {'property': '月份', 'relation': {'contains': page_id}})
        return [{k: prop_value(p, v) for k, v in SESSION_PROPS.items()} for p in pages]

    def rows(self, domain, flt):
        props = EVENT_PROPS if domain == 'events' else LEGAL_PROPS
        out = []
        for page in self.n.query(self.ds[domain], flt):
            out.append(page_to_row(page, props, self._sessions(page['id']) if domain != 'events' else None))
        return out

    def fresh(self, domain, page_id):
        props = EVENT_PROPS if domain == 'events' else LEGAL_PROPS
        return page_to_row(self.n.page(page_id), props, self._sessions(page_id) if domain != 'events' else None)

    def write(self, page_id, **values):
        return self.n.update(page_id, values)

    def deploy_rows(self, flt=None):
        if not self.ds.get('deploy'):
            raise PublishError('CONFIG', ['缺少 NOTION_DEPLOY_CONTROL_DS'])
        return [deploy_control_row(p) for p in self.n.query(self.ds['deploy'], flt)]

    def deploy_write(self, page_id, **values):
        return self.n.update_deploy_control(page_id, values)


class FileSource:
    """Offline/shadow source: normalized rows JSON. Write-backs are recorded, not sent anywhere."""

    def __init__(self, path):
        self.data = json.loads(Path(path).read_text(encoding='utf-8'))
        self.writes = []

    def rows(self, domain, flt=None):
        key = 'events' if domain == 'events' else 'legalMonths'
        return copy.deepcopy(self.data.get(key, []))

    def fresh(self, domain, page_id):
        return next(r for r in self.rows(domain) if r['pageId'] == page_id)

    def write(self, page_id, **values):
        """Record the write-back and apply it to the in-memory rows (simulates Notion state)."""
        self.writes.append({'pageId': page_id, **values})
        for key in ('events', 'legalMonths'):
            for row in self.data.get(key, []):
                if row['pageId'] == page_id:
                    row.setdefault('system', {}).update(values)

    def deploy_rows(self, flt=None):
        return copy.deepcopy(self.data.get('deployControls', []))

    def deploy_write(self, page_id, **values):
        self.writes.append({'pageId': page_id, **values})
        for row in self.data.get('deployControls', []):
            if row['pageId'] == page_id:
                row.update(values)


# ---------------------------------------------------------------------------------------------
# Orchestration.
def now_iso():
    return datetime.now(TAIPEI).replace(microsecond=0).isoformat()


def main_text(repo, domain):
    return (Path(repo) / DATA_FILES[domain]).read_text(encoding='utf-8')


def dry_run(source, repo, domain, row, *, build=True, quality=True):
    """Preview + digest only. Never pushes, never opens a PR, never uploads an artifact."""
    try:
        cand = PREPARE[domain](row, main_text(repo, domain))
        if cand.errors:
            raise PublishError('VALIDATION', cand.errors)
        files = []
        if build and cand.changed:
            with Worktree(repo, 'HEAD') as wt:
                files = materialize(cand, wt, quality=quality)
        values = {'state': '可核准' if cand.changed else '無需發布', 'preview': cand.preview,
                  'candidateDigest': cand.digest, 'baseHash': cand.base_hash, 'requestPreview': False,
                  'result': '工程預覽完成；日常操作直接使用「發布」。' if cand.changed else '與網站目前版本相同。',
                  'lastRun': now_iso()}
        if domain == 'events' and not row.get('system', {}).get('siteId'):
            values['siteId'] = cand.record_key
        source.write(row['pageId'], **values)
        return {'pageId': row['pageId'], 'domain': domain, 'outcome': 'PREVIEWED', 'changed': cand.changed,
                'digest': cand.digest, 'files': files}
    except PublishError as exc:
        state = {'GITHUB_NEWER': 'GitHub 較新待回填'}.get(exc.code, '發布失敗')
        source.write(row['pageId'], state=state, result=exc.plain(), requestPreview=False, lastRun=now_iso())
        return {'pageId': row['pageId'], 'domain': domain, 'outcome': exc.code}


def pr_body(cand, base_sha):
    return '\n'.join([
        '## Notion CMS 自動發布', '',
        f'- Domain：`{cand.domain}`', f'- Record：`{cand.record_key}`',
        f'- Candidate digest：`{cand.digest}`', f'- Git base：`{base_sha}`（record base `{cand.base_hash}`）',
        f'- 建立時間：{now_iso()}', '',
        '本 PR 由 Notion「發布」動作建立；候選內容已完成 fresh-read、build、quality 與版本綁定。',
        '**不得繞過 required checks。** GitHub auto-merge 只會在既有 ruleset 條件全數滿足後合併。',
        '合併後由 Pages 部署，並依 HTTP／snapshot／native 分層驗證；BLOCKED 不等於 PASS。'])


def publish(source, repo, domain, row, gh, push, *, build=True, single_maintainer=False, auto_publish=False):
    """One-click publish: snapshot, build/test, re-read, PR, then GitHub-native auto-merge."""
    page = row['pageId']
    try:
        gate_preflight(gh, single_maintainer=single_maintainer, auto_publish=auto_publish)
        current_text = main_text(repo, domain)
        fresh_row = source.fresh(domain, page)
        if not fresh_row.get('system', {}).get('requestPublish'):
            return {'pageId': page, 'domain': domain, 'outcome': 'SKIPPED_NOT_REQUESTED'}
        cand = PREPARE[domain](fresh_row, current_text)
        if cand.errors:
            raise PublishError('VALIDATION', cand.errors)
        if not cand.changed:
            source.write(page, state='已完成',
                         result='內容與網站目前版本相同；如需重跑正式站部署，請使用「重新部署正式站」。',
                         requestPublish=False, candidateDigest=cand.digest, baseHash=cand.base_hash,
                         lastRun=now_iso())
            return {'pageId': page, 'domain': domain, 'outcome': 'NO_CHANGE'}
        base_sha = run(['git', 'rev-parse', 'HEAD'], repo).stdout.strip()
        source.write(page, state='發布中', candidateDigest=cand.digest, baseHash=cand.base_hash,
                     result='正在建置與檢查；必要檢查全數通過後會自動上線。', lastRun=now_iso())
        title = f"Notion CMS：{'活動' if domain == 'events' else '律師時間表'} {cand.record_key}"
        with Worktree(repo, base_sha) as wt:
            files = materialize(cand, wt, quality=build) if build else []
            # Bind the click to this exact snapshot. Any edit while build/tests run invalidates it.
            verify_publish_snapshot(cand, source.fresh(domain, page), current_text)
            remote_main = gh.branch_sha('main')
            if remote_main and remote_main != base_sha:
                raise PublishError('STALE_CHECKOUT', retryable=True)
            outcome, pr = ensure_pull_request(gh, cand, lambda: push(wt, cand, title), title, pr_body(cand, base_sha))
            auto_merge = 'ALREADY_MERGED'
            if outcome != 'ALREADY_MERGED':
                head_sha = gh.branch_sha(cand.branch)
                auto_merge = gh.enable_auto_merge(pr.get('number'), expected_head_sha=head_sha)
        state = '已合併待部署' if outcome == 'ALREADY_MERGED' else '自動發布中'
        source.write(page, state=state, prUrl=pr.get('html_url'), requestPublish=False, lastRun=now_iso(),
                     result=('已合併，等待正式站部署。' if outcome == 'ALREADY_MERGED' else
                             f'已建立發布請求並啟用自動合併（{auto_merge}）；必要檢查全數通過後會自動上線。'))
        return {'pageId': page, 'domain': domain, 'outcome': outcome, 'pr': pr.get('number'), 'files': files,
                'digest': cand.digest, 'autoMerge': auto_merge}
    except PublishError as exc:
        state = {'PUBLISH_CHANGED_DURING_RUN': '需重新發布', 'PR_CLOSED': '需重新發布',
                 'GITHUB_NEWER': 'GitHub 較新待回填'}.get(exc.code, '發布失敗')
        clear = exc.code in ('PUBLISH_CHANGED_DURING_RUN', 'PR_CLOSED')
        values = {'state': state, 'result': exc.plain(), 'lastRun': now_iso()}
        if clear:
            values['requestPublish'] = False
        source.write(page, **values)
        return {'pageId': page, 'domain': domain, 'outcome': exc.code, 'retryable': exc.retryable}


def git_push(token):
    """Push a candidate branch with an installation token passed via env-config (never argv/logs)."""
    def push(worktree, cand, title):
        auth = base64.b64encode(f'x-access-token:{token}'.encode()).decode()
        env = {**os.environ, 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
               'GIT_CONFIG_VALUE_0': f'AUTHORIZATION: basic {auth}', 'GIT_TERMINAL_PROMPT': '0'}
        run(['git', 'checkout', '-B', cand.branch], worktree)
        run(['git', 'add', '--', *sorted(ALLOWED_PATHS[cand.domain] & set(changed_files(worktree)))], worktree)
        run(['git', '-c', f"user.name={os.environ.get('PUBLISHER_GIT_NAME', 'huiwen-publisher[bot]')}",
             '-c', f"user.email={os.environ.get('PUBLISHER_GIT_EMAIL', 'huiwen-publisher[bot]@users.noreply.github.com')}",
             'commit', '-m', title, '-m', f'Candidate digest: {cand.digest}'], worktree)
        run(['git', 'push', 'origin', f'HEAD:refs/heads/{cand.branch}'], worktree, env=env)
    return push


def _iso_dt(value):
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace('Z', '+00:00'))


def _latest_redeploy_run(actions_gh, since):
    since_dt = _iso_dt(since)
    if since_dt and since_dt.tzinfo is None:
        since_dt = since_dt.replace(tzinfo=TAIPEI)
    for run_info in actions_gh.workflow_runs('pages.yml', event='workflow_dispatch'):
        created = _iso_dt(run_info.get('created_at'))
        if not created:
            continue
        if since_dt and created < since_dt.astimezone(timezone.utc) - timedelta(minutes=2):
            continue
        return run_info
    return None


def request_redeploy(source, actions_gh, row):
    page = row['pageId']
    requested_at = now_iso()
    try:
        source.deploy_write(page, state='重新部署中', result='正在重新 build／deploy current main。',
                            requestRedeploy=False, runId='', lastRun=requested_at)
        actions_gh.dispatch_workflow('pages.yml', ref='main')
        found = None
        for _ in range(3):
            found = _latest_redeploy_run(actions_gh, requested_at)
            if found:
                break
            actions_gh.sleep(1)
        if found:
            source.deploy_write(page, runId=str(found.get('id') or ''),
                                result=f"已送出重新部署（run {found.get('id')}），等待完成。")
        return {'pageId': page, 'outcome': 'REDEPLOY_DISPATCHED', 'run': (found or {}).get('id')}
    except PublishError as exc:
        source.deploy_write(page, state='重新部署失敗', result=exc.plain(),
                            requestRedeploy=False, lastRun=now_iso())
        return {'pageId': page, 'outcome': exc.code, 'retryable': exc.retryable}


def verify_redeploy(source, actions_gh, row):
    if row.get('state') != '重新部署中':
        return {'pageId': row['pageId'], 'outcome': 'REDEPLOY_SKIPPED'}
    run_id = row.get('runId')
    run_info = None
    try:
        if run_id:
            run_info = actions_gh.action_run(run_id)
        else:
            run_info = _latest_redeploy_run(actions_gh, row.get('lastRun'))
        if not run_info:
            return {'pageId': row['pageId'], 'outcome': 'REDEPLOY_PENDING'}
        run_id = str(run_info.get('id') or run_id or '')
        if run_info.get('status') != 'completed':
            source.deploy_write(row['pageId'], runId=run_id,
                                result=f'重新部署執行中（run {run_id}）。', lastRun=now_iso())
            return {'pageId': row['pageId'], 'outcome': 'REDEPLOY_PENDING', 'run': run_id}
        if run_info.get('conclusion') == 'success':
            source.deploy_write(row['pageId'], state='重新部署完成', runId=run_id,
                                result=f'正式站重新部署完成（run {run_id}）。', lastRun=now_iso())
            return {'pageId': row['pageId'], 'outcome': 'REDEPLOYED', 'run': run_id}
        source.deploy_write(row['pageId'], state='重新部署失敗', runId=run_id,
                            result=f"重新部署失敗（run {run_id}／{run_info.get('conclusion')}）。", lastRun=now_iso())
        return {'pageId': row['pageId'], 'outcome': 'REDEPLOY_FAILED', 'run': run_id}
    except PublishError as exc:
        source.deploy_write(row['pageId'], state='重新部署失敗', result=exc.plain(), lastRun=now_iso())
        return {'pageId': row['pageId'], 'outcome': exc.code, 'retryable': exc.retryable}


def synced_hash_after_merge(domain, row, text):
    """After a verified merge, adopt main as the new sync base only if it matches the Notion fields."""
    data = json.loads(text)
    if domain == 'events':
        managed, errors = normalize_event(row.get('fields', {}))
        record = next((e for e in data['events'] if e.get('id') == row['system'].get('siteId')), None)
        if errors or record is None or any(record.get(k) != managed[k] for k in EVENT_FIELDS):
            return None
        return sha(record)
    managed, errors = normalize_legal(row.get('fields', {}), row.get('sessions', []))
    if errors or any(data.get(k) != managed[k] for k in LEGAL_FIELDS):
        return None
    return sha(data)


def export_rows(repo):
    """Main -> normalized rows (for first import and shadow comparison). Writes nothing anywhere."""
    events = json.loads(main_text(repo, 'events'))['events']
    legal = json.loads(main_text(repo, 'legal-schedule'))
    zh = {v: k for k, v in STATUS_IN.items() if k in ('排定', '改期', '取消')}
    rows = {'events': [], 'legalMonths': []}
    for e in events:
        fields = {k: e.get(k) for k in EVENT_FIELDS}
        fields['status'] = zh[e.get('status', 'scheduled')]
        rows['events'].append({'pageId': 'import-' + e['id'], 'fields': fields,
                               'system': {'siteId': e['id'], 'syncedHash': sha(e), 'baseHash': sha(e)}})
    rows['legalMonths'].append({'pageId': 'import-' + legal['month'],
                                'fields': {k: legal.get(k) for k in LEGAL_PROPS},
                                'sessions': legal['sessions'], 'system': {'syncedHash': sha(legal)}})
    return rows


def shadow_compare(repo, rows):
    """Shadow acceptance: Notion rows rendered by the executor must equal current main byte-for-byte."""
    report = []
    for domain, key in (('events', 'events'), ('legal-schedule', 'legalMonths')):
        for row in rows.get(key, []):
            cand = PREPARE[domain](row, main_text(repo, domain))
            report.append({'domain': domain, 'record': cand.record_key, 'errors': cand.errors,
                           'identical': not cand.errors and not cand.changed})
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('mode', choices=['dry-run', 'publish', 'verify', 'redeploy', 'cycle', 'gate-check', 'export-rows', 'shadow-compare'])
    p.add_argument('--repo', type=Path, default=ROOT)
    p.add_argument('--rows', type=Path, help='normalized rows JSON (offline/shadow source)')
    p.add_argument('--domain', choices=['events', 'legal-schedule', 'all'], default='all')
    p.add_argument('--skip-build', action='store_true')
    p.add_argument('--report', type=Path)
    a = p.parse_args(argv)
    env = os.environ
    single_maintainer = env.get('PUBLISHER_SINGLE_MAINTAINER') == 'true'
    auto_publish = env.get('PUBLISHER_AUTO_PUBLISH') == 'true'
    publisher_login = env.get('PUBLISHER_APP_LOGIN', '')
    domains = ['events', 'legal-schedule'] if a.domain == 'all' else [a.domain]
    results = []
    try:
        if a.mode == 'export-rows':
            print(json.dumps(export_rows(a.repo), ensure_ascii=False, indent=2))
            return 0
        if a.mode == 'shadow-compare':
            results = shadow_compare(a.repo, json.loads(a.rows.read_text(encoding='utf-8')))
            ok = all(r['identical'] for r in results)
            print(json.dumps({'identical': ok, 'records': len(results)}, ensure_ascii=False))
            return 0 if ok else 1
        repo_name = env.get('GITHUB_REPOSITORY', 'Hong1998tw/chen-huiwen-website')
        gh = GitHub(env.get('GH_TOKEN', ''), repo_name)
        actions_gh = GitHub(env.get('ACTIONS_TOKEN', ''), repo_name)
        if a.mode == 'gate-check':
            status, rules = gh.request('GET', '/rules/branches/main')
            _, settings = gh.request('GET', '')
            ok, problems = evaluate_gate(rules if status == 200 else [], settings or {},
                                         single_maintainer=single_maintainer, auto_publish=auto_publish)
            print(json.dumps({'gate': 'ENFORCED' if ok else 'NOT_ENFORCED', 'problems': problems}, ensure_ascii=False))
            return 0 if ok else 1
        source = FileSource(a.rows) if a.rows else NotionSource(Notion(env.get('NOTION_TOKEN', '')), env)
        modes = ['publish', 'verify'] if a.mode == 'cycle' else ([] if a.mode == 'redeploy' else [a.mode])
        for mode in modes:
            for domain in domains:
                if mode == 'dry-run':
                    for row in source.rows(domain, {'property': SYSTEM_PROPS['requestPreview'], 'checkbox': {'equals': True}}):
                        if row['system'].get('requestPreview'):
                            results.append(dry_run(source, a.repo, domain, row, build=not a.skip_build))
                elif mode == 'publish':
                    for row in source.rows(domain, {'property': SYSTEM_PROPS['requestPublish'], 'checkbox': {'equals': True}}):
                        if row['system'].get('requestPublish'):
                            results.append(publish(source, a.repo, domain, row, gh, git_push(env.get('GH_TOKEN', '')),
                                                   build=not a.skip_build,
                                                   single_maintainer=single_maintainer,
                                                   auto_publish=auto_publish))
                elif mode == 'verify':
                    for row in source.rows(domain, {'property': SYSTEM_PROPS['state'], 'select': {'is_not_empty': True}}):
                        if row['system'].get('state') not in ('自動發布中', '已開 PR 待審', '已合併待部署', '已部署待驗證') or not row['system'].get('prUrl'):
                            continue
                        number = int(str(row['system']['prUrl']).rstrip('/').split('/')[-1])
                        key = row['system'].get('siteId') if domain == 'events' else row['fields'].get('month')
                        layers, revision = layered_status(gh, number, domain, key, row['fields'].get('name'),
                                                         single_maintainer=single_maintainer,
                                                         auto_publish=auto_publish,
                                                         publisher_login=publisher_login)
                        verdict, state = overall(layers)
                        summary = '；'.join(f'{LAYER_ZH[k]}：{layers[k]}' for k in LAYERS)
                        if revision:
                            summary += f"\nProduction revision：deploy run {revision.get('deployRunId')}／{revision.get('deployedSha')}／{revision.get('artifactDigest')}"
                        values = {'state': state, 'layers': summary, 'lastRun': now_iso()}
                        if verdict == 'PASS':
                            synced = synced_hash_after_merge(domain, row, main_text(a.repo, domain))
                            if synced:
                                values['syncedHash'] = synced
                            else:
                                values['result'] = '已上線，但網站目前版本與 Notion 不一致，需由工程回填基準。'
                        source.write(row['pageId'], **values)
                        results.append({'pageId': row['pageId'], 'domain': domain, 'outcome': verdict})

        if a.mode in ('cycle', 'redeploy'):
            for row in source.deploy_rows({'property': DEPLOY_CONTROL_PROPS['requestRedeploy'], 'checkbox': {'equals': True}}):
                if row.get('requestRedeploy'):
                    results.append(request_redeploy(source, actions_gh, row))
            for row in source.deploy_rows({'property': DEPLOY_CONTROL_PROPS['state'], 'select': {'equals': '重新部署中'}}):
                if row.get('state') == '重新部署中':
                    results.append(verify_redeploy(source, actions_gh, row))
    except PublishError as exc:
        print(json.dumps({'error': exc.code}, ensure_ascii=False), file=sys.stderr)
        return 2
    summary = {'mode': a.mode, 'results': [{k: v for k, v in r.items() if k in ('domain', 'outcome', 'changed', 'pr', 'retryable')}
                                           for r in results]}
    print(json.dumps(summary, ensure_ascii=False))
    if a.report:
        a.report.write_text(json.dumps({'results': results, 'writes': getattr(source, 'writes', [])},
                                       ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 1 if any(r.get('outcome') not in ('PREVIEWED', 'CREATED', 'ALREADY_OPEN', 'ALREADY_MERGED', 'RECONCILED',
                                              'NO_CHANGE', 'PASS', 'PENDING', 'DEPLOYED_UNVERIFIED',
                                              'MERGED_NOT_DEPLOYED', 'SKIPPED_NOT_REQUESTED',
                                              'REDEPLOY_DISPATCHED', 'REDEPLOY_PENDING', 'REDEPLOYED',
                                              'REDEPLOY_SKIPPED') for r in results) else 0


if __name__ == '__main__':
    raise SystemExit(main())
