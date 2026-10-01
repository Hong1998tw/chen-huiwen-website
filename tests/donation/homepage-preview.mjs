import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),fixture=root+'tests/fixtures/homepage-preview/',out=root+'tests/donation/results/homepage-preview/';
await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8797','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'}),base='http://127.0.0.1:8797/';
for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const browser=await chromium.launch({headless:true}),report={scope:'Review-only homepage prototype revision 2',checks:[],failures:[]};
try{
 for(const width of [320,390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:960}});
  await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.fulfill({status:204,body:''}));
  const page=await context.newPage();
  await page.goto(base+'tests/fixtures/homepage-preview/index.html');
  await page.evaluate(()=>document.fonts.ready);
  for(const image of await page.locator('img').all()){await image.scrollIntoViewIfNeeded();await image.evaluate(i=>i.decode());}
  assert.equal(await page.locator('a[href="https://www.huiwen.tw/service.html#monthly-heading"]').count(),1);
  assert.equal(await page.locator('.hero-actions .primary').getAttribute('href'),'https://line.me/R/ti/p/@yve2766q');
  assert.equal(await page.locator('.hero-actions .primary').innerText(),'LINE官方帳號');
  assert.equal(await page.getByText('八德',{exact:false}).count(),0);
  assert.equal(await page.locator('.story-list article').count(),4);
  const eventSource=JSON.parse(await page.locator('#preview-event-source').textContent());
  const savedSource=JSON.parse(await readFile(fixture+'events-preview.json','utf8'));
  assert.deepEqual(eventSource,savedSource);
  assert.equal(eventSource.events[0].start,'2026-10-31T15:50:00+08:00');
  assert.equal(new Date(eventSource.events[0].start).getUTCDay(),6);
  assert.equal(eventSource.events[0].end,null);
  assert.equal(await page.locator('#opening time').getAttribute('datetime'),eventSource.events[0].start);
  assert.equal(await page.locator('.event-location').innerText(),eventSource.events[0].location);
  assert.equal(await page.locator('.portrait img').getAttribute('src'),'assets/huiwen-mikan.webp');
  for(const href of await page.locator('a').evaluateAll(links=>links.map(a=>a.getAttribute('href')))){
   if(href.startsWith('#'))assert.equal(await page.locator(href).count(),1,'internal anchor '+href);
   else if(href.startsWith('https://www.huiwen.tw/')){const u=new URL(href);await access(root+(u.pathname==='/'?'index.html':u.pathname.slice(1)));}
   else if(href.startsWith('assets/'))await access(fixture+href);
   else assert.match(href,/^(tel:\+88678212536|https:\/\/line\.me\/R\/ti\/p\/@yve2766q)$/);
  }
  await page.evaluate(()=>window.scrollTo(0,0));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' overflow');
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  await page.screenshot({path:out+'review-debug-'+width+'.png',fullPage:true});
  assert.deepEqual(axe.violations.map(v=>v.id),[],JSON.stringify(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))));
  await page.screenshot({path:out+'preview-'+width+'-full.png',fullPage:true});
  await page.screenshot({path:out+'preview-'+width+'-top.png'});
  if(width===390||width===1440)for(const [name,selector] of [['services','.services'],['project','.feature'],['stories','.stories'],['map','#map'],['opening','#opening'],['news','#news'],['contact','#contact']])await page.locator(selector).screenshot({path:out+'preview-'+width+'-'+name+'.png'});
  await page.getByRole('button',{name:'教育與文化',exact:true}).click();
  assert.equal(await page.locator('.place:visible').count(),1);assert.match(await page.locator('.place:visible').innerText(),/6,035.7/);
  await page.getByRole('button',{name:'交通與基建',exact:true}).click();assert.equal(await page.locator('.place:visible').count(),4);
  if(width<=620){
   await page.getByRole('button',{name:'選單',exact:true}).click();assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'false');
   await page.getByRole('button',{name:'選單',exact:true}).click();await page.locator('#nav').getByRole('link',{name:'服務處',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'選單',exact:true}).getAttribute('aria-expanded'),'false');
  }
  for(const [label,file] of [['下載直式圖卡','campaign-opening-portrait.png'],['下載橫式圖卡','campaign-opening-landscape.jpg']]){
   const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:label,exact:true}).click();const download=await downloadPromise;
   const path=out+width+'-'+file;await download.saveAs(path);
   assert.deepEqual(await readFile(path),await readFile(fixture+'assets/'+file));
  }
  report.checks.push({width,overflow:false,axeViolations:0,topicFilters:'Passed',singleLawyerEntry:'Passed',officialLineLink:'Passed',localAndOfficialRoutes:'Passed',eventFacts:'Passed',exactCardDownloads:2,mobileNavigation:width<=620?'Passed':'Not applicable'});
  await context.close();
 }
 let html=await readFile(fixture+'index.html','utf8');
 for(const [name,mime] of [['huiwen-mikan.webp','image/webp'],['campaign-opening-portrait.png','image/png'],['campaign-opening-landscape.jpg','image/jpeg'],['fengshan-station.jpg','image/jpeg'],['preview-sans.woff','font/woff'],['preview-serif.woff','font/woff']])html=html.replaceAll('assets/'+name,'data:'+mime+';base64,'+(await readFile(fixture+'assets/'+name)).toString('base64'));
 const license=await readFile(fixture+'assets/OFL.txt','utf8');
 html=html.replace('</body>','<script type="application/json" id="font-license">'+JSON.stringify({license}).replaceAll('<','\\u003c')+'</script></body>');
 await writeFile(out+'homepage-preview.html',html);
 await copyFile(fixture+'assets/huiwen-mikan.webp',out+'source-portrait.webp');
 await copyFile(fixture+'events-preview.json',out+'events-preview.json');
 await copyFile(fixture+'assets/fengshan-station.jpg',out+'source-station.jpg');
 const portable=await browser.newContext({viewport:{width:390,height:960}});const portablePage=await portable.newPage();await portablePage.setContent(html);await portablePage.evaluate(()=>document.fonts.ready);
 for(const [label,file] of [['下載直式圖卡','campaign-opening-portrait.png'],['下載橫式圖卡','campaign-opening-landscape.jpg']]){const pending=portablePage.waitForEvent('download');await portablePage.getByRole('link',{name:label,exact:true}).click();const d=await pending;const path=out+'portable-'+file;await d.saveAs(path);assert.deepEqual(await readFile(path),await readFile(fixture+'assets/'+file));}
 report.portableHtml={embeddedAssets:'Passed',exactCardDownloads:2};await portable.close();
} catch(error){report.failures.push(String(error));throw error;}finally{await browser.close();server.kill();await writeFile(out+'report.json',JSON.stringify(report,null,2));}
