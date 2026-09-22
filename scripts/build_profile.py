#!/usr/bin/env python3
"""Project the recorded identity cutoff into About; calendar dates never infer office."""
from pathlib import Path
from datetime import date
from html import escape
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def render_status(profile):
    identity = profile['identity']
    date.fromisoformat(identity['recordAsOf'])
    date.fromisoformat(identity['reviewAfter'])
    e = lambda value: escape(str(value), quote=True)
    return (f'<p class="about-profile-note">身分資料截至 '
            f'<time datetime="{e(identity["recordAsOf"])}">{e(identity["recordAsOf"])}</time>，'
            f'記錄身分為{e(identity["confirmedRole"])}。後續任期與任職狀態請核對'
            f'<a href="{e(identity["sourceUrl"])}" target="_blank" rel="noopener noreferrer">高雄市議會官方介紹 ↗</a>。</p>')


def main():
    path = ROOT / 'about.html'
    content = path.read_text()
    profile = json.loads((ROOT / 'data/site-profile.json').read_text())
    marker = r'<!-- profile-status:start -->.*?<!-- profile-status:end -->'
    if len(re.findall(marker, content, flags=re.S)) != 1:
        raise ValueError('About must contain exactly one profile-status marker pair')
    content = re.sub(marker, lambda _: '<!-- profile-status:start -->' + render_status(profile) + '<!-- profile-status:end -->', content, flags=re.S)
    path.write_text(content)
    print('Built recorded identity cutoff in about.html')


if __name__ == '__main__':
    main()
