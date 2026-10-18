import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNoHorizontalOverflow} from './layout-diagnostics.mjs';
import {openCaseFilterDialog,closeCaseFilterDialog} from './achievement-filter-dialog.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const publicStatuses=new Set(['持續追蹤','爭取規劃','已完成','政策實施']);
const publicIds=JSON.parse(await readFile(new URL('../../data/achievements.json',import.meta.url),'utf8')).filter(row=>publicStatuses.has(row.status)).map(row=>row.id).sort();
const out=fileURLToPath(new URL('./results/reading-design/',import.meta.url));
await mkdir(out,{recursive:true});
const base=process.env.BASE_URL || 'http://127.0.0.1:8769/';
const server=process.env.BASE_URL ? null : spawn('python3',['-m','http.server','8769','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const report={base,checks:[],failures:[],pageErrors:[]};
const browser=await chromium.launch();
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.failures.push({name,error:String(e)});}}
try{
 for(let n=0;n<50;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [320,360,390,430,768,1180,1440]){
  const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(8000);
  page.on('pageerror',e=>report.pageErrors.push(String(e)));
  for(const file of ['index.html','achievements.html','explore.html','achievement-boai-card-rehab-bus-points.html','news.html','vision.html','council-records.html','about.html','service.html','service-print.html','achievement-fengshan-columbarium-capacity.html','achievement-wende-school-center.html','achievement-fengshan-sports-park-parking-integration.html','election.html']){
   await page.goto(base+file);await page.waitForTimeout(120);
   if(['achievement-wende-school-center.html','achievement-fengshan-sports-park-parking-integration.html'].includes(file))await page.locator('.case-background > summary').click();
   await check(width+' '+file+' reflow',async()=>{await assertNoHorizontalOverflow(page,{directory:out+'/diagnostics/',label:width+' '+file+' reflow'});assert.equal(await page.locator('h1').count(),1);});
   if([390,1180].includes(width))await check(width+' '+file+' automated accessibility',async()=>{const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);});
   await page.screenshot({path:out+'/'+file.replace('.html','')+'-'+width+'.png',fullPage:file==='achievement-wende-school-center.html'});
  }
  if(width===320){
   for(const file of ['index.html','achievements.html','explore.html','achievement-boai-card-rehab-bus-points.html','news.html','vision.html','service-print.html','achievement-fengshan-columbarium-capacity.html','achievement-wende-school-center.html','achievement-fengshan-sports-park-parking-integration.html']){
    await page.goto(base+file);if(['achievement-wende-school-center.html','achievement-fengshan-sports-park-parking-integration.html'].includes(file))await page.locator('.case-background > summary').click();await page.addStyleTag({content:'html{font-size:200%!important}'});
    await check('200% text '+file,async()=>assertNoHorizontalOverflow(page,{directory:out+'/diagnostics/',label:'200% text '+file}));
    await page.screenshot({path:out+'/'+file.replace('.html','')+'-text-200.png'});
   }
  }
  if(width===390){
   await check('Verified public contact and dated booking guidance',async()=>{
    await page.goto(base+'service.html#contact');assert.match(await page.locator('#contact').innerText(),/07-815-1104/);
    assert.match(await page.locator('.schedule-guidance').innerText(),/時間表只列該月已公布的時段，不適用於其他月份/);
    await page.goto(base+'service-print.html');assert.match(await page.locator('main').innerText(),/勿依過期月表直接前往/);
   });
   await check('Correct public facility address stays separate from service scope',async()=>{
    await page.goto(base+'achievement-fengshan-columbarium-capacity.html');
    assert.match(await page.locator('.case-facts').innerText(),/大寮區內坑里六和路78-12號/);
    assert.match(await page.locator('.case-facts').innerText(),/07-792-0200/);
   });
   await check('Home village form routes to filtered public results',async()=>{
    await page.goto(base);
    const village=page.locator('.home-village-form #home-village');
    await village.selectOption('v:文德里');
    await Promise.all([
     page.waitForURL(url=>url.pathname.endsWith('/achievements.html')&&url.searchParams.get('village')==='v:文德里'&&url.hash==='#case-results'),
     page.locator('.home-village-submit').click(),
    ]);
    await page.waitForFunction(()=>window.HuiwenCases?.getState().filters.village==='v:文德里'&&window.HuiwenCases.getState().visible.length>0);
    const trigger=page.locator('#case-filter-open');
    const dialog=page.locator('#case-filter-dialog');
    assert.equal(await trigger.count(),1,'the mobile filter trigger must be unique');
    assert.equal(await dialog.count(),1,'the achievement filter dialog must be unique');
    await trigger.waitFor({state:'visible'});
    assert.equal(await dialog.evaluate(element=>element.open),false,'the mobile filter dialog starts closed');
    await trigger.click();
    await dialog.waitFor({state:'visible'});
    assert.equal(await dialog.evaluate(element=>element.open),true,'the actual mobile trigger opens the filter dialog');
    assert.equal(await trigger.getAttribute('aria-expanded'),'true');
    const filterVillage=dialog.locator('#village-filter');
    await filterVillage.waitFor({state:'visible'});
    await page.waitForFunction(()=>window.HuiwenCases?.getState().filters.village==='v:文德里'&&window.HuiwenCases.getState().visible.length>0);
    assert.equal(await filterVillage.inputValue(),'v:文德里');
    assert.equal(new URL(page.url()).searchParams.get('village'),'v:文德里');
    const firstResult=await page.evaluate(()=>window.HuiwenCases.getState().visible.map(row=>row.villages));
    assert(firstResult.length>0);
    assert(firstResult.every(villages=>villages.includes('文德里')),JSON.stringify(firstResult));
    await page.getByRole('button',{name:'移除篩選：文德里',exact:true}).waitFor({state:'visible'});
    await filterVillage.selectOption('v:曹公里');
    await page.waitForFunction(()=>window.HuiwenCases?.getState().filters.village==='v:曹公里'&&window.HuiwenCases.getState().visible.length>0&&new URL(location.href).searchParams.get('village')==='v:曹公里');
    const result=await page.evaluate(()=>window.HuiwenCases.getState().visible.map(row=>row.villages));
    assert(result.length>0);
    assert(result.every(villages=>villages.includes('曹公里')),JSON.stringify(result));
    await page.getByRole('button',{name:'移除篩選：曹公里',exact:true}).waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(()=>{
     const dialog=document.querySelector('#case-filter-dialog');
     const trigger=document.querySelector('#case-filter-open');
     return Boolean(dialog&&!dialog.open&&trigger&&trigger.getAttribute('aria-expanded')==='false'&&document.activeElement===trigger);
    },null,{timeout:8000});
    assert.equal(await dialog.evaluate(element=>element.open),false,'Escape closes the filter dialog');
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,'closing the filter dialog restores focus to its opener');
   });
   await check('Global search, Escape and focus restoration',async()=>{
    await page.goto(base);
    const menuToggle=page.locator('.menu-toggle');await menuToggle.waitFor({state:'visible'});
    const menuLabel=await menuToggle.evaluate(button=>{const node=Array.from(button.childNodes).find(child=>child.nodeType===3&&child.textContent.includes('選單'));if(!node)return{text:null,rects:[]};const range=document.createRange();range.selectNodeContents(node);return{text:node.textContent.trim(),rects:Array.from(range.getClientRects(),rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}))};});
    assert.equal(menuLabel.text,'選單');assert.equal(menuLabel.rects.length,1,JSON.stringify(menuLabel));
    await menuToggle.click();
    const trigger=page.locator('#navigation .global-search-trigger');
    await trigger.click();
    const dialog=page.locator('#global-search-dialog');
    await dialog.waitFor({state:'visible'});
    await dialog.locator('input[type="search"]').fill('文德國小');
    await page.locator('.global-search-result').first().waitFor();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert(await page.evaluate(()=>document.activeElement?.tagName!=='BODY'));
   });
   await check('Filters keep records without map points and chips are keyboard removable',async()=>{
    await page.goto(base+'achievements.html?category='+encodeURIComponent('社福與衛環'));
    await page.waitForFunction(()=>!!window.HuiwenCases);
    assert(await page.locator('[data-case="boai-card-rehab-bus-points"]').count());
    const chip=page.getByRole('button',{name:'移除篩選：社福與衛環'});
    await chip.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#category-filter').inputValue(),'all');
    if(await page.locator('#case-filter-open').isVisible())assert(await page.locator('#case-filter-open').evaluate(el=>el===document.activeElement));
    else assert(await page.locator('#category-filter').evaluate(el=>el===document.activeElement));
    await openCaseFilterDialog(page);
    await page.locator('#village-filter').selectOption('v:文德里');
    const expected=await page.evaluate(()=>window.HuiwenCases.getState().visible.length);assert.equal(expected,2);
    await closeCaseFilterDialog(page);
    await page.getByRole('button',{name:'地圖與列表',exact:true}).click();assert(await page.locator('.map-panel').isVisible());
    await page.getByRole('button',{name:'只看列表',exact:true}).click();assert(await page.locator('.map-panel').isHidden());
    assert.equal(await page.locator('#village-filter').inputValue(),'v:文德里');
   });
   await check('Legacy and shared exploration URLs preserve filters',async()=>{
    await page.goto(base+'explore.html?village='+encodeURIComponent('v:文德里'));await page.locator('.explore-result-card').first().waitFor();
    assert.equal(await page.locator('#explore-type').inputValue(),'village');
    assert.equal(await page.locator('#explore-value').inputValue(),'文德里');
    const count=await page.locator('.explore-result-card').count();assert.equal(count,2);
    const href=await page.locator('#explore-list-link').getAttribute('href');assert(href.includes('village='));
    await page.locator('#explore-list-link').click();await page.waitForFunction(()=>!!window.HuiwenCases);
    assert.equal(await page.evaluate(()=>window.HuiwenCases.getState().visible.length),count);
   });
   await check('News disclosure reads full width and keeps the source links',async()=>{
    await page.goto(base+'news.html');const card=page.locator('.news-report-card').first();
    const links=await card.locator('a[href]').evaluateAll(els=>els.map(a=>a.href));
    const summary=card.locator('.news-card-details summary');await summary.focus();await page.keyboard.press('Enter');
    assert.deepEqual(await card.locator('a[href]').evaluateAll(els=>els.map(a=>a.href)),links);
    const next=page.locator('.news-report-card').nth(1);const a=await card.boundingBox(),b=await next.boundingBox();assert(b.y>=a.y+a.height-1);
    await page.screenshot({path:out+'/news-expanded-390.png'});await page.keyboard.press('Enter');assert(await summary.evaluate(el=>el===document.activeElement));
   });
  }
  await context.close();
 }
 const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:320,height:960}});
 const page=await nojs.newPage();
 await check('No-JS keeps the full record list and existing links',async()=>{await page.goto(base+'achievements.html');const ids=await page.locator('[data-case]').evaluateAll(nodes=>nodes.map(node=>node.dataset.case).sort());assert.deepEqual(ids,publicIds);assert(await page.locator('[data-case="boai-card-rehab-bus-points"] a').first().isVisible());});
 await nojs.close();
 assert.deepEqual(report.pageErrors,[]);
}finally{
 await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();server?.kill();
}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
