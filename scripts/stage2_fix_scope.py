#!/usr/bin/env python3
from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
p=root/'data'/'achievements.json'
items=json.loads(p.read_text(encoding='utf-8'))
case=next(x for x in items if x['id']=='special-education-support')
case['categories']=['教育與文化','社福與衛環']
case['villages']=[]
case['villageMethod']='全市特殊教育支持措施，不以單一里別代表服務範圍'
case['scope']='全市政策'
case['district']='高雄市'
case['coordinates']=None
case['locationName']=''
case['locationNote']='全市政策，不以單一學校或里別作地圖代表點'
case.setdefault('verification',{})['location']='全市政策；4所特殊學校之重症復康巴士學生依教育局審查適用'
p.write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

market=root/'activity-market.html'
s=market.read_text(encoding='utf-8')
old='走進市場，看攤商故事與攤位改造。展期為2026年6月27日至7月12日，展覽已結束。'
new='五福市場職人展完整活動回顧：學生走進市場記錄攤商故事，從布展困難到攤商主動參與，保留鳳山傳統市場的地方記憶。'
s=s.replace(f'<meta property="og:description" content="{old}">',f'<meta property="og:description" content="{new}">')
s=s.replace(f'<meta name="twitter:description" content="{old}">',f'<meta name="twitter:description" content="{new}">')
market.write_text(s,encoding='utf-8')
print('Corrected special education scope and market social metadata')
