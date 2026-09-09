#!/usr/bin/env python3
from pathlib import Path
import json
p=Path(__file__).resolve().parents[1]/'data'/'achievements.json'
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
print('Corrected special-education-support to citywide policy scope')
