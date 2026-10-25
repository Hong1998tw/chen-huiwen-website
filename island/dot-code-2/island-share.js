/** Material-only share card. Local canvas; no external image requests. */
export async function exportCardPNG(item){
 await document.fonts?.ready;const c=document.createElement('canvas');c.width=1080;c.height=1350;const g=c.getContext('2d');
 g.fillStyle='#f4f3ee';g.fillRect(0,0,1080,1350);g.fillStyle=item.color;g.fillRect(0,0,1080,24);let y=100;
 const line=(text,size=30,color='#243b40',maxLines=5)=>{g.font=`${size>=44?'700':'400'} ${size}px "Huiwen Island Sans",sans-serif`;g.fillStyle=color;let row='',count=0;for(const ch of String(text)){if(g.measureText(row+ch).width>920){g.fillText(row,80,y);y+=size*1.5;row='';if(++count>=maxLines){g.fillText('…完整內容請查看網站圖卡',80,y);y+=size*1.5;return}}row+=ch}if(row){g.fillText(row,80,y);y+=size*1.5}};
 line(item.islandName,30,item.color,1);y+=22;line(item.title,48,'#17383e',4);y+=24;if(item.villages.length)line(`里別｜${item.villages.join('、')}`,28,'#48626a',2);if(item.budget&&item.budget!=='資料未提供')line(`經費｜${item.budget}`,28,'#48626a',2);if(item.projectName)line(`專案｜${item.projectName}`,28,'#48626a',2);y+=24;
 for(const h of item.timeline.slice(-3)){if(y>1000)break;line(h.date,25,item.color,1);line(h.text,29,'#243b40',2);y+=12;}
 g.fillStyle='#48626a';g.font='400 25px "Huiwen Island Sans",sans-serif';g.fillText('做得到的承諾，看得見的改變。',80,1250);g.fillText('隆洋慧聚｜陳慧文議員 政績島　www.huiwen.tw/island',80,1295);
 const blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('PNG 匯出失敗')),'image/png'));
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`成果圖卡-${item.index}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return blob;
}
