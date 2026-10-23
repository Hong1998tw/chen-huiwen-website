/** Public snapshot adapter. Never mutates source or infers a budget/date. */
export const COLORS={A1:'#4f9fc4',A2:'#e4994a',A3:'#e48f9e',A4:'#8f84cf',AX:'#6fae6a',AQ:'#075548'};
export const clean=(s='')=>String(s).replaceAll('鳳山區','鳳山').replaceAll('已完成','成果進度').replaceAll('待確認','資料未提供').replaceAll('優化','改善');
export const safeURL=s=>{try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:null}catch{return null}};
export function dateYear(value){const m=String(value||'').match(/^(20\d{2})(?:-|$)/);return m?+m[1]:null}
export function createIndex(data){
 const islands=new Map([...(data.islands||[]),...(data.base?[data.base]:[])].map(x=>[x.id,x])),projects=new Map((data.projects||[]).map(x=>[x.id,x]));
 const items=(data.items||[]).map((r,index)=>{const island=islands.get(r.i),h=(r.h||[]).filter(x=>Array.isArray(x)&&x.length>=2).map(([date,text])=>({date:String(date),text:clean(text)}));const years=h.map(x=>dateYear(x.date)).filter(Boolean);return {index,id:r.id||`item:${index}`,title:clean(r.t),summary:clean(r.s),island:r.i,islandName:clean(island?.name||r.i),color:COLORS[island?.axis]||'#45646c',villages:r.v||[],project:r.p||null,projectName:clean(projects.get(r.p)?.name||''),budget:r.b?clean(r.b):'資料未提供',timeline:h,years,firstYear:years.length?Math.min(...years):null,people:/提案|議案/.test(r.t||'')?[]:[...(r.pc||[]).map(n=>`議員：${n}`),...(r.pv||[]).map(n=>`里長：${n}`),...(r.pl||[]).map(n=>`立委：${n}`)].map(clean),sourceURL:safeURL(r.url||r.sourceUrl),layer:clean(r.layer)};});
 return {data,items,islands,projects};
}
export function filterItems(items,f={}){return items.filter(x=>(!f.island||x.island===f.island)&&(!f.village||x.villages.includes(f.village))&&(!f.project||x.project===f.project)&&(!f.year||x.years.includes(+f.year))&&(!f.query||`${x.title} ${x.summary}`.includes(f.query)));}
export function relations(index,item){
 const edges=[{label:item.islandName,kind:'所在島嶼',reason:'',island:item.island}];
 if(item.project)edges.push({label:item.projectName,kind:'正式專案',reason:'同一個專案的其他項目',project:item.project,island:item.island});
 for(const t of index.data.interpellations?.threads||[])if(t.island===item.island)edges.push({label:clean(t.title),kind:'質詢追蹤',reason:'慧文在議會追問的相關議題',island:t.island});
 for(const h of index.data.hearings||[])if(h.island===item.island)edges.push({label:clean(h.title),kind:'同島公聽會',reason:'慧文主持的相關公聽會',island:h.island});
 const p=index.islands.get(item.island);if(p?.pledge)edges.push({label:clean(p.pledge),kind:'2026 政見',reason:'這座島的 2026 政見',island:item.island});
 return edges;
}
export function audit(index){return {items:index.items.length,missingSourceURL:index.items.filter(x=>!x.sourceURL).length,missingBudget:index.items.filter(x=>x.budget==='資料未提供').length,missingTimelineYear:index.items.filter(x=>!x.years.length).length,unknownIsland:index.items.filter(x=>!index.islands.has(x.island)).map(x=>x.index),unknownProject:index.items.filter(x=>x.project&&!index.projects.has(x.project)).map(x=>x.index),notes:['項目沒有穩定識別碼時，item:index 僅在本次快照有效。','合作人員不等於提案連署者；提案類卡片不列人名。','所有關聯預設為來源欄位關係，不以標題相似推定因果。']};}
