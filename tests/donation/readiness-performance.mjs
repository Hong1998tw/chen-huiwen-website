/** Mobile Lighthouse, default simulated slow-4G / 4x CPU. No audit exclusions,
 * request blocking, service-worker suppression or custom score weights.
 * ROOT_DIR and LABEL select an immutable baseline or candidate checkout.
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(process.env.ROOT_DIR || fileURLToPath(new URL('../../',import.meta.url)));
const label=process.env.LABEL || 'candidate';
const out=resolve(process.env.EVIDENCE_DIR || fileURLToPath(new URL('./results/readiness/',import.meta.url)),label+'-lighthouse');
const runs=Number(process.env.RUNS || 3);
const pages=(process.env.PAGES || 'index.html,about.html,achievements.html,vision.html,news.html,news-20260915-special-education-nurse.html,political-donation.html').split(',');
const port=Number(process.env.PORT || 8820);
await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
const base=process.env.BASE_URL || `http://127.0.0.1:${port}/`;
const results=[];
try{
 if(!process.env.BASE_URL){let ready=false;for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Local server failed');}
 for(const page of pages) for(let run=1;run<=runs;run++){
  const chrome=await chromeLauncher.launch({chromePath:chromium.executablePath(),chromeFlags:['--headless','--no-first-run'],logLevel:'silent'});
  try{
   const {lhr}=await lighthouse(new URL(page,base).href,{port:chrome.port,logLevel:'error',output:'json',onlyCategories:['performance','accessibility','best-practices','seo']});
   const scores=Object.fromEntries(Object.entries(lhr.categories).map(([k,v])=>[k,Math.round(v.score*100)]));
   const metrics=Object.fromEntries(['first-contentful-paint','largest-contentful-paint','speed-index','total-blocking-time','cumulative-layout-shift','total-byte-weight'].map(id=>[id,lhr.audits[id]?.numericValue]));
   const failures=Object.values(lhr.audits).filter(a=>a.score!==null&&a.score<1).map(a=>({id:a.id,title:a.title,score:a.score,displayValue:a.displayValue,details:a.details}));
   const result={page,run,scores,metrics,failures,warnings:lhr.runWarnings,runtimeError:lhr.runtimeError,lighthouseVersion:lhr.lighthouseVersion,environment:lhr.environment,configSettings:lhr.configSettings,fetchTime:lhr.fetchTime};
   results.push(result);await writeFile(resolve(out,`${page}-${run}.json`),JSON.stringify(lhr));
   console.log(JSON.stringify({label,page,run,scores,metrics,error:lhr.runtimeError}));
   await writeFile(resolve(out,'summary.json'),JSON.stringify({label,node:process.version,root,method:'Default mobile Lighthouse; all network requests allowed; cold Chrome per run; lab data, not field CWV. Local tests do not exercise production edge or registered SW (site disables SW on localhost).',results},null,2));
  }finally{await chrome.kill();}
 }
}finally{server.kill();}
const thresholds={performance:90,accessibility:95,'best-practices':95,seo:95};
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const acceptance=[];
for(const page of pages){
 const pageRuns=results.filter(result=>result.page===page);
 const medians=Object.fromEntries(Object.keys(thresholds).map(key=>[key,median(pageRuns.map(result=>result.scores[key]))]));
 acceptance.push({page,medians,passed:Object.entries(thresholds).every(([key,value])=>medians[key]>=value)});
}
await writeFile(resolve(out,'summary.json'),JSON.stringify({label,node:process.version,root,method:'Default mobile Lighthouse; all network requests allowed; cold Chrome per run; lab data, not field CWV. Local tests do not exercise production edge or registered SW (site disables SW on localhost).',thresholds,acceptance,results},null,2));
console.log(JSON.stringify({acceptance,thresholds},null,2));
if(results.some(r=>r.runtimeError)||acceptance.some(row=>!row.passed))process.exitCode=1;
