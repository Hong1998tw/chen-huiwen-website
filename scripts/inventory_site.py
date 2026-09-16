#!/usr/bin/env python3
"""Inventory deployable sources and dependencies, not a second editable content database."""
import argparse, csv, hashlib, json, re, subprocess
from pathlib import Path
from urllib.parse import urlsplit, urljoin
from bs4 import BeautifulSoup
from collections import Counter
from audit_external_links import inventory as external_inventory
ROOT=Path(__file__).resolve().parents[1]

def source_for(name):
    if name.startswith('achievement-') or name=='achievements.html':return 'data/achievements.json','templates/case-page.html','scripts/build_cases.py'
    if name=='vision.html':return 'data/platforms.json','templates/platform-page.html','scripts/build_platforms.py'
    if name=='activities.html':return 'data/events.json','templates/events-page.html','scripts/build_events.py'
    return name,'hand-authored',''

def collect(root,as_of):
    names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=root,text=True).splitlines()
    pages={n:BeautifulSoup((root/n).read_text(),'html.parser') for n in sorted(set(names)) if n.endswith('.html') and not n.startswith(('templates/','tests/','.github/'))}
    assets=[];routes=[];images={};links=external_inventory(root);graph=[]
    for n,d in pages.items():
        source,template,builder=source_for(n);main=d.find('main');title=d.find('h1') or d.title
        refs=set()
        for el in d.select('[href],[src],[data-embed-src]'):
            raw=el.get('href') or el.get('src') or el.get('data-embed-src')
            if not raw:continue
            u=urlsplit(raw)
            if u.scheme in ('https','http'):refs.add(raw)
            elif not u.scheme:refs.add(urljoin(n,raw).split('#')[0].split('?')[0])
        canonical=d.select_one('link[rel="canonical"]');robots=d.select_one('meta[name="robots"]')
        routes.append({'route':n,'title':title.get_text(' ',strip=True) if title else '', 'source_of_truth':source,'template':template,'builder':builder,'canonical':canonical.get('href') if canonical else None,'robots':robots.get('content','') if robots else '', 'main_present':bool(main),'content_review':'BLOCKED: external facts not all reverified','dependencies':sorted(refs)})
        for dep in sorted(refs|{source,template,builder}-{'','hand-authored'}):graph.append({'source':dep,'affected_route':n,'relationship':'source/template/runtime reference; inspect generator for transitive details'})
        for el in d.select('img[src]'):
            src=el['src'].split('?')[0];im=images.setdefault(src,{'file':src,'uses':[],'rights_status':'BLOCKED','rights_reason':'Existing publication/provenance is not a fresh reuse license','owner_role':'素材權利審閱者（未指派）','review_frequency':'每次換圖及每季','original_locator':'Not resolved in this inventory','derivatives':[]})
            fig=el.find_parent('figure');caption=fig.find('figcaption') if fig else None
            im['uses'].append({'route':n,'alt':el.get('alt'),'width':el.get('width'),'height':el.get('height'),'caption':caption.get_text(' ',strip=True) if caption else ''})
    for n in sorted(set(names)):
        p=root/n
        if not p.is_file():continue
        if n.startswith(('tests/','.github/pr-evidence/','docs/')):continue
        deps=sorted({g['affected_route'] for g in graph if g['source']==n})
        source,template,builder=source_for(n) if n in pages else (n,'','')
        isimage=p.suffix.lower() in ('.jpg','.png','.webp','.avif','.svg')
        role='內容編輯（未指派）' if n in pages or n.startswith('data/') else '網站工程維護者（未指派）'
        assets.append({'asset_id':n,'purpose':'public page' if n in pages else 'image' if isimage else 'source/build/runtime asset','source_of_truth':source,'public_or_private':'public repository','owner_role':role,'dependencies':sorted({g['source'] for g in graph if g['affected_route']==n}),'affected_routes':deps or ([n] if n in pages else []),'update_trigger':'來源／共用元件變更','review_frequency':'每次 PR；內容每月、權利每季','evidence':n,'issue':'rights need review' if isimage else 'semantic review separate from structural inventory','priority':'P1' if isimage else 'P2','disposition':'retain and validate; not approved for additional reuse','bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        if isimage and n not in images:images[n]={'file':n,'uses':[],'rights_status':'BLOCKED','rights_reason':'Metadata-only/OG/vendor/unused reference needs role-specific review','owner_role':'素材權利審閱者（未指派）','review_frequency':'每次換圖及每季'}
    records=[]
    cases=json.loads((root/'data/achievements.json').read_text())
    for c in cases:records.append({'record_id':c['id'],'type':'achievement','source':'data/achievements.json','route':'achievement-'+c['id']+'.html','status':c['status'],'source_urls':[s.get('url') for s in c.get('sources',[])],'source_dates':[s.get('sourceDate') for s in c.get('sources',[])],'image_count':len(c.get('images',[])),'history_nodes':len(c.get('history',[])),'review':'not reverified; retain source precision'})
    for typ,sel,n in [('news','.news-report-card','news.html'),('press','.news-press-card','press.html')]:
        for i,c in enumerate(pages[n].select(sel),1):
            refs=[a['href'] for a in c.select('a[href]')];h=c.find('h2');date=c.select_one('.eyebrow')
            records.append({'record_id':c.get('id') or f'{n}#card-{i}','type':typ,'source':n,'title':h.get_text(' ',strip=True) if h else '', 'date_label':date.get_text(' ',strip=True) if date else '', 'source_urls':refs,'image_count':len(c.select('img')),'review':'original body review required; position IDs are inventory-only'})
    for c in json.loads((root/'data/events.json').read_text())['events']:records.append({'record_id':c['id'],'type':'event','source':'data/events.json','source_urls':[c.get('sourceUrl')],'start':c['start'],'end':c['end'],'review':'time/status and official schedule'})
    for c in json.loads((root/'data/platforms.json').read_text()).get('elections',[]):records.append({'record_id':str(c['year']),'type':'platform','source':'data/platforms.json','source_urls':[c.get('sourceUrl')],'pdfPage':c.get('pdfPage'),'review':'historical transcription not current promise; original PDF review separate'})
    return {'as_of':as_of,'revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'method':'Full tracked/unignored source listing; parsed metadata, not full fact or image-rights certification; no private input','summary':{'routes':len(routes),'records':dict(Counter(r['type'] for r in records)),'achievements_by_status':dict(Counter(c['status'] for c in cases)),'mapped_points':sum(bool(c.get('coordinates')) and c['status']!='待核驗' for c in cases),'published_history_nodes':sum(len(c.get('history',[])) for c in cases if c['status']!='待核驗'),'images':len(images),'external_urls':len(links),'assets':len(assets)},'assets':assets,'routes':routes,'records':records,'images':list(images.values()),'dependency_graph':graph,'external_dependencies':[{'url':url,'affected_routes':sorted(files),'owner_role':'外部帳號／來源維護者（未指派）','review_frequency':'每月及發布前','disposition':'link availability and facts checked separately'} for url,files in sorted(links.items())]}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--as-of',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    result=collect(a.root,a.as_of);a.output.mkdir(parents=True,exist_ok=True)
    (a.output/'inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    for key in ('assets','routes','records','images','dependency_graph','external_dependencies'):
        rows=result[key];fields=list(dict.fromkeys(k for r in rows for k in r))
        with (a.output/(key+'.csv')).open('w',encoding='utf-8-sig',newline='') as f:
            w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows({k:json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v for k,v in r.items()} for r in rows)
    print(json.dumps(result['summary'],ensure_ascii=False))
if __name__=='__main__':main()
