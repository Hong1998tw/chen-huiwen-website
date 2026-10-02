import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=process.env.BASE_URL||'http://127.0.0.1:8788/';
const server=process.env.BASE_URL?null:spawn('python3',['-m','http.server','8788','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const out=new URL('./results/small-q/',import.meta.url);
await mkdir(out,{recursive:true});
const report={checks:[],failures:[],pageErrors:[]};
const browser=await chromium.launch();
async function check(name,fn){try{await fn();report.checks.push(name);}catch(e){report.failures.push({name,error:String(e)});}}
const state=(page,key)=>page.waitForFunction(k=>document.querySelector('#small-q')?.dataset.action===k,key,{timeout:8000});
try{
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
for(const width of [320,390,768,1440]){
 const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'no-preference'});
 const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(String(e)));
 await page.goto(base);await page.locator('#small-q').waitFor({state:'visible'});await page.locator('#small-q').scrollIntoViewIfNeeded();
 await check(width+' automatic welcome then static idle',async()=>{await state(page,'wave');await state(page,'idle');assert.equal(await page.locator('#small-q img').evaluate(e=>getComputedStyle(e).animationName),'none');});
 await check(width+' no visitor settings or pose selector',async()=>{assert.equal(await page.locator('#small-q button').count(),1);assert.equal(await page.locator('#small-q-panel,[data-q-action]').count(),0);assert(await page.getByRole('button',{name:'收起小 Q',exact:true}).isVisible());});
 await check(width+' horizontal fit and in-flow mobile',async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const q=await page.locator('#small-q').boundingBox();assert(q.x>=0&&q.x+q.width<=width);if(width<=780){const s=await page.locator('.home-redesign .services').boundingBox();assert(q.y+q.height<=s.y);assert.equal(await page.locator('#small-q').evaluate(e=>getComputedStyle(e).position),'relative');}});
 await page.screenshot({path:fileURLToPath(new URL(width+'-automatic.png',out))});
 await check(width+' dismissal has no settings restore toolbar',async()=>{await page.getByRole('button',{name:'收起小 Q',exact:true}).click();assert(await page.locator('#small-q').isHidden());assert.equal(await page.getByRole('button',{name:'顯示小 Q',exact:true}).count(),0);});
 await context.close();
}
await check('desktop context gestures are finite and tied to real page sections',async()=>{
 const c=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'no-preference'}),p=await c.newPage();await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});await state(p,'wave');await state(p,'idle');
 await p.waitForTimeout(12200);await p.locator('#projects').scrollIntoViewIfNeeded();await state(p,'guide');await state(p,'idle');
 await p.waitForTimeout(12200);await p.locator('.filters button[data-filter=education]').click();await state(p,'nod');await state(p,'idle');
 await p.waitForTimeout(12200);await p.locator('#contact').scrollIntoViewIfNeeded();await state(p,'happy');await state(p,'idle');await c.close();
});
await check('reduced motion remains static without settings',async()=>{const c=await browser.newContext({reducedMotion:'reduce'}),p=await c.newPage();await p.goto(base);await p.locator('#small-q').waitFor({state:'visible'});assert.equal(await p.locator('#small-q').getAttribute('data-action'),'idle');assert.equal(await p.locator('#small-q img').evaluate(e=>getComputedStyle(e).animationName),'none');await p.locator('#projects').scrollIntoViewIfNeeded();assert.equal(await p.locator('#small-q').getAttribute('data-action'),'idle');await c.close();});
await check('without JavaScript primary content remains available',async()=>{const c=await browser.newContext({javaScriptEnabled:false}),p=await c.newPage();await p.goto(base);assert(await p.locator('h1').isVisible());assert(await p.locator('#small-q').isHidden());await c.close();});
await check('image failure does not expose empty companion or break content',async()=>{const c=await browser.newContext(),p=await c.newPage();await p.route('**/assets/small-q/*',r=>r.abort());await p.goto(base);await p.waitForTimeout(1800);assert(await p.locator('#small-q').isHidden());assert(await p.locator('h1').isVisible());await c.close();});
await check('non-home pages exclude companion',async()=>{const p=await browser.newPage();await p.goto(new URL('about.html',base).href);assert.equal(await p.locator('#small-q').count(),0);assert.equal(await p.locator('script[src*="small-q"]').count(),0);await p.close();});
}finally{await browser.close();server?.kill();await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));if(report.failures.length||report.pageErrors.length)process.exitCode=1;
