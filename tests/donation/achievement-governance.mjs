import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=new URL('../../',import.meta.url).pathname;
const out=root+'tests/donation/results/';await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8789','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const base='http://127.0.0.1:8789/';
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const source=JSON.parse(await readFile(root+'data/achievements.json','utf8')).filter(c=>c.status!=='待核驗');
const villages=JSON.parse(await readFile(root+'data/villages.json','utf8'));
const heads=new Map(villages.map(v=>[v.district+'|'+v.name,v.currentHead]));
const report={checks:[],failures:[],searchResults:{},externalResources:'Blocked for deterministic local candidate QA'};
const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'Passed'});}catch(e){report.failures.push(name);report.checks.push({name,status:'Failed',error:String(e)});}};
const browser=await chromium.launch({headless:true});
try{
 for(const width of [1440,390]){
  const ctx=await browser.newContext({viewport:{width,height:960}});
  await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const page=await ctx.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'achievements.html');await page.waitForFunction(()=>!!window.HuiwenCases);
  await check(`${width}: head/address search matches published JSON`,async()=>{
   for(const q of ['莫尚忠','李錦珠','過埤里','五甲二路565巷','頂庄路','文福里','國慶九街','過埤路2巷']){
    const expected=source.filter(c=>[c.title,c.summary,c.scope,c.status,c.locationName,c.locationNote,...c.categories,...c.subcategories,...c.villages,...c.villages.map(v=>heads.get(c.district+'|'+v)),...c.paragraphs,...c.history.flatMap(h=>[h.date,h.title,h.text])].filter(Boolean).join(' ').includes(q)).map(c=>c.id);
    await page.locator('#case-search').fill(q);
    await page.waitForFunction(n=>window.HuiwenCases.getState().visible.length===n,expected.length);
    assert.deepEqual(await page.evaluate(()=>window.HuiwenCases.getState().visible.map(c=>c.id)),expected);
    report.searchResults[q]=expected;
   }
  });
  await check(`${width}: global search indexes current head and address`,async()=>{
   await page.keyboard.press('Control+k');const input=page.locator('#global-search-dialog input');await input.fill('莫尚忠');
   await page.locator('.global-search-result[href="achievement-dingbao-bridge.html"]').waitFor();
   await input.fill('過埤路2巷');await page.locator('.global-search-result[href="achievement-guopi-retaining-wall.html"]').waitFor();await page.keyboard.press('Escape');
  });
  await check(`${width}: filters, pagination, dashboard and map`,async()=>{
   await page.locator('#reset-map-filters').click();
   await page.waitForFunction(n=>window.HuiwenCases.getState().visible.length===n,source.length);
   assert.equal(await page.locator('#case-list .case-card:visible').count(),Math.min(10,source.length));
   assert.equal(Number(await page.locator('.digital-stat strong').first().textContent()),source.length);
   await page.getByRole('button',{name:'下一頁',exact:true}).click();assert(new URL(page.url()).searchParams.get('page')==='2');
   await page.locator('#village-filter').selectOption('v:過埤里');
   await page.waitForFunction(n=>window.HuiwenCases.getState().visible.length===n,source.filter(c=>c.villages.includes('過埤里')).length);
   assert.equal(await page.locator('#case-list .case-card:visible').count(),source.filter(c=>c.villages.includes('過埤里')).length);
   await page.locator('[data-locate="dingbao-bridge"]').click();await page.locator('.map-insight-panel').waitFor();
   assert(new URL(page.url()).searchParams.get('case')==='dingbao-bridge');
   assert(await page.locator('.leaflet-overlay-pane path').count()>0);
  });
  await check(`${width}: single, cross-village and city facts`,async()=>{
   for(const id of ['wende-school-center','dingbao-bridge','senior-transit-card','guopi-retaining-wall']){
    await page.goto(base+'achievement-'+id+'.html');const c=source.find(c=>c.id===id);const facts=await page.locator('.case-facts').textContent();
    assert(facts.includes(c.status));
    for(const v of c.villages){assert(facts.includes(v));assert(facts.includes(heads.get(c.district+'|'+v)));}
    if(c.scope==='全市政策'){assert(facts.includes('高雄市'));assert(facts.includes('不適用'));}
    else{assert(facts.includes(c.locationName));assert(facts.includes(c.locationNote));}
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   }
   await page.goto(base+'achievement-dingbao-bridge.html');
   await page.locator('.case-facts').screenshot({path:out+`governance-facts-${width}.png`});
   const axe=await new AxeBuilder({page}).include('.case-layout').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   assert.deepEqual(axe.violations.map(v=>v.id),[]);
  });
  await check(`${width}: all public detail pages contain semantic readable facts`,async()=>{
   for(const c of source){await page.goto(base+'achievement-'+c.id+'.html');assert.equal(await page.locator('.case-facts dt').count(),await page.locator('.case-facts dd').count());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   assert.deepEqual(errors,[]);
  });
  if(width===390)await check('390: menu opens and returns keyboard focus',async()=>{await page.locator('.menu-toggle').click();assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'false');});
  await ctx.close();
 }
 await check('No JavaScript: all cards, head names and facts remain readable',async()=>{
  const ctx=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const page=await ctx.newPage();await page.goto(base+'achievements.html');
  assert.equal(await page.locator('#case-list .case-card:visible').count(),source.length);
  await page.goto(base+'achievement-dingbao-bridge.html');assert.match(await page.locator('.case-facts').textContent(),/莫尚忠/);assert.match(await page.locator('.case-facts').textContent(),/楊居財/);await ctx.close();
 });
}finally{await browser.close();server.kill();await writeFile(out+'achievement-governance-report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
