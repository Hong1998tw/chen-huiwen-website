#!/usr/bin/env python3
"""Read-only, Asia/Taipei content review report; never infer a fact from elapsed time."""
from pathlib import Path
from datetime import date, datetime
from zoneinfo import ZoneInfo
import argparse
import calendar
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo('Asia/Taipei')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def local_date(value=None):
    if value is None:
        return datetime.now(TAIPEI).date()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError('Review clock must have a timezone')
        return value.astimezone(TAIPEI).date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(value)


def evaluate(root=ROOT, as_of=None, previous=None):
    root = Path(root)
    today = local_date(as_of)
    config = json.loads((root / 'data/content-governance.json').read_text())
    if config.get('timezone') != 'Asia/Taipei':
        raise ValueError('The review calendar must use Asia/Taipei')
    owners = {owner['id']: owner for owner in config['owners']}
    findings = []
    sources = {}

    def add(item_id, severity, state, source, owner_id, action, version):
        findings.append({'id': item_id, 'severity': severity, 'state': state,
                         'source': source, 'ownerId': owner_id,
                         'ownerAssignment': owners[owner_id]['assignmentStatus'],
                         'action': action, 'version': str(version)})

    for owner in config['owners']:
        if owner['assignmentStatus'] == 'unassigned':
            add('owner:' + owner['id'], 'backlog', 'unassigned', 'data/content-governance.json',
                owner['id'], '維護責任仍未指定；指定前由人工確認誰承接，不能把工程檢查當內容核實。', 'unassigned')
    for check in config['checks']:
        path = (root / check['source']).resolve()
        if not path.is_relative_to((root / 'data').resolve()) or path.suffix != '.json':
            raise ValueError('Freshness inputs must be JSON within data/')
        payload = json.loads(path.read_text())
        sources[check['source']] = digest(payload)
        kind, owner_id = check['kind'], check['ownerId']
        action, source = check['reviewTask'], check['source']
        if owner_id not in owners:
            raise ValueError('Unknown content owner role')
        if kind == 'monthly_schedule':
            year, month = map(int, payload['month'].split('-'))
            last_day = date(year, month, calendar.monthrange(year, month)[1])
            if date.fromisoformat(payload['validThrough']) != last_day:
                raise ValueError('Monthly schedule validThrough must match its published month')
            sessions = payload.get('sessions')
            if not isinstance(sessions, list) or not sessions:
                raise ValueError('Monthly review needs published sessions, not a metadata-only month change')
            for session in sessions:
                session_day = date.fromisoformat(session['date'])
                if (session_day.year, session_day.month) != (year, month):
                    raise ValueError('Every session must belong to the declared month')
            reviewed = date.fromisoformat(payload['observedAt'])
            due = date.fromisoformat(payload['nextReviewAt'])
            if reviewed > due or due > last_day:
                raise ValueError('Schedule review dates must be in chronological order')
            if payload['month'] != today.strftime('%Y-%m'):
                add(check['id'], 'expired', 'current_month_missing', source, owner_id, action,
                    payload['month'])
            elif today >= due:
                add(check['id'] + ':review', 'due', 'review_due', source, owner_id,
                    '本月資料仍在適用期間；請準備下月版本並核對本月異動。' + action, due)
        elif kind == 'events':
            for event in payload['events']:
                end = datetime.fromisoformat(event['end'])
                if end.tzinfo is None:
                    raise ValueError('Event review requires a timezone')
                # An ended/cancelled public record can remain as history; it is not automatically stale.
                if event.get('status', 'scheduled') == 'cancelled' or end.astimezone(TAIPEI).date() < today:
                    continue
                due_value = event.get('reviewDueAt')
                if not due_value:
                    add(check['id'] + ':' + event['id'], 'backlog', 'review_date_missing', source,
                        owner_id, action, event.get('verifiedAt', 'unknown'))
                elif today >= date.fromisoformat(due_value):
                    add(check['id'] + ':' + event['id'], 'expired', 'reconfirmation_due', source,
                        owner_id, action, due_value + ':' + event.get('updatedAt', 'unknown'))
        elif kind == 'profile':
            identity = payload['identity']
            if today >= date.fromisoformat(identity['reviewAfter']):
                add(check['id'], 'expired', 'identity_reconfirmation_due', source, owner_id,
                    action, identity['recordAsOf'] + ':' + identity['reviewAfter'])
        elif kind == 'platforms':
            for item_id, item in payload['itemsById'].items():
                accountability = item.get('accountability')
                if accountability and any(accountability.get(field) is None for field in ('target', 'deadline', 'responsibleAuthority', 'councilAction')):
                    add(check['id'] + ':' + item_id, 'backlog', 'source_detail_missing', source,
                        owner_id, action, item['reviewStatus'])
            for comparison in payload.get('crossTermComparisons', []):
                if comparison['relationshipStatus'] == 'needs_confirmation':
                    add(check['id'] + ':comparison:' + comparison['id'], 'backlog', 'relationship_unconfirmed',
                        source, owner_id, '核實跨屆延續關係與辦理結果；未核實前僅顯示原文對讀。', 'needs_confirmation')
        else:
            raise ValueError(f'Unsupported content check: {kind}')
    findings.sort(key=lambda row: row['id'])
    signatures = {row['id']: digest(row) for row in findings}
    expired = {row['id']: signatures[row['id']] for row in findings if row['severity'] == 'expired'}
    previous = previous or {}
    previous_expired = previous.get('expiredSignatures', {})
    new_expired = [key for key, signature in expired.items() if previous_expired.get(key) != signature]
    recovered = sorted(set(previous_expired) - set(expired))
    fingerprint = digest({'findings': signatures, 'sources': sources})
    return {'schemaVersion': 1, 'asOf': today.isoformat(), 'timezone': 'Asia/Taipei',
            'status': 'needs_attention' if expired else 'review_backlog' if findings else 'current',
            'changed': fingerprint != previous.get('fingerprint'),
            'alert': bool(new_expired), 'newExpiredIds': new_expired, 'recoveredIds': recovered,
            'expiredSignatures': expired, 'fingerprint': fingerprint, 'sourceDigests': sources,
            'findings': findings,
            'limits': '本檢查只判斷維護期限與資料缺口；不重查外部來源，不確認名額、法律、當選結果或工程現況。'}


def markdown(report):
    lines = [f'內容有效期檢查｜{report["asOf"]}（Asia/Taipei）', '',
             f'狀態：{report["status"]}；新增或變更的到期事項：{len(report["newExpiredIds"])}；恢復：{len(report["recoveredIds"])}。', '',
             '| 項目 | 狀態 | 維護角色 | 下一步 |', '| --- | --- | --- | --- |']
    for row in report['findings']:
        lines.append(f'| {row["id"]} | {row["severity"]} / {row["state"]} | {row["ownerId"]}（{row["ownerAssignment"]}） | {row["action"]} |')
    lines += ['', report['limits']]
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--as-of', help='固定檢查日期 YYYY-MM-DD；預設台灣今天')
    parser.add_argument('--previous-json', type=Path)
    parser.add_argument('--output-json', type=Path)
    parser.add_argument('--output-markdown', type=Path)
    parser.add_argument('--fail-on-new-expired', action='store_true')
    args = parser.parse_args()
    previous = json.loads(args.previous_json.read_text()) if args.previous_json and args.previous_json.exists() else None
    report = evaluate(as_of=args.as_of, previous=previous)
    for path, content in ((args.output_json, json.dumps(report, ensure_ascii=False, indent=2) + '\n'),
                          (args.output_markdown, markdown(report))):
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    print(json.dumps({key: report[key] for key in ('asOf', 'status', 'changed', 'alert', 'newExpiredIds', 'recoveredIds')}, ensure_ascii=False))
    return 1 if args.fail_on_new_expired and report['alert'] else 0


if __name__ == '__main__':
    sys.exit(main())
