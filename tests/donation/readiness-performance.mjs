/** Mobile Lighthouse, default simulated slow-4G / 4x CPU. No audit exclusions,
 * request blocking, service-worker suppression or custom score weights.
 * ROOT_DIR and LABEL select an immutable baseline or candidate checkout.
 *
 * Measurement condition (recorded in summary.json `conditions`): pages are served by
 * static-server.mjs, which negotiates Content-Encoding like the production edge
 * (br, else gzip, else identity; no Vary). COMPRESSION=none serves identity bodies and
 * reproduces the earlier `python3 -m http.server` condition for A/B comparison.
 * ENFORCE_THRESHOLDS=0 records `passed` per page but does not fail the run (used only for the
 * informational uncompressed reference run; the acceptance gate always enforces).
 * EXPECT_BROWSER_VERSION fails the run before measuring if Chromium differs from the
 * pinned build, so scores from different browsers are never mixed silently.
 *
 * Measured content: ROOT_DIR is hashed file by file (content-manifest.mjs) before the first
 * and after the last Lighthouse run. summary.json `content` carries the digest, file count and
 * `unchangedDuringRun`; content-manifest.json carries the per-file list. The run fails if the tree
 * changed while it was measured. lighthouse-compare.mjs uses these to prove two runs measured
 * identical content. The CI gate points ROOT_DIR at the final `_site` built by
 * scripts/build_cloudflare_public.py; the repository root is only a local fallback and is not the
 * deployed artifact (docs/LIGHTHOUSE-MEASUREMENT.md §2a).
 */
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildContentManifest } from './content-manifest.mjs';
import { fileURLToPath } from 'node:url';
import { BROTLI_QUALITY, CACHE_CONTROL, COMPRESSION_MODES, GZIP_LEVEL, startStaticServer } from './static-server.mjs';
const root=resolve(process.env.ROOT_DIR || fileURLToPath(new URL('../../',import.meta.url)));
const label=process.env.LABEL || 'candidate';
const out=resolve(process.env.EVIDENCE_DIR || fileURLToPath(new URL('./results/readiness/',import.meta.url)),label+'-lighthouse');
const runs=Number(process.env.RUNS || 3);
const pages=(process.env.PAGES || 'index.html,about.html,achievements.html,vision.html,news.html,news-20260915-special-education-nurse.html,political-donation.html,election.html').split(',');
const port=Number(process.env.PORT || 8820);
const compression=process.env.COMPRESSION || 'auto';
if(!process.env.BASE_URL&&!COMPRESSION_MODES.includes(compression))throw Error(`COMPRESSION must be one of ${COMPRESSION_MODES.join(', ')}`);
await mkdir(out,{recursive:true});
const manifestOptions={skipPaths:[out,resolve(root,'tests/donation/results')]};
const external=Boolean(process.env.BASE_URL);
// BASE_URL measures a remote origin whose bytes this script cannot see: no digest, so no comparison can claim identical content.
const contentBefore=external?null:await buildContentManifest(root,manifestOptions);
if(contentBefore)await writeFile(resolve(out,'content-manifest.json'),JSON.stringify(contentBefore,null,1));
const content=external?{external:true,digest:null,unchangedDuringRun:null}:{root,digest:contentBefore.digest,fileCount:contentBefore.fileCount,totalBytes:contentBefore.totalBytes,manifestFile:'content-manifest.json',skippedPaths:contentBefore.skipPaths,digestAfterRun:null,unchangedDuringRun:null};
const server=process.env.BASE_URL?null:await startStaticServer({root,compression,port});
const base=process.env.BASE_URL || server.url;
const results=[];
const serverLog=[];
const thresholds={performance:90,accessibility:95,'best-practices':95,seo:95};
const conditions={
 server:server?'tests/donation/static-server.mjs':'external BASE_URL',
 compression:server?compression:'external',
 brotliQuality:server&&compression==='auto'?BROTLI_QUALITY:null,
 gzipLevel:server&&compression==='auto'?GZIP_LEVEL:null,
 vary:null,
 cacheControl:server?CACHE_CONTROL:null,
 expectBrowserVersion:process.env.EXPECT_BROWSER_VERSION||null,
 browserVersion:null,
 browserBuild:chromium.executablePath(),
 node:process.version,
 runs,
 ci:Boolean(process.env.CI),
 enforceThresholds:process.env.ENFORCE_THRESHOLDS!=='0',
 thresholds
};
const summarize=(extra={})=>({label,node:process.version,root,content,conditions,method:'Default mobile Lighthouse; all network requests allowed; cold Chrome per run; lab data, not field CWV. Pages are served over HTTP by static-server.mjs with production-like Content-Encoding (see conditions); production edge, TLS/HTTP2 and the registered SW are not exercised (site disables SW on localhost).',...extra,results});
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
try{
 if(!process.env.BASE_URL){let ready=false;for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Local server failed');serverLog.length=0;server.log.length=0;}
 for(const page of pages) for(let run=1;run<=runs;run++){
  const chrome=await chromeLauncher.launch({chromePath:chromium.executablePath(),chromeFlags:['--headless=new','--no-first-run','--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],logLevel:'silent'});
  try{
   const browser=(await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).Browser;
   const browserVersion=String(browser).replace(/^.*\//,'');
   if(conditions.browserVersion&&conditions.browserVersion!==browserVersion)throw Error(`Chromium changed during the run: ${conditions.browserVersion} -> ${browserVersion}`);
   conditions.browserVersion=browserVersion;
   if(process.env.EXPECT_BROWSER_VERSION&&process.env.EXPECT_BROWSER_VERSION!==browserVersion)throw Error(`Chromium ${browserVersion} does not match EXPECT_BROWSER_VERSION=${process.env.EXPECT_BROWSER_VERSION}; update the pin deliberately and keep old and new scores separate`);
   const logStart=server?server.log.length:0;
   const {lhr}=await lighthouse(new URL(page,base).href,{port:chrome.port,logLevel:'error',output:'json',onlyCategories:['performance','accessibility','best-practices','seo']});
   const scores=Object.fromEntries(Object.entries(lhr.categories).map(([k,v])=>[k,Math.round(v.score*100)]));
   const metrics=Object.fromEntries(['first-contentful-paint','largest-contentful-paint','speed-index','total-blocking-time','cumulative-layout-shift','total-byte-weight'].map(id=>[id,lhr.audits[id]?.numericValue]));
   const failures=Object.values(lhr.audits).filter(a=>a.score!==null&&a.score<1).map(a=>({id:a.id,title:a.title,score:a.score,displayValue:a.displayValue,details:a.details}));
   const items=lhr.audits['network-requests']?.details?.items||[];
   const requests=server?server.log.slice(logStart).map(row=>({page,run,...row})):[];
   serverLog.push(...requests);
   // Chrome-observed requests joined to what the server actually sent for the same path.
   const sent=new Map(requests.filter(row=>row.status===200).map(row=>[row.path,row]));
   const pageRequests=items.map(item=>{const url=new URL(item.url);const row=sent.get(url.pathname+url.search);return {path:url.pathname+url.search,statusCode:item.statusCode,mimeType:item.mimeType,resourceType:item.resourceType,
    chromeTransferSize:item.transferSize,chromeResourceSize:item.resourceSize,contentEncoding:row?row.contentEncoding:null,vary:row?row.vary:null,serverIdentityBytes:row?.identityBytes??null,serverIdentitySha256:row?.identitySha256??null,serverBodyBytes:row?.transferBytes??null};});
   const network={requests:items.length,transferSize:items.reduce((sum,item)=>sum+(item.transferSize||0),0),resourceSize:items.reduce((sum,item)=>sum+(item.resourceSize||0),0),
    encodedBodies:Object.fromEntries(['br','gzip','identity'].map(name=>[name,pageRequests.filter(row=>row.serverBodyBytes!==null&&(row.contentEncoding||'identity')===name).length])),
    serverBodyBytes:pageRequests.reduce((sum,row)=>sum+(row.serverBodyBytes||0),0),serverIdentityBytes:pageRequests.reduce((sum,row)=>sum+(row.serverIdentityBytes||0),0),
    serverRequestsTotal:requests.length,serverRequestsOutsidePage:requests.length-pageRequests.length};
   const result={page,run,scores,metrics,network,pageRequests,failures,warnings:lhr.runWarnings,runtimeError:lhr.runtimeError,lighthouseVersion:lhr.lighthouseVersion,browserVersion,hostUserAgent:lhr.environment?.hostUserAgent,environment:lhr.environment,configSettings:lhr.configSettings,fetchTime:lhr.fetchTime};
   results.push(result);await writeFile(resolve(out,`${page}-${run}.json`),JSON.stringify(lhr));
   console.log(JSON.stringify({label,page,run,scores,metrics,network,error:lhr.runtimeError}));
   await writeFile(resolve(out,'summary.json'),JSON.stringify(summarize(),null,2));
   await writeFile(resolve(out,'server-log.json'),JSON.stringify(serverLog,null,1));
  }finally{await chrome.kill();}
 }
}finally{await server?.close();}
if(contentBefore){const contentAfter=await buildContentManifest(root,manifestOptions);
content.digestAfterRun=contentAfter.digest;
content.unchangedDuringRun=contentAfter.digest===contentBefore.digest;
if(!content.unchangedDuringRun)console.error(`Measured content changed during the run: ${contentBefore.digest} -> ${contentAfter.digest}`);}
const acceptance=[];
for(const page of pages){
 const pageRuns=results.filter(result=>result.page===page);
 const medians=Object.fromEntries(Object.keys(thresholds).map(key=>[key,median(pageRuns.map(result=>result.scores[key]))]));
 const metricMedians=Object.fromEntries(['first-contentful-paint','largest-contentful-paint','speed-index','total-blocking-time','cumulative-layout-shift'].map(id=>[id,median(pageRuns.map(result=>result.metrics[id]))]));
 const transferMedian=median(pageRuns.map(result=>result.network.transferSize));
 acceptance.push({page,medians,metricMedians,transferSizeMedian:transferMedian,passed:Object.entries(thresholds).every(([key,value])=>medians[key]>=value)});
}
await writeFile(resolve(out,'summary.json'),JSON.stringify(summarize({thresholds,acceptance}),null,2));
console.log(JSON.stringify({conditions,acceptance,thresholds},null,2));
if((!external&&!content.unchangedDuringRun)||results.some(r=>r.runtimeError)||(conditions.enforceThresholds&&acceptance.some(row=>!row.passed)))process.exitCode=1;
