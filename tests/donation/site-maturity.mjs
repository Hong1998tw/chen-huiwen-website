/** Regression of content-first reading, exact critical history and shared source boundaries. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=new URL('./results/site-maturity/',import.meta.url);await mkdir(out,{recursive:true});
const base=process.env.BASE_URL||'http://127.0.0.1:8773/';
const server=process.env.BASE_URL?null:spawn('python3',['-m','http.server','8773','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const engine=process.env.QA_ENGINE||'chromium';const browser=await ({chromium,webkit}[engine]).launch();
const results=[];const failures=[];
async function check(name,fn){try{const detail=await fn();results.push({name,status:'PASS',detail});}catch(e){failures.push({name,error:String(e)});}}
try{
 for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);
  for(const path of ['','achievements.html','achievement-wende-school-center.html','election.html','about.html','vision.html']){
   await page.goto(base+path);await page.locator('html.menu-ready').waitFor();
   await check(`${engine} ${width} ${path||'home'} accessible readable layout`,async()=>{
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(x=>x.id),[]);
   });
   if(path==='achievements.html')await check(`${engine} ${width} first meaningful record in first viewport`,async()=>{
    await page.waitForFunction(()=>!!window.HuiwenCases);
    const card=page.locator('#case-list article:visible').first();const title=await card.locator('h3').boundingBox();
    assert(title.y+title.height<844,`first record title ends at ${title.y+title.height}`);
    return{firstTitleTop:title.y,firstTitleBottom:title.y+title.height};
   });
   if(path==='achievement-wende-school-center.html')await check(`${engine} single event only once with optional background`,async()=>{
    assert.equal(await page.locator('.case-timeline li').count(),0);
    assert.match(await page.locator('.case-latest').innerText(),/2027/);
    const summary=page.locator('.case-background > summary');assert(await summary.isVisible());
    await summary.click();assert.match(await page.locator('.case-background').innerText(),/文山段土地撥用/);await summary.click();
   });
   if(path==='election.html')await check(`${engine} complete election search beyond first eight`,async()=>{
    await page.locator('#campaign-search').fill('文德');
    await page.locator('#campaign-tracking h3 a[href="achievement-wende-school-center.html"]').waitFor({state:'visible'});
    assert.match(await page.locator('#campaign-search-count').innerText(),/找到 [1-9][0-9]* 個符合項目/);
   });
   await page.screenshot({path:fileURLToPath(new URL(`${engine}-${width}-${(path||'home').replace('.html','')}.png`,out)),fullPage:false});
  }
  await page.goto(base+'achievement-dade-park-road-opening.html');
  await check(`${engine} unique single-event measurement retained`,async()=>assert.match(await page.locator('main').innerText(),/127公尺/));
  await context.close();
 }
 // Explicit build chrome cannot mutate the excluded form's main bytes.
 await check('Excluded petition main remains byte identical to reviewed baseline',async()=>{
  const baseline=execFileSync('git',['show','49660bf529c3d41008217125464594571b83d202:petition.html'],{cwd:root,encoding:'utf8'});
  const current=await (await fetch(base+'petition.html')).text();
  assert.equal(current.match(/<main\b[\s\S]*?<\/main>/)[0],baseline.match(/<main\b[\s\S]*?<\/main>/)[0]);
 });
}finally{await browser.close();server?.kill('SIGTERM');}
const report={engine,status:failures.length?'FAIL':'PASS',results,failures};await writeFile(new URL(engine+'-report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
