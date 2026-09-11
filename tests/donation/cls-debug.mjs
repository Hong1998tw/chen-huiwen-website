import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const server=spawn('python3',['-m','http.server','8771','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
try{
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8771/')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(()=>{window.__shifts=[];new PerformanceObserver(list=>{for(const e of list.getEntries()){if(!e.hadRecentInput)window.__shifts.push({value:e.value,startTime:e.startTime,sources:(e.sources||[]).map(s=>({tag:s.node?.tagName,id:s.node?.id,cls:s.node?.className,text:(s.node?.textContent||'').trim().slice(0,80),previousRect:s.previousRect,currentRect:s.currentRect}))});}}).observe({type:'layout-shift',buffered:true});});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();
  await page.goto('http://127.0.0.1:8771/index.html');
  await page.waitForTimeout(1200);
  console.log(JSON.stringify(await page.evaluate(()=>window.__shifts),null,2));
  await browser.close();
}finally{server.kill('SIGTERM');}
