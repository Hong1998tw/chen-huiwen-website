/** Public guides, date semantics and single-page print handouts. No submissions. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=new URL('./results/service-tools/',import.meta.url);await mkdir(out,{recursive:true});
const base=process.env.BASE_URL||'http://127.0.0.1:8777/';
const server=process.env.BASE_URL?null:spawn('python3',['-m','http.server','8777','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const engine=process.env.QA_ENGINE||'chromium';
const browser=await ({chromium,webkit}[engine]).launch();
const report={engine,scope:'Local browser regression; external resources blocked, not a native edge or human study',checks:[],failures:[]};
async function check(name,fn){try{report.checks.push({name,status:'PASS',detail:await fn()});}catch(error){report.failures.push({name,reason:String(error.message).split(/\r?\nCall log:/,1)[0]});}}
try{
 for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);
  for(const path of ['index.html','service-guides.html','service-print.html','updates.html','achievement-metro-green-line.html','achievement-after-school-care.html','achievement-bade-detention.html']){
   await page.goto(base+path);await page.locator('html.menu-ready').waitFor();
   await check(`${width} ${path} accessible responsive layout`,async()=>{
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
   });
   if(path==='index.html')await check(`${width} home hours occur once and update log stays off homepage`,async()=>{
    const text=await page.locator('main').innerText();assert.equal((text.match(/週一至週五/g)||[]).length,1);
    assert.equal(await page.locator('.home-contact').count(),0);assert.equal(await page.locator('.civic-latest-updates,.home-update-entries').count(),0);
    assert(await page.locator('a[href="updates.html"]').count()>=1);
    assert(await page.locator('.hero-portrait').isVisible());
   });
   if(path==='service-guides.html'){
    await check(`${width} legal guide anchor clears sticky navigation`,async()=>{
     await page.locator('.guide-index a[href="#legal-consultation"]').click();
     const top=await page.locator('#legal-consultation').boundingBox(),header=await page.locator('.site-header').boundingBox();
     assert(top.y>=header.y+header.height-1,`anchor ${top.y}, header bottom ${header.y+header.height}`);
     assert.equal(await page.locator('main form,main input,main textarea').count(),0);
    });
    await check(`${width} print button invokes browser print`,async()=>{
     await page.evaluate(()=>{window.print=()=>{document.body.dataset.printCalled='yes';};});
     await page.locator('.print-page').click();assert.equal(await page.locator('body').getAttribute('data-print-called'),'yes');
    });
   }
   if(path==='service-print.html')await check(`${width} handout matches source schedule and latest URL`,async()=>{
    const schedule=JSON.parse(await readFile(new URL('../../data/legal-schedule.json',import.meta.url),'utf8'));
    assert.equal(await page.locator('main tbody tr').count(),schedule.sessions.length);
    assert.equal(await page.locator('.latest-url').getAttribute('href'),'https://www.huiwen.tw/service.html');
    assert.match(await page.locator('main').innerText(),/並非即時名額/);
   });
   if(path==='updates.html')await check(`${width} website additions never masquerade as new events`,async()=>{
    assert.equal(await page.locator('.content-update').count(),2);
    assert.equal(await page.locator('a[href="updates.xml"]').count(),1);
    assert.equal(await page.locator('.update-dates dd').filter({hasText:'不適用（本次為網站內容補充）'}).count(),2);
    for(const href of await page.locator('.content-update nav a').evaluateAll(links=>links.map(a=>a.getAttribute('href')))){
     const target=new URL(href,base);const response=await context.request.get(target.href);assert(response.ok());
     if(target.hash)assert((await response.text()).includes(`id="${target.hash.slice(1)}"`));
    }
   });
   if(path.startsWith('achievement-'))await check(`${width} ${path} open questions and dated print summary`,async()=>{
    assert(await page.locator('#case-context').isVisible());await page.locator('.case-context-next summary').click();
    assert.match(await page.locator('.case-context-next').innerText(),/後續可核對的資料/);
    assert.match(await page.locator('.case-print-sheet').textContent(),/紀錄整理日期/);
   });
   await page.screenshot({path:fileURLToPath(new URL(`${engine}-${width}-${path.replace('.html','')}.png`,out)),fullPage:false});
   if(engine==='chromium'&&width===1440&&(path==='service-print.html'||path.startsWith('achievement-'))){
    await check(`${path} A4 handout fits one page`,async()=>{
     const pdf=await page.pdf({format:'A4',preferCSSPageSize:true,printBackground:false,path:fileURLToPath(new URL(path.replace('.html','.pdf'),out))});
     const count=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;assert.equal(count,1);return{pages:count};
    });
   }
  }
  await context.close();
 }
 await check('No JavaScript keeps guides and updates readable, hides print buttons',async()=>{
  const context=await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
  for(const path of ['service-guides.html','service-print.html','updates.html']){
   await page.goto(base+path);assert((await page.locator('main').innerText()).length>200);
   assert.equal(await page.locator('.print-page:visible').count(),0);
  }await context.close();
 });
 await check('Excluded petition main unchanged',async()=>{
  const baseline=execFileSync('git',['show','5322aeb5c5423b6b2566082c4a59e6f46bffda01:petition.html'],{cwd:root,encoding:'utf8'});
  const current=await readFile(new URL('../../petition.html',import.meta.url),'utf8');
  assert.equal(current.match(/<main\b[\s\S]*?<\/main>/)[0],baseline.match(/<main\b[\s\S]*?<\/main>/)[0]);
 });
}finally{await browser.close();server?.kill('SIGTERM');}
report.status=report.failures.length?'FAIL':'PASS';await writeFile(new URL(engine+'-report.json',out),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
