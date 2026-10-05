#!/usr/bin/env python3
"""Fail closed on malformed metadata, missing villages and private payloads.

This validates traceability, not the truth of linked claims. Human evidence
review remains required. Diagnostics never echo detected private content.
"""
import argparse
from datetime import date
import json
import math
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, unquote

from achievement_metadata import STATUSES, is_public, joined_villages, village_lookup
from case_media import classify

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
MOBILE = re.compile(r'(?<!\d)(?:09\d{2}[ -]?\d{3}[ -]?\d{3}|\+886[ -]?9\d{2}[ -]?\d{3}[ -]?\d{3})(?!\d)')
IDENTITY = re.compile(r'(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![A-Za-z0-9])')
SECRET = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:token|password|secret|api[_-]?key)\s*[=:]\s*["\x27]?[A-Za-z0-9_/-]{12,}', re.I)
PRIVATE_KEYS = {'candidate_id', 'source_file', 'source_sheet', 'source_row', 'notes_private', 'original_case_id', 'phone', 'mobile', 'id_number', 'credential', 'password', 'token'}
PUBLIC_SOURCE_PRIVATE_KEYS = {
    'notes', 'editorialReview', 'verification', 'verifiedAt', 'villageMethod',
}
PUBLIC_SOURCE_PRIVATE_CITATION_KEYS = {'checkedAt'}
PUBLIC_SOURCE_PRIVATE_MEDIA_KEYS = {'publicAccessConfirmed'}
INTERNAL = re.compile(r'待核驗|內部查核|私人備註|notes_private|candidate_status|verification_status|attribution_status')


def valid_date(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def valid_case_period(value):
    if not isinstance(value, str) or not value or len(value) > 60 or privacy_issues(value):
        return False
    if re.fullmatch(r'20\d{2}', value):
        return True
    if re.fullmatch(r'20\d{2}-(?:0[1-9]|1[0-2])', value):
        return True
    if valid_date(value):
        return True
    return bool(re.fullmatch(r'20\d{2}-\d{2}-\d{2} (?:\d{2}:\d{2}–\d{2}:\d{2}|至 \d{2}-\d{2})|\d{3}學年度第[12]學期|第\d+屆第\d+次定期大會', value))


def traceable(source):
    if not isinstance(source, dict) or not source.get('title'):
        return False
    try:
        u = urlsplit(source.get('url', ''))
        return u.scheme in {'http', 'https'} and bool(u.hostname) and not u.username and not u.password and u.path not in {'', '/'}
    except ValueError:
        return False


def privacy_issues(value):
    issues = set()
    def walk(item):
        if isinstance(item, dict):
            if PRIVATE_KEYS.intersection(item):
                issues.add('private_field')
            for v in item.values():
                walk(v)
        elif isinstance(item, list):
            for v in item:
                walk(v)
        elif isinstance(item, str):
            if MOBILE.search(item):
                issues.add('mobile_pattern')
            if IDENTITY.search(item):
                issues.add('identity_pattern')
            if SECRET.search(item):
                issues.add('credential_pattern')
            if re.search(r'(?:陳情人|住戶|申請人|民眾姓名|家庭成員)\s*[:：]?\s*[\u3400-\u9fff]{2,4}.*(?:路|街|巷).*\d+號', item):
                issues.add('person_and_residential_address')
            for raw in re.findall(r'https?://[^\s<>"\x27]+', item):
                try:
                    u = urlsplit(unquote(raw))
                    host = (u.hostname or '').lower()
                    if any(host == d or host.endswith('.'+d) for d in ('notion.so', 'notion.site', 'notion.com', 'drive.google.com', 'docs.google.com')):
                        issues.add('private_document_url')
                    if u.username or u.password or re.search(r'(?:token|api_key|secret|password)=', u.query, re.I):
                        issues.add('url_credential')
                except ValueError:
                    issues.add('invalid_url')
    walk(value)
    return sorted(issues)


def validate_partners(case, label, errors):
    partners = case.get('villageHeadPartners', [])
    if not isinstance(partners, list):
        errors.append(label + ': villageHeadPartners must be a list')
        return
    seen = set()
    for index, partner in enumerate(partners, start=1):
        p_label = f'{label}: villageHeadPartners {index}'
        if not isinstance(partner, dict):
            errors.append(p_label + ': invalid object')
            continue
        for field in ('village', 'name', 'role'):
            if not isinstance(partner.get(field), str) or not partner[field].strip():
                errors.append(p_label + ': missing ' + field)
        key = tuple(partner.get(k, '') for k in ('village', 'name', 'from', 'to'))
        if key in seen:
            errors.append(p_label + ': duplicate historical partner')
        seen.add(key)
        for field in ('from', 'to'):
            if partner.get(field) is not None and not valid_date(partner[field]):
                errors.append(p_label + ': invalid ' + field + ' date')
        if valid_date(partner.get('from')) and valid_date(partner.get('to')) and partner['from'] > partner['to']:
            errors.append(p_label + ': from date after to date')
        source = partner.get('source')
        if not traceable(source):
            errors.append(p_label + ': source needs titled traceable URL')
        elif source.get('sourceDate') is not None and not valid_date(source['sourceDate']):
            errors.append(p_label + ': invalid source date')


def validate(achievements, villages, baseline=None, public_source_only=False):
    errors, warnings = [], []
    if not isinstance(achievements, list) or not isinstance(villages, list):
        return ['source must be a list'], []
    try:
        lookup = village_lookup(villages)
    except (ValueError, TypeError, AttributeError) as exc:
        return ['village lookup invalid: ' + str(exc)], []
    for n, village in enumerate(villages):
        label = f'village row {n + 1}'
        if not valid_date(village.get('verifiedAt')) or village['verifiedAt'] > date.today().isoformat():
            errors.append(label + ': invalid verification date')
        if village.get('sourceDate') is not None and not valid_date(village['sourceDate']):
            errors.append(label + ': invalid source date')
        if not traceable({'title': 'official boundary source', 'url': village.get('sourceUrl')}):
            errors.append(label + ': missing traceable source')
        else:
            host = urlsplit(village['sourceUrl']).hostname
            if not host or not host.endswith('.gov.tw'):
                errors.append(label + ': village source must be official')
        if not village.get('boundaryName'):
            errors.append(label + ': missing boundaryName')
        errors.extend(label + ': ' + issue for issue in privacy_issues(village))
    seen = set()
    for n, a in enumerate(achievements):
        label = f'achievement row {n + 1}'
        if not isinstance(a, dict):
            errors.append(label + ': invalid object')
            continue
        aid = a.get('id')
        if not isinstance(aid, str) or not ID.fullmatch(aid) or aid in seen:
            errors.append(label + ': invalid or duplicate stable ID')
        else:
            seen.add(aid)
        if a.get('status') not in STATUSES:
            errors.append(label + ': invalid status')
        if public_source_only:
            if not is_public(a):
                errors.append(label + ': source contains a non-public record')
            if PUBLIC_SOURCE_PRIVATE_KEYS.intersection(a):
                errors.append(label + ': source contains a review-only field')
            source_rows = a.get('sources')
            if isinstance(source_rows, list) and any(
                    isinstance(source, dict) and PUBLIC_SOURCE_PRIVATE_CITATION_KEYS.intersection(source)
                    for source in source_rows):
                errors.append(label + ': source citation contains a review-only field')
            media_rows = a.get('media')
            if isinstance(media_rows, list) and any(
                    isinstance(media, dict) and PUBLIC_SOURCE_PRIVATE_MEDIA_KEYS.intersection(media)
                    for media in media_rows):
                errors.append(label + ': source media contains a review-only field')
        if not isinstance(a.get('villages'), list) or len(a['villages']) != len(set(a['villages'])):
            errors.append(label + ': villages must be a unique list')
        else:
            try:
                joined_villages(a, lookup)
            except KeyError:
                errors.append(label + ': unknown district/village')
        validate_partners(a, label, errors)
        coords = a.get('coordinates')
        if coords is not None:
            if not (isinstance(coords, list) and len(coords) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in coords) and -90 <= coords[0] <= 90 and -180 <= coords[1] <= 180):
                errors.append(label + ': invalid coordinates')
        # External media links have their own narrow provider/URL validation.
        # All other fields retain the private Drive/document URL prohibition.
        errors.extend(label + ': ' + issue for issue in privacy_issues({k: v for k, v in a.items() if k != 'media'}))
        if not is_public(a):
            continue
        for field in ('title', 'categories', 'scope', 'sources', 'updated', 'district'):
            if not a.get(field):
                errors.append(label + ': missing ' + field)
        if not isinstance(a.get('categories'), list):
            errors.append(label + ': categories must be a list')
        if not valid_date(a.get('updated')):
            errors.append(label + ': invalid updated date')
        sources = a.get('sources', [])
        if not isinstance(sources, list) or not sources or not all(traceable(s) for s in sources):
            errors.append(label + ': sources need titled traceable URLs')
        elif any(s.get('sourceDate') and not valid_case_period(s['sourceDate']) for s in sources):
            errors.append(label + ': invalid source date')
        funding = a.get('funding')
        if funding is not None:
            fields = {'basis', 'currency', 'total', 'centralGrant', 'approvedOn', 'approvalReference', 'collaboration', 'sourceTitle', 'sourceUrl'}
            if not isinstance(funding, dict) or set(funding) != fields:
                errors.append(label + ': funding needs the reviewed field contract')
            else:
                if funding['basis'] != '核定總經費' or funding['currency'] != 'TWD':
                    errors.append(label + ': funding basis or currency is unsupported')
                values = (funding['total'], funding['centralGrant'])
                if any(type(x) is not int or x <= 0 for x in values) or (all(type(x) is int for x in values) and values[1] > values[0]):
                    errors.append(label + ': funding amounts must be positive TWD integers with grant within total')
                if not valid_date(funding['approvedOn']):
                    errors.append(label + ': funding approval date is invalid')
                for key in ('approvalReference', 'collaboration', 'sourceTitle'):
                    if not isinstance(funding[key], str) or not funding[key].strip() or len(funding[key]) > 500:
                        errors.append(label + ': funding needs ' + key)
                if not traceable({'title': funding['sourceTitle'], 'url': funding['sourceUrl']}) or funding['sourceUrl'] not in [s.get('url') for s in sources if isinstance(s, dict)]:
                    errors.append(label + ': funding source must match a public case source')
        history = a.get('history', [])
        if not isinstance(history, list) or any(not isinstance(row, dict) or not valid_case_period(row.get('date')) or
                not isinstance(row.get('title'), str) or not row['title'].strip() or
                not isinstance(row.get('text'), str) or not row['text'].strip() for row in history):
            errors.append(label + ': invalid history date, title or explanation')
        section_order = a.get('sectionOrder')
        if section_order is not None and (not isinstance(section_order, list) or
                len(section_order) != 4 or set(map(str, section_order)) != {'overview', 'media', 'history', 'sources'} or
                not all(isinstance(key, str) for key in section_order)):
            errors.append(label + ': invalid section order')
        media = a.get('media', [])
        if not isinstance(media, list) or len(media) > 24:
            errors.append(label + ': media must be a list of at most 24 items')
        else:
            for index, item in enumerate(media):
                prefix = f'{label}: media {index + 1}'
                if not isinstance(item, dict) or set(item) != {'kind', 'url', 'alt', 'caption', 'credit'}:
                    errors.append(prefix + ': invalid fields')
                    continue
                if item['kind'] not in {'photo', 'video'} or not isinstance(item['url'], str) or not classify(item['url'], item['kind']):
                    errors.append(prefix + ': unsupported public media URL')
                for key in ('alt', 'caption', 'credit'):
                    if not isinstance(item[key], str) or not item[key].strip() or len(item[key]) > 500 or privacy_issues(item[key]):
                        errors.append(prefix + ': invalid ' + key)
        image_metadata = a.get('imageMetadata', {})
        if not isinstance(image_metadata, dict):
            errors.append(label + ': imageMetadata must be an object')
        else:
            for filename, metadata in image_metadata.items():
                if filename not in a.get('images', []) or not isinstance(metadata, dict) or not all(isinstance(metadata.get(k), str) and metadata[k].strip() for k in ('alt', 'caption', 'credit', 'sourceUrl')):
                    errors.append(label + ': image metadata needs matching image, alt, caption, credit and source')
                elif not traceable({'title': metadata['credit'], 'url': metadata['sourceUrl']}):
                    errors.append(label + ': image source needs a traceable URL')
        if a.get('scope') == '全市政策':
            if a.get('villages') or coords is not None:
                errors.append(label + ': city policy must not use a village/point')
        elif a.get('scope') != '跨區服務' and not a.get('locationName'):
            errors.append(label + ': local work needs public locationName')
        public_fields = {k: a.get(k) for k in ('title', 'summary', 'paragraphs', 'history', 'locationName', 'locationNote', 'budget', 'funding', 'imageMetadata', 'villageHeadPartners')}
        if INTERNAL.search(json.dumps(public_fields, ensure_ascii=False)):
            errors.append(label + ': internal language in public fields')
        if re.search(r'\d+(?:之\d+)?號', a.get('locationName', '')):
            warnings.append(label + ': numbered location needs public-engineering evidence review')
    if baseline is not None:
        previous = {a['id'] for a in baseline if is_public(a)}
        if previous - seen:
            errors.append('baseline stable IDs removed/renamed; explicit migration required')
    return errors, warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', type=Path, default=ROOT / 'data/achievements.json')
    parser.add_argument('--villages', type=Path, default=ROOT / 'data/villages.json')
    parser.add_argument('--baseline-ref', help='Git ref used only to enforce preservation of existing IDs')
    args = parser.parse_args()
    try:
        baseline = json.loads(subprocess.check_output(['git', 'show', args.baseline_ref + ':data/achievements.json'], cwd=ROOT, text=True)) if args.baseline_ref else None
        errors, warnings = validate(json.loads(args.public.read_text()), json.loads(args.villages.read_text()), baseline,
                                    public_source_only=True)
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.CalledProcessError):
        parser.exit(2, 'Achievement validation failed: invalid source structure.\n')
    print(json.dumps({'status': 'Failed' if errors else 'Passed', 'errors': errors, 'warnings': warnings}, ensure_ascii=False, indent=2))
    raise SystemExit(bool(errors))


if __name__ == '__main__':
    main()
