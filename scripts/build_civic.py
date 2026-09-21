"""Generate public discovery views from existing reviewed records; no remote input."""
from pathlib import Path
import json, html, re, hashlib
from achievement_metadata import is_public
R=Path(__file__).resolve().parents[1]
def e(v): return html.escape(str(v),quote=True)
def block(text,name,body):
    pattern=rf'<!-- {name}:start -->.*?<!-- {name}:end -->'
    replacement=f'<!-- {name}:start -->\n{body}\n<!-- {name}:end -->'
    if not re.search(pattern,text,re.S): raise ValueError('Missing generation marker '+name)
    return re.sub(pattern,lambda _:replacement,text,flags=re.S)
def build():
    data={x['id']:x for x in json.loads((R/'data/achievements.json').read_text()) if is_public(x)}
    config=json.loads((R/'data/civic-home.json').read_text())
    ids=[config['featured'],*config['reading']]
    if len(set(ids))!=len(ids) or any(i not in data for i in ids): raise ValueError('Home selection must reference unique public records')
    c=data[config['featured']];url='achievement-'+c['id']+'.html'
    photo=''
    if c['images']:
        image=c['images'][0];meta=c['imageMetadata'][image];w,h=c['imageDimensions'][image]
        photo=f'<figure class="civic-feature-photo"><img src="assets/{e(image)}" alt="{e(meta["alt"])}" width="{w}" height="{h}" loading="lazy"><figcaption>{e(meta["caption"])} · <a href="{e(meta["sourceUrl"])}" target="_blank" rel="noopener noreferrer">{e(meta["credit"])} ↗</a></figcaption></figure>'
    feature=f'<article class="civic-feature">{photo}<div class="civic-feature-copy"><p class="civic-kicker">地方專題 · {e(c["status"])}</p><h3><a href="{url}">{e(c["title"])}</a></h3><p>{e(c["summary"])}</p><a class="civic-read" href="{url}">閱讀歷程與資料來源 <span aria-hidden="true">↗</span></a><small>內容更新 <time datetime="{e(c["updated"])}">{e(c["updated"])}</time></small></div></article>'
    rows=[]
    for index,id in enumerate(config['reading'],1):
        c=data[id];rows.append(f'<article class="civic-reading-row"><span class="civic-number" aria-hidden="true">0{index}</span><div><p class="civic-kicker">{e(c["categories"][0])} · {e(c["status"])}</p><h3><a href="achievement-{e(id)}.html">{e(c["title"])}</a></h3><p>{e(c["summary"])}</p><small>內容更新 <time datetime="{e(c["updated"])}">{e(c["updated"])}</time></small></div></article>')
    page=R/'index.html';text=page.read_text();text=block(text,'civic-stories',feature+'<div class="civic-reading">'+''.join(rows)+'</div>');page.write_text(text)
    css=hashlib.sha256((R/'civic.css').read_bytes()).hexdigest()[:12]
    js=hashlib.sha256((R/'civic.js').read_bytes()).hexdigest()[:12]
    site=hashlib.sha256((R/'site.js').read_bytes()).hexdigest()[:12]
    digital=hashlib.sha256((R/'digital.js').read_bytes()).hexdigest()[:12]
    for path in sorted(R.glob('*.html')):
        text=path.read_text()
        if '<main' not in text: continue
        text=re.sub(r'<link[^>]+href="/?civic\.css[^>]+>\s*','',text)
        text=re.sub(r'<script[^>]+src="/?civic\.js[^>]*></script>\s*','',text)
        prefix='/' if path.name=='404.html' else ''
        text=text.replace('</head>',f'<link rel="stylesheet" href="{prefix}civic.css?v={css}">\n<script src="{prefix}civic.js?v={js}" defer></script>\n</head>')
        text=re.sub(r'site\.js\?v=[^"\s]+','site.js?v='+site,text)
        text=re.sub(r'digital\.js\?v=[^"\s]+','digital.js?v='+digital,text)
        path.write_text(text)
    print('Built civic home and shared public reading assets')
if __name__=='__main__': build()
