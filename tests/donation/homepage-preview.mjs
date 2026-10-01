import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),fixture=root+'tests/fixtures/homepage-preview/',out=root+'tests/donation/results/homepage-preview/';
await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8797','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'}),base='http://127.0.0.1:8797/';
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const browser=await chromium.launch({headless:true}),report={scope:'Review-only homepage prototype',checks:[],failures:[]};
try{
 for(const width of [320,390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:960}});
  await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.fulfill({status:204,body:''}));
  const page=await context.newPage();
  await page.goto(base+'tests/fixtures/homepage-preview/index.html');
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('.station img').scrollIntoViewIfNeeded();
  await page.locator('.station img').evaluate(i=>i.decode());
  await page.evaluate(()=>window.scrollTo(0,0));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' overflow');
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  await page.screenshot({path:out+'review-debug-'+width+'.png',fullPage:true});
  assert.deepEqual(axe.violations.map(v=>v.id),[],JSON.stringify(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))));
  await page.screenshot({path:out+'preview-'+width+'-full.png',fullPage:true});
  await page.screenshot({path:out+'preview-'+width+'-top.png'});
  if(width===390||width===1440)for(const [name,selector] of [['services','.services'],['project','.feature'],['map','#map'],['news','#news'],['contact','#contact']])await page.locator(selector).screenshot({path:out+'preview-'+width+'-'+name+'.png'});
  await page.getByRole('button',{name:'教育與文化',exact:true}).click();
  assert.equal(await page.locator('.place:visible').count(),1);assert.match(await page.locator('.place:visible').innerText(),/6,035.7/);
  await page.getByRole('button',{name:'交通與基建',exact:true}).click();assert.equal(await page.locator('.place:visible').count(),2);
  if(width<=620){
   await page.getByRole('button',{name:'選單',exact:true}).click();assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'false');
   await page.getByRole('button',{name:'選單',exact:true}).click();await page.locator('#nav').getByRole('link',{name:'服務處',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'false');
  }
  report.checks.push({width,overflow:false,axeViolations:0,topicFilters:'Passed',mobileNavigation:width<=620?'Passed':'Not applicable'});
  await context.close();
 }
 let html=await readFile(fixture+'index.html','utf8');
 for(const [name,mime] of [['chen-huiwen.png','image/png'],['fengshan-station.jpg','image/jpeg'],['preview-sans.woff','font/woff'],['preview-serif.woff','font/woff']])html=html.replaceAll('assets/'+name,'data:'+mime+';base64,'+(await readFile(fixture+'assets/'+name)).toString('base64'));
 const license=await readFile(fixture+'assets/OFL.txt','utf8');
 html=html.replace('</body>','<script type="application/json" id="font-license">'+JSON.stringify({license}).replaceAll('<','\\u003c')+'</script></body>');
 await writeFile(out+'homepage-preview.html',html);
 await copyFile(fixture+'assets/chen-huiwen.png',out+'source-portrait.png');
 await copyFile(fixture+'assets/fengshan-station.jpg',out+'source-station.jpg');
} catch(error){report.failures.push(String(error));throw error;}finally{await browser.close();server.kill();await writeFile(out+'report.json',JSON.stringify(report,null,2));}
