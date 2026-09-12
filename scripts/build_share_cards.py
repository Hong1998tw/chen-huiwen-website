#!/usr/bin/env python3
"""Render exact title cards (1200 × 630), without invented project photography.
Requires Pillow and Noto Sans CJK TC; pass --font for a local licensed font.
PNG output is committed, so normal site builds do not need rendering dependencies.
"""
import argparse, json, hashlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
R=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--font',default=str(Path.home()/'.local/share/fonts/NotoSansCJKtc-Regular.otf'));args=parser.parse_args()
font=Path(args.font)
if not font.exists(): raise SystemExit('Provide --font /path/to/NotoSansCJKtc-Regular.otf (SIL OFL 1.1).')
items=[x for x in json.loads((R/'data/achievements.json').read_text()) if x['status']!='待核驗']
records=[('achievements','慧做事・政績地圖','建設與服務紀錄','依里別、主題與歷程查詢')]+[('achievement-'+x['id'],x['title'],x['status'],'、'.join(x['villages']) or x['scope']) for x in items]
out=R/'assets/og';out.mkdir(exist_ok=True)
manifest={}
for slug,title,status,place in records:
 im=Image.new('RGB',(1200,630),'#f6f7ef');d=ImageDraw.Draw(im)
 d.rectangle((0,0,1200,18),fill='#075548')
 d.rounded_rectangle((64,62,133,131),radius=20,fill='#075548')
 d.text((80,63),'文',font=ImageFont.truetype(str(font),42),fill='#def68d')
 d.text((153,68),'陳慧文',font=ImageFont.truetype(str(font),32),fill='#075548')
 d.text((154,111),'高雄市議員・鳳山區',font=ImageFont.truetype(str(font),18),fill='#526b60')
 badgefont=ImageFont.truetype(str(font),21);w=d.textlength(status,font=badgefont)
 d.rounded_rectangle((1068-w,70,1136,116),radius=23,fill='#def68d')
 d.text((1084-w,76),status,font=badgefont,fill='#075548')
 size=58;f=ImageFont.truetype(str(font),size);lines=[];line=''
 for char in title:
  if d.textlength(line+char,font=f)>1055:lines.append(line);line=char
  else:line+=char
 if line:lines.append(line)
 assert len(lines)<=3,(slug,lines)
 for i,line in enumerate(lines):d.text((64,218+i*82),line,font=f,fill='#075548',stroke_width=1)
 d.line((64,501,1136,501),fill='#cdd9cb',width=2)
 d.text((64,533),place,font=ImageFont.truetype(str(font),24),fill='#526b60')
 d.text((878,533),'www.huiwen.tw',font=ImageFont.truetype(str(font),26),fill='#075548')
 path=out/(slug+'.png');im.save(path,optimize=True)
 manifest[slug]={'title':title,'status':status,'place':place,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('Rendered',len(records),'exact-title PNG share cards')
