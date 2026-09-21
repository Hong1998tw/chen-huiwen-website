import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const round=process.env.ROUND||'r2';
const out='artifacts/astra-redesign';await mkdir(out+'/screenshots',{recursive:true});
const browser=await chromium.launch();const context=await browser.newContext();
await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
const page=await context.newPage();const report={checks:[],failures:[],pageErrors:[]};
page.on('pageerror',e=>report.pageErrors.push(String(e)));
async function check(name,fn){try{await fn();report.checks.push({name,status:'PASS'});}catch(e){report.failures.push({name,error:String(e)});}}
const base='http://127.0.0.1:8766/';
for(const width of [1440,390]){
 await page.setViewportSize({width,height:width===390?844:960});
 for(const route of ['index.html','about.html','achievements.html','achievement-metro-green-line.html','service.html','news.html','press.html','activities.html','gallery.html','vision.html','petition.html','political-donation.html','explore.html','404.html']){
  await page.goto(base+route);await page.waitForTimeout(150);
  await check(`${route} ${width} geometry`,async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
  await check(`${route} ${width} axe`,async()=>{const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);});
  await page.screenshot({path:`${out}/screenshots/${round}-${route.replace('.html','')}-${width}.png`,fullPage:false});
 }
}
await check('Home search routes to published detail and Escape returns focus',async()=>{
 await page.goto(base);await page.locator('#civic-query').fill('文德國小');await page.locator('.civic-search button').click();await page.locator('#global-search-dialog').waitFor();await page.locator('.global-search-result').first().waitFor();assert((await page.locator('.global-search-results').innerText()).includes('文德國小'));await page.keyboard.press('Escape');assert.equal(await page.locator('#global-search-dialog').isVisible(),false);
});
await check('List/map switch preserves filters and locate restores map',async()=>{
 await page.goto(base+'achievements.html?q=文德');await page.getByRole('button',{name:'只看列表',exact:true}).click();assert(await page.locator('.map-panel').isHidden());assert.equal(await page.locator('#case-search').inputValue(),'文德');await page.locator('[data-locate]').filter({visible:true}).first().click();assert(await page.locator('.map-panel').isVisible());
});
await check('Detail source and history anchors resolve',async()=>{
 await page.goto(base+'achievement-metro-green-line.html');for(const a of await page.locator('.civic-article-nav a').all()){const href=await a.getAttribute('href');assert.equal(await page.locator(href).count(),1);}
});
await check('Nested 404 keeps styled same-origin recovery, skip and search',async()=>{
 await page.route('**/missing/deep/path',async route=>route.fulfill({status:404,contentType:'text/html',body:await readFile('404.html','utf8')}));
 await page.goto(base+'missing/deep/path');
 assert.equal(await page.locator('.skip-link').getAttribute('href'),'#main');
 assert.equal(await page.locator('main a').getAttribute('href'),'/');
 assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(247, 246, 239)');
 await page.keyboard.press('Meta+k');await page.locator('#global-search-dialog input').fill('文德國小');await page.locator('.global-search-result').first().waitFor();
 assert((await page.locator('.global-search-result').first().getAttribute('href')).startsWith(base+'achievement-'));
});
await check('200% text does not overflow new home',async()=>{await page.goto(base);await page.addStyleTag({content:'html{font-size:200%!important}'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
assert.deepEqual(report.pageErrors,[]);
await writeFile(out+'/qa-'+round+'.json',JSON.stringify(report,null,2));await browser.close();
console.log(JSON.stringify({checks:report.checks.length,failures:report.failures},null,2));if(report.failures.length)process.exitCode=1;
