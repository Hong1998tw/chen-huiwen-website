import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
const root=new URL('../../',import.meta.url).pathname;
const out=new URL('./results/',import.meta.url);await mkdir(out,{recursive:true});
const reports=[];const browser=await chromium.launch({headless:true});
try{
 for(const [label,dir,port] of [['baseline',root+'../chen-huiwen-baseline',8780],['candidate',root,8781]]){
  const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:dir,stdio:'ignore'});const base=`http://127.0.0.1:${port}/`;
  for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  for(const width of [1440,390])for(const path of ['index.html','achievements.html']){
   const c=await browser.newContext({viewport:{width,height:width===390?844:1000}});
   await c.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
   await c.addInitScript(()=>{window.metrics={lcp:0,shifts:[]};new PerformanceObserver(l=>{for(const e of l.getEntries())window.metrics.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.metrics.shifts.push({t:e.startTime,value:e.value});}).observe({type:'layout-shift',buffered:true});});
   const p=await c.newPage();await p.goto(base+path);await p.locator('.global-search-trigger').waitFor({state:'attached'});if(path==='achievements.html')await p.locator('.digital-dashboard').waitFor();
   await p.waitForTimeout(1000);
   const v=await p.evaluate(()=>{const m=window.metrics;let cls=0,session=0,start=0,last=0;for(const e of m.shifts){if(session&&e.t-last<1000&&e.t-start<=5000)session+=e.value;else{session=e.value;start=e.t;}last=e.t;cls=Math.max(cls,session);}return {lcpMs:Math.round(m.lcp),cls:Number(cls.toFixed(4)),resourceBytes:performance.getEntriesByType('resource').reduce((s,e)=>s+e.encodedBodySize,0)};});
   reports.push({version:label,width,page:path,...v});await c.close();
  }
  server.kill();
 }
}finally{await browser.close();}
const bundle={};for(const name of ['digital.js','digital.css','map.js','data/search-index.json']){const b=await readFile(root+name);bundle[name]={bytes:b.length,gzipBytes:gzipSync(b).length};}
const result={method:'Local Chromium 140, no throttling, external requests blocked, one cold context per page. Diagnostic comparison; not field Core Web Vitals.',reports,bundle};await writeFile(new URL('p0-performance.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
