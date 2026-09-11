#!/usr/bin/env python3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / 'index.html', ROOT / 'election.html', ROOT / 'facts.html', ROOT / 'press.html',
    ROOT / 'vision.html', ROOT / 'activities.html', ROOT / 'achievements.html', ROOT / 'explore.html',
]
FILES += sorted(ROOT.glob('achievement-*.html'))
FORBIDDEN = [
    '待核驗', '資料核驗', '資料查核', '來源邊界', '不混為完成',
    '正式選舉公報尚未取得', '本次查核', '不提前宣告成果',
    '不推定完成', '查核日期',
]
failures = []
for path in FILES:
    if not path.exists():
        continue
    text = path.read_text(encoding='utf-8')
    for phrase in FORBIDDEN:
        if phrase in text:
            failures.append(f'{path.name}: forbidden public copy: {phrase}')
if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print(f'Public copy validation passed for {len([p for p in FILES if p.exists()])} files.')
