import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';

const root=new URL('../../',import.meta.url).pathname;
const out=root+'tests/donation/results/';await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8789','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const base='http://127.0.0.1:8789/';
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}

const allSource=JSON.parse(await readFile(root+'data/achievements.json','utf8'));
const source=allSource.filter(c=>c.status!=='待核驗');
const sourceById=new Map(source.map(c=>[c.id,c]));
const villages=JSON.parse(await readFile(root+'data/villages.json','utf8'));
const villageKeys=new Set(villages.map(v=>v.district+'|'+v.name));
const sitemap=await readFile(root+'sitemap.xml','utf8');
const manifest=JSON.parse(await readFile(root+'assets/og/manifest.json','utf8'));
const firstPublicIds=[
 'changle-hexing-youbike','dade-park-road-opening','dadong-park-governance','dalinpu-relocation-planning',
 'east-wujia-future-industry-zone','fengbei-lane127-road-opening','fengshan-columbarium-capacity',
 'fengxin-softball-lighting','gaofeng-drain','nanhe-park-youbike','personal-mobility-device-rules',
 'wufu-2nd-lane81-drainage','wujia-public-parking'
];
const updatedPublicIds=['guangfu-drainage','mingfeng-12-gongyuan-road'];
const targetIds=[...firstPublicIds,...updatedPublicIds];
const report={scope:'Step 7 achievement candidate QA',checks:[],failures:[],metrics:{},targets:targetIds};
const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'Passed'});}catch(e){report.checks.push({name,status:'Failed',error:String(e)});report.failures.push(name);}};
const searchable=c=>[
 c.title,c.summary,c.scope,c.status,c.locationName,c.locationNote,...(c.categories||[]),...(c.subcategories||[]),
 ...(c.villages||[]),...(c.paragraphs||[]),...(c.villageHeadPartners||[]).flatMap(p=>[p.village,p.name,p.role,p.from,p.to]),
 ...(c.history||[]).flatMap(h=>[h.date,h.title,h.text])
].filter(Boolean).join(' ');

await check('Source targets and current village metadata contract',async()=>{
 assert.equal(targetIds.length,15);
 for(const id of targetIds){assert(sourceById.has(id),`Missing public source: ${id}`);assert(existsSync(root+`achievement-${id}.html`),`Missing HTML: ${id}`);}
 assert(!villages.some(v=>'currentHead' in v),'villages.json must not carry currentHead');
 for(const c of source)for(const v of c.villages||[])assert(villageKeys.has(c.district+'|'+v),`Unknown village ${c.id}: ${v}`);
 const partnerCases=source.filter(c=>(c.villageHeadPartners||[]).length);
 assert(partnerCases.length>0,'Expected at least one evidence-backed historical village-head partner');
 for(const c of partnerCases)for(const p of c.villageHeadPartners){assert(p.name&&p.village&&p.role&&p.source?.url,`Incomplete partner ${c.id}`);}
 report.metrics.publicAchievements=source.length;report.metrics.partnerCases=partnerCases.length;
});

await check('Sitemap and OG manifest cover all target pages',async()=>{
 for(const id of targetIds){
  const c=sourceById.get(id);const slug='achievement-'+id;
  assert(sitemap.includes(`https://www.huiwen.tw/${slug}.html`),`Missing sitemap URL ${id}`);
  assert(manifest[slug],`Missing OG manifest ${id}`);assert.equal(manifest[slug].title,c.title);assert.equal(manifest[slug].status,c.status);
  const png=await readFile(root+`assets/og/${slug}.png`);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
 }
});

const browser=await chromium.launch({headless:true});
try{
 for(const width of [1440,390]){
  const height=width===390?844:1000;
  const ctx=await browser.newContext({viewport:{width,height}});
  await ctx.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='127.0.0.1')return route.continue();
   return route.fulfill({status:204,body:''});
  });
  const page=await ctx.newPage();page.setDefaultTimeout(8000);
  const browserErrors=[];
  page.on('pageerror',e=>browserErrors.push(`pageerror: ${e}`));
  page.on('console',msg=>{if(msg.type()==='error')browserErrors.push(`console: ${msg.text()}`);});
  page.on('response',res=>{const u=new URL(res.url());if(u.hostname==='127.0.0.1'&&res.status()>=400)browserErrors.push(`HTTP ${res.status()}: ${u.pathname}`);});
  const go=async path=>{await page.goto(base+path,{waitUntil:'domcontentloaded'});};
  const waitCases=async()=>page.waitForFunction(()=>!!window.HuiwenCases);
  const count=async n=>page.waitForFunction(n=>window.HuiwenCases?.getState().visible.length===n,n);

  await go('achievements.html');await waitCases();
  await check(`${width}: overview layout, pagination and map availability`,async()=>{
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.equal(Number(await page.locator('.digital-stat strong').first().textContent()),source.length);
   assert.equal(await page.locator('#case-list .case-card:visible').count(),Math.min(10,source.length));
   assert(await page.locator('#achievement-map').isVisible());
   assert(await page.locator('.leaflet-overlay-pane path').count()>0);
   await page.screenshot({path:out+`step7-overview-${width}.png`,fullPage:true});
  });

  await check(`${width}: keyword, status, category and village filters match source`,async()=>{
   const search='個人行動器具';
   const expectedSearch=source.filter(c=>searchable(c).includes(search)).map(c=>c.id);
   await page.locator('#case-search').fill(search);await count(expectedSearch.length);
   assert.deepEqual(await page.evaluate(()=>window.HuiwenCases.getState().visible.map(c=>c.id)),expectedSearch);
   await page.locator('#reset-map-filters').click();
   const completed=source.filter(c=>c.status==='已完成');await page.locator('#status-filter').selectOption('已完成');await count(completed.length);
   await page.locator('#reset-map-filters').click();
   const traffic=source.filter(c=>(c.categories||[]).includes('交通與基建'));await page.locator('#category-filter').selectOption('交通與基建');await count(traffic.length);
   await page.locator('#reset-map-filters').click();
   const village='大德里';const byVillage=source.filter(c=>(c.villages||[]).includes(village));
   if(byVillage.length){await page.locator('#village-filter').selectOption('v:'+village);await count(byVillage.length);}
   await page.locator('#reset-map-filters').click();
  });

  await check(`${width}: historical partner search and facts do not regress to current-head labels`,async()=>{
   const q='侯俊傑';const expected=source.filter(c=>searchable(c).includes(q)).map(c=>c.id);
   assert(expected.includes('mingfeng-12-gongyuan-road'));
   await page.locator('#case-search').fill(q);await count(expected.length);
   assert.deepEqual(await page.evaluate(()=>window.HuiwenCases.getState().visible.map(c=>c.id)),expected);
   assert(!await page.locator('body').textContent().then(t=>t.includes('現任里長')));
   await page.keyboard.press('Control+k');const input=page.locator('#global-search-dialog input');await input.fill(q);
   await page.locator('.global-search-result[href="achievement-mingfeng-12-gongyuan-road.html"]').waitFor();await page.keyboard.press('Escape');
   await page.locator('#reset-map-filters').click();
  });

  await check(`${width}: map deep link and selected result remain synchronized`,async()=>{
   await go('achievements.html?case=dingbao-bridge');await waitCases();await page.locator('.map-insight-panel').waitFor();
   assert.equal(new URL(page.url()).searchParams.get('case'),'dingbao-bridge');
   assert(await page.locator('.case-card.is-selected').isVisible());
   await page.locator('#category-filter').selectOption('社福與衛環');
   const expected=source.filter(c=>(c.categories||[]).includes('社福與衛環'));await count(expected.length);
   assert.equal(await page.locator('.case-card.is-selected').count(),0);assert.equal(await page.locator('.insight-clear').count(),0);assert(await page.locator('.map-insight-panel').isVisible());assert(!new URL(page.url()).searchParams.has('case'));
  });

  await check(`${width}: all 13 first-public and 2 updated detail pages render, fit and expose correct OG`,async()=>{
   for(const id of targetIds){
    const c=sourceById.get(id);await go(`achievement-${id}.html`);
    assert.equal((await page.locator('h1').first().textContent()).trim(),c.title,`h1 ${id}`);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${id}`);
    assert.equal(await page.locator('.case-facts dt').count(),await page.locator('.case-facts dd').count(),`facts ${id}`);
    assert((await page.locator('.case-facts').textContent()).includes(c.status),`status ${id}`);
    assert(!((await page.locator('body').textContent()).includes('現任里長')),`legacy current-head label ${id}`);
    for(const p of c.villageHeadPartners||[]){const facts=await page.locator('.case-facts').textContent();assert(facts.includes('合作里長（案件當時）'));assert(facts.includes(p.name));assert(facts.includes(p.role));}
    const og=await page.locator('meta[property="og:image"]').getAttribute('content');const tw=await page.locator('meta[name="twitter:image"]').getAttribute('content');
    assert.equal(og,`https://www.huiwen.tw/assets/og/achievement-${id}.png`);assert.equal(tw,og);
    const axe=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v=>v.id),[],`axe ${id}: ${axe.violations.map(v=>v.id).join(',')}`);
    await page.screenshot({path:out+`step7-${id}-${width}.png`,fullPage:true});
   }
  });

  await check(`${width}: overview accessibility`,async()=>{
   await go('achievements.html');await waitCases();
   const axe=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   await writeFile(out+`step7-overview-axe-${width}.json`,JSON.stringify(axe.violations,null,2));
   assert.deepEqual(axe.violations.map(v=>v.id),[]);
  });

  if(width===390)await check('390: mobile navigation opens, closes and restores focus',async()=>{
   await page.locator('.menu-toggle').click();assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'false');assert(await page.locator('.menu-toggle').evaluate(el=>el===document.activeElement));
  });

  await check(`${width}: no browser console/page/local HTTP errors`,async()=>assert.deepEqual(browserErrors,[]));
  await ctx.close();
 }

 await check('No JavaScript keeps all public achievement cards and historical partner facts readable',async()=>{
  const ctx=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const page=await ctx.newPage();await page.goto(base+'achievements.html');
  assert.equal(await page.locator('#case-list .case-card:visible').count(),source.length);
  await page.goto(base+'achievement-mingfeng-12-gongyuan-road.html');const facts=await page.locator('.case-facts').textContent();assert.match(facts,/合作里長（案件當時）/);assert.match(facts,/侯俊傑/);assert(!facts.includes('現任里長'));await ctx.close();
 });
}finally{
 await browser.close();server.kill();await writeFile(out+'achievement-governance-report.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
