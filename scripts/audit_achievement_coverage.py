#!/usr/bin/env python3
"""Read a private registry; compare only to canonical JSON. No network/AI calls.

Reports contain identifiers and reason codes only, but remain PRIVATE. Matching
is advisory: this program cannot approve evidence, publish, or rewrite sources.
"""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import date, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

from achievement_metadata import STATUSES, is_public

VERIFICATION = {'verified', 'partially_verified', 'pending', 'conflict', 'insufficient'}
PUBLICABILITY = {'publishable', 'needs_verification', 'private_only', 'rejected'}
COVERAGE = ('existing', 'needs_update', 'missing', 'possible_duplicate', 'conflict', 'insufficient_evidence', 'excluded')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,99}$')
DIGITS = dict(zip('零〇一二三四五六七八九', (0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)))


def chinese_number(text):
    if all(c in DIGITS for c in text):
        return ''.join(str(DIGITS[c]) for c in text)
    total = unit_value = 0
    for c in text:
        if c in DIGITS:
            unit_value = DIGITS[c]
        else:
            total += (unit_value or 1) * {'十': 10, '百': 100, '千': 1000}[c]
            unit_value = 0
    return str(total + unit_value)


def normalize_location(value):
    s = unicodedata.normalize('NFKC', str(value or '')).replace('臺', '台')
    s = re.sub(r'\s+', '', s)
    s = re.sub(r'^(?:台灣)?(?:\d{3}(?:\d{3})?)?高雄市鳳山區', '', s)
    s = re.sub(r'^鳳山區', '', s)
    s = re.sub(r'[零〇一二三四五六七八九十百千]+(?=[段巷弄號])', lambda m: chinese_number(m[0]), s)
    s = s.replace('号', '號')
    s = re.sub(r'[×✕／/]|與|和(?=.+(?:路|街))', '|', s)
    if '|' in s:
        s = '|'.join(sorted(p.removesuffix('路口') for p in s.split('|') if p))
    return s


def split_values(value):
    return set(value if isinstance(value, list) else filter(None, re.split(r'[|、;；]', str(value or ''))))


def xlsx_rows(path, sheet_name):
    """Bounded OOXML reader; does not evaluate formulas or follow relationships."""
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(path) as archive:
        if sum(f.file_size for f in archive.infolist()) > 150_000_000:
            raise ValueError('workbook exceeds uncompressed size limit')
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(n.itertext()) for n in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', ns)]
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        props = book.find('m:workbookPr', ns)
        epoch = date(1904, 1, 1) if props is not None and props.get('date1904') in ('1', 'true') else date(1899, 12, 30)
        sheet = next((s for s in book.findall('m:sheets/m:sheet', ns) if s.get('name') == sheet_name), None)
        if sheet is None:
            raise ValueError('candidate worksheet not found')
        relid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        rel = next((r for r in rels if r.get('Id') == relid), None)
        if rel is None or rel.get('TargetMode') == 'External':
            raise ValueError('invalid worksheet relationship')
        target = rel.get('Target', '')
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        if '..' in target.split('/') or not target.startswith('xl/worksheets/'):
            raise ValueError('invalid worksheet path')
        headers = None
        result = []
        for row in ET.fromstring(archive.read(target)).findall('m:sheetData/m:row', ns):
            cells = {}
            for c in row.findall('m:c', ns):
                column = re.match(r'[A-Z]+', c.get('r', ''))
                if column is None:
                    raise ValueError('invalid cell address')
                if c.find('m:f', ns) is not None:
                    raise ValueError('candidate input must contain values, not formulas')
                value = c.findtext('m:v', '', ns)
                if c.get('t') == 's':
                    value = shared[int(value)]
                elif c.get('t') == 'inlineStr':
                    value = ''.join(c.find('m:is', ns).itertext())
                elif headers and headers.get(column[0]) in ('first_date', 'latest_date', 'last_reviewed_at') and value and c.get('t', 'n') == 'n':
                    value = (epoch + timedelta(days=float(value))).isoformat()
                cells[column[0]] = value
            if headers is None:
                headers = cells
            elif any(cells.values()):
                result.append({name: cells.get(col, '') for col, name in headers.items() if name})
        return result


def read_candidates(path, sheet='候選總表'):
    if path.suffix.lower() == '.xlsx':
        rows = xlsx_rows(path, sheet)
    elif path.suffix.lower() == '.csv':
        with path.open(encoding='utf-8-sig', newline='') as f:
            rows = list(csv.DictReader(f))
    elif path.suffix.lower() == '.json':
        rows = json.loads(path.read_text())
    else:
        raise ValueError('candidate input must be XLSX, CSV or JSON')
    if not isinstance(rows, list):
        raise ValueError('candidate input must be a list')
    seen = set()
    for row in rows:
        cid = row.get('candidate_id', '')
        if not ID_RE.fullmatch(cid) or cid in seen:
            raise ValueError('candidate IDs must be unique stable identifiers')
        seen.add(cid)
        if row.get('verification_status') not in VERIFICATION or row.get('publicability') not in PUBLICABILITY:
            raise ValueError('invalid candidate verification/publicability taxonomy')
        if row.get('candidate_status') and row['candidate_status'] not in STATUSES:
            raise ValueError('invalid candidate status taxonomy')
    return rows


class Matcher:
    def __init__(self, achievements, mapping=None):
        self.byid = {a['id']: a for a in achievements}
        if len(self.byid) != len(achievements):
            raise ValueError('duplicate canonical achievement ID')
        self.mapping = mapping or {}
        self.locations = defaultdict(list)
        self.facets = defaultdict(set)
        for a in achievements:
            loc = normalize_location(a.get('locationName'))
            if loc:
                self.locations[loc].append(a['id'])
            for v in a.get('villages', []):
                for cat in a.get('categories', []):
                    self.facets[(a.get('district'), v, cat)].add(a['id'])

    def match(self, candidate):
        cid = candidate['candidate_id']
        aid = candidate.get('achievement_id')
        mapped = self.mapping.get(cid)
        if aid and mapped and aid != mapped:
            return [], 'mapping', 'mapping_conflict'
        if aid or mapped:
            key = aid or mapped
            return ([key] if key in self.byid else []), ('achievement_id' if aid else 'stable_mapping'), ('matched' if key in self.byid else 'unknown_achievement_id')
        loc = normalize_location(candidate.get('normalized_location'))
        hits = [i for i in self.locations.get(loc, []) if not candidate.get('district') or self.byid[i].get('district') == candidate['district']]
        if hits:
            return sorted(hits), 'normalized_location', 'review_identity'
        hits = set()
        for v in split_values(candidate.get('villages')):
            for cat in split_values(candidate.get('categories')):
                hits |= self.facets.get((candidate.get('district'), v, cat), set())
        first, latest = candidate.get('first_date'), candidate.get('latest_date')
        if first and latest:
            hits = {i for i in hits if any(first <= h.get('date', '') <= latest for h in self.byid[i].get('history', []))}
        else:
            hits = set()
        # Facet matches never establish identity. Semantic review remains human/AI
        # assisted outside this offline script and must not disclose private data.
        return sorted(hits), ('village_category_date' if hits else 'none'), ('review_identity' if hits else 'no_match')


def compare(candidates, achievements, mapping=None, main_commit='unknown'):
    matcher = Matcher(achievements, mapping)
    results = []
    eligible = covered = 0
    for c in candidates:
        hits, level, reason = matcher.match(c)
        status = 'insufficient_evidence'
        publishable = c.get('publicability') == 'publishable'
        if c.get('publicability') in {'private_only', 'rejected'} or c.get('coverage_status') == 'excluded':
            status, reason = 'excluded', 'not_for_publication'
        elif c.get('verification_status') == 'conflict' or reason in {'mapping_conflict', 'unknown_achievement_id'}:
            status = 'conflict'
        elif len(hits) > 1 or (hits and level in {'normalized_location', 'village_category_date'}):
            status = 'possible_duplicate'
        elif hits and is_public(matcher.byid[hits[0]]):
            a = matcher.byid[hits[0]]
            cv = split_values(c.get('villages'))
            contradictory = ((c.get('district') and c['district'] != a.get('district')) or (cv and cv != set(a.get('villages', []))))
            loc = normalize_location(c.get('normalized_location'))
            if loc and a.get('locationName') and loc != normalize_location(a['locationName']):
                contradictory = True
            if c.get('candidate_status') and c['candidate_status'] not in {'待核驗', a['status']}:
                contradictory = True
            if contradictory:
                status, reason = 'conflict', 'metadata_conflict'
            elif c.get('coverage_status') == 'needs_update' or (c.get('latest_date') and c['latest_date'] > a.get('updated', '')):
                status, reason = 'needs_update', 'review_new_information'
            else:
                status, reason = 'existing', 'public_id_match'
        elif publishable and c.get('verification_status') == 'verified' and c.get('official_sources') and c.get('attribution_status') in {'direct', 'supported', 'joint', 'oversight'}:
            status, reason = 'missing', ('canonical_unpublished' if hits else 'verified_not_published')
        else:
            reason = 'canonical_unpublished' if hits else 'evidence_required'
        if publishable and status != 'excluded':
            eligible += 1
            covered += status in {'existing', 'needs_update'}
        # Explicit allowlist: no titles, notes, source paths, original case IDs,
        # private addresses, raw drafts or contacts leave the input reader.
        results.append({'candidate_id': c['candidate_id'], 'achievement_id': '|'.join(hits), 'coverage_status': status, 'match_level': level, 'reason': reason, 'verification_status': c.get('verification_status', ''), 'last_compared_main_commit': main_commit})
    counts = Counter(r['coverage_status'] for r in results)
    summary = {'candidate_total': len(candidates), 'canonical_records': len(achievements), 'published_achievements': sum(is_public(a) for a in achievements), **{k: counts[k] for k in COVERAGE}, 'publishable_candidates': eligible, 'covered_publishable_candidates': covered, 'needs_verification_candidates': sum(c.get('publicability') == 'needs_verification' for c in candidates), 'coverage': covered / eligible if eligible else None}
    return {'summary': summary, 'results': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--public', type=Path, default=Path('data/achievements.json'))
    parser.add_argument('--output', type=Path, default=Path('audit-results'))
    parser.add_argument('--sheet', default='候選總表')
    parser.add_argument('--mapping', type=Path, help='Private JSON object: candidate_id to achievement_id; manually confirmed only')
    parser.add_argument('--main-commit', default='unknown', help='Actually observed main HEAD; not inferred from working branch')
    args = parser.parse_args()
    try:
        candidates = read_candidates(args.candidate, args.sheet)
        achievements = json.loads(args.public.read_text())
        mapping = json.loads(args.mapping.read_text()) if args.mapping else None
        result = compare(candidates, achievements, mapping, args.main_commit)
        result['inputs'] = {'public_sha256': hashlib.sha256(args.public.read_bytes()).hexdigest(), 'candidate_sha256': hashlib.sha256(args.candidate.read_bytes()).hexdigest()}
        output = args.output.resolve()
        # Reports must not be written into tracked/public locations by accident.
        repo = Path(__file__).resolve().parents[1]
        if output.is_relative_to(repo):
            probe = output / 'achievement-coverage.json'
            if subprocess.run(['git', 'check-ignore', '-q', str(probe)], cwd=repo).returncode:
                raise ValueError('report destination inside repository must be git-ignored')
        output.mkdir(parents=True, exist_ok=True, mode=0o700)
        for suffix in ('json', 'csv'):
            destination = output / ('achievement-coverage.' + suffix)
            if destination.is_symlink():
                raise ValueError('report destination must not be a symlink')
            with destination.open('w', encoding='utf-8' if suffix == 'json' else 'utf-8-sig', newline='') as stream:
                os.chmod(destination, 0o600)
                if suffix == 'json':
                    json.dump(result, stream, ensure_ascii=False, indent=2)
                    stream.write('\n')
                else:
                    fields = ['candidate_id', 'achievement_id', 'coverage_status', 'match_level', 'reason', 'verification_status', 'last_compared_main_commit']
                    writer = csv.DictWriter(stream, fieldnames=fields)
                    writer.writeheader()
                    writer.writerows(result['results'])
        print(json.dumps(result['summary'], ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError, IndexError):
        # Never echo private paths, cells or exception payloads into CI/logs.
        parser.exit(2, 'Audit failed: invalid input or unsafe/unwritable destination; inspect locally.\n')


if __name__ == '__main__':
    main()
