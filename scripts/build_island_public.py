#!/usr/bin/env python3
"""Refresh canonical public case content in the curated island, preserving every item ID/index.

The canonical source is data/achievements.json via its reviewed public projection.
The island file remains the native owner of layout, historic short records and
curated grouping. This script owns only the canonical display-content fields.
An unrepresented future case fails closed until its identity mapping is reviewed.
"""
from pathlib import Path
import argparse, copy, json, re

ROOT = Path(__file__).resolve().parents[1]
# Public stable identities only. These short records predate their full case pages.
PROMOTIONS = {
    'in-804083db5d': 'bicycle-sidewalk-space-planning',
    'in-cf637d0029': 'park-post-typhoon-playground-safety',
    'in-7a2d764c89': 'smart-poles-park-preventive-maintenance',
    'in-5980ad6a40': 'senior-home-repair-subsidy-review',
    'in-bd254a7f7d': 'kaohsiung-campus-app-service-integration',
    'in-0366186f6c': 'home-care-financial-reporting-accounting-support',
}
PROJECTED = {'canonicalId', 't', 'd', 'o', 'v', 'h', 's', 'b', 'all', 'url'}


def synchronize(island, cases):
    result = copy.deepcopy(island)
    by_case = {case['id']: case for case in cases}
    if len(by_case) != len(cases):
        raise ValueError('Duplicate canonical case IDs')
    by_item = {item['id']: item for item in result['items']}
    if len(by_item) != len(result['items']):
        raise ValueError('Duplicate island stable item IDs')
    seen = {}
    for item in result['items']:
        original_id = item['id']
        canonical_id = item.get('canonicalId') or PROMOTIONS.get(original_id)
        if not canonical_id and item.get('o') == 1:
            canonical_id = original_id
        if not canonical_id:
            continue
        if canonical_id not in by_case:
            raise ValueError(f'Island canonical mapping has no reviewed public case: {original_id} -> {canonical_id}')
        if canonical_id in seen:
            raise ValueError(f'Duplicate representation of canonical case {canonical_id}: {seen[canonical_id]}, {original_id}')
        seen[canonical_id] = original_id
        case = by_case[canonical_id]
        item.update({
            'canonicalId': canonical_id,
            't': case['title'],
            'd': int(case['status'] == '已完成'),
            'o': 1,
            'v': case.get('villages', []),
            'h': [[event.get('date', ''), event.get('title', '')] for event in case.get('history', [])],
            's': case.get('summary', ''),
            'b': case.get('budget', ''),
            'all': int(case.get('scope') in {'全市政策', '高雄市'}),
            'url': f'https://www.huiwen.tw/achievement-{canonical_id}.html',
        })
    missing = sorted(set(by_case) - set(seen))
    if missing:
        raise ValueError('Canonical cases require explicit island identity mapping; no title matching or random layout: ' + ', '.join(missing))
    meta = result.setdefault('meta', {})
    sources = meta.get('achievementSources', [])
    meta['achievementSources'] = [re.sub(r'官網政績庫\s*\d+\s*筆', f'官網政績庫 {len(cases)} 筆', value) for value in sources]
    meta['canonicalProjection'] = {'source': 'data/achievements-public.json', 'count': len(cases)}
    # Content-date maximum is deterministic and never presents build time as an event date.
    dates = [str(case.get('updated', '')) for case in cases if case.get('updated')]
    if dates:
        meta['builtAt'] = max(dates)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = args.root / 'island/island-data.json'
    island = json.loads(path.read_text())
    cases = json.loads((args.root / 'data/achievements-public.json').read_text())
    result = synchronize(island, cases)
    if args.check:
        if result != island:
            raise SystemExit('STALE_ISLAND_CANONICAL_PROJECTION: run scripts/build_island_public.py')
    elif result != island:
        path.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Island canonical projection: {len(cases)} full records, {sum(item.get("o") == 0 for item in result["items"])} historic short records, {len(result["items"])} stable items')


if __name__ == '__main__':
    main()
