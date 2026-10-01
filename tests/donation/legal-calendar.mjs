import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=root+'tests/donation/results/legal-calendar/';
await mkdir(out,{recursive:true});
const data=JSON.parse(await readFile(root+'data/legal-schedule.json','utf8'));
const server=spawn('python3',['-m','http.server','8795','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const base='http://127.0.0.1:8795/';
for(let n=0;n<50;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const report={checks:[],failures:[],sessions:data.sessions.length,month:data.month};
const check=async(name,fn)=>{try{await fn();report.checks.push({name,status:'Passed'});}catch(e){report.failures.push(name);report.checks.push({name,status:'Failed',error:String(e)});}};
const browser=await chromium.launch({headless:true});
try{
 for(const width of [320,390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});
  await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.fulfill({status:204,body:''}));
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base);
  await check(width+' homepage consultation shortcut',async()=>{
   const shortcut=page.locator('.hero-actions').getByRole('link',{name:'律師諮詢時間 →',exact:true});
   assert(await shortcut.isVisible());
   const size=await shortcut.boundingBox();assert(size.width>=44&&size.height>=44);
   await shortcut.focus();await page.keyboard.press('Enter');
   assert.equal(new URL(page.url()).hash,'#monthly-heading');
   await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
  });
  await page.goto(base+'service.html#monthly-heading');
  await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
  await check(width+' published read-only calendar and list',async()=>{
   assert.equal(await page.locator('[data-legal-calendar] .has-session').count(),data.sessions.length);
   assert.equal(await page.locator('#month-picker,#editor,.lawyer-month-editor').count(),0);
   await page.getByRole('button',{name:'列表',exact:true}).click();
   assert.equal(await page.locator('.schedule-text tbody tr').count(),data.sessions.length);
   for(const s of data.sessions)assert.match(await page.locator('[data-session-date="'+s.date+'"]').textContent(),new RegExp(s.lawyer));
   await page.getByRole('button',{name:'月曆',exact:true}).click();
   const axe=await new AxeBuilder({page}).include('.schedule-embed').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(v=>v.id),[]);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:out+'calendar-'+width+'.png',fullPage:true});
  });
  await check(width+' rendered downloadable monthly PNG',async()=>{
   await page.getByRole('button',{name:'圖卡',exact:true}).click();
   await page.locator('.legal-card-preview canvas').waitFor();
   assert.equal(await page.locator('.legal-card-preview canvas').getAttribute('width'),'1920');
   assert.equal(await page.locator('.legal-card-preview canvas').getAttribute('height'),'1080');
   const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'下載本月圖卡 PNG',exact:true}).click()]);
   const file=await download.path(),png=await readFile(file);assert.equal(png.readUInt32BE(16),1920);assert.equal(png.readUInt32BE(20),1080);
   assert(download.suggestedFilename().startsWith(data.month));assert(png.length>100000);
   if(width===1440)await writeFile(out+data.month+'-verified-card.png',png);
   await page.getByRole('button',{name:'列表',exact:true}).click();await page.getByRole('button',{name:'月曆',exact:true}).click();
   assert(await page.locator('.legal-month-grid').isVisible());assert.deepEqual(errors,[]);
  });
  await ctx.close();
 }
 const ctx=await browser.newContext({viewport:{width:1440,height:900}}),page=await ctx.newPage();
 await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.fulfill({status:204,body:''}));
 await page.goto(base+'service.html');
 await check('leap-year and year-boundary cards use requested month, without inferred sessions',async()=>{
  const cases=[{month:'2028-02',sessions:[{date:'2028-02-29',start:'16:30',end:'18:00',lawyer:'陳順得'}]},{month:'2027-01',sessions:[]}];
  for(const item of cases){
   const result=await page.evaluate(async data=>{const c=await window.HuiwenLegalCard.makeCard(data);return {width:c.width,height:c.height,label:c.getAttribute('aria-label')};},item);
   assert.equal(result.width,1920);assert.equal(result.height,1080);assert(result.label.includes(item.month.slice(0,4)));
  }
 });
 await ctx.close();
}finally{await browser.close();server.kill();await writeFile(out+'report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.failures.length)process.exitCode=1;
