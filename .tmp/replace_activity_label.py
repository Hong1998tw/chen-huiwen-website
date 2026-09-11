from pathlib import Path
for p in Path('.').glob('*.html'):
    text=p.read_text()
    if '活動公告' in text:
        p.write_text(text.replace('活動公告','公開行程與活動'))
