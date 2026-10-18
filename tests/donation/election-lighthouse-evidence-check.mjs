import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { correlateBrowserRequests, electionResourceEntries, serializeRawTrace, writeElectionResourceSnapshot } from './election-lighthouse-evidence.mjs';

const checks=[];
const root=await mkdtemp(join(tmpdir(),'election-lighthouse-evidence-'));
try{
 const core='assets/fonts/huiwen-site-sans/generated/huiwen-election-core-123456789abc.woff2';
 const full='assets/fonts/huiwen-site-sans/generated/huiwen-election-full-abcdef123456.woff2';
 const paths=['election.html','site.js','election.js','styles.css','mobile.css','layout.css','campaign.css','civic.css','digital.css','digital.js',core,full];
 const files=[];
 for(const [index,path] of paths.entries()){
  const bytes=Buffer.from(`public election fixture ${index}`);
  const source=resolve(root,...path.split('/'));
  await mkdir(dirname(source),{recursive:true});
  await writeFile(source,bytes);
  files.push({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 const manifest={digest:'a'.repeat(64),files};
 const stylesheet=`@font-face{src:url('/${core}')}@font-face{src:url("/${full}")}`;

checks.push(['selects only the explicit election files and Core/Full fonts',()=>{
 assert.deepEqual(electionResourceEntries(manifest,stylesheet).map(file=>file.path),paths);
 assert.throws(()=>electionResourceEntries(manifest,`@font-face{src:url('/${core}')}`),/missing the full font source/);
}]);

checks.push(['writes public allowlist bytes with exact source and served-request hashes',async()=>{
  const outDir=resolve(root,'evidence/election-snapshot');
  const sourceCommit='1'.repeat(40);
  const checkedOutCommit='2'.repeat(40);
  const baseOrigin='http://127.0.0.1:8820';
  const localRequest={url:`${baseOrigin}/election.html?x=1`,statusCode:200,mimeType:'text/html',resourceType:'Document',transferSize:files[0].size,resourceSize:files[0].size};
  const externalRequest={url:'https://cdn.invalid/election.html?x=1',statusCode:200,mimeType:'text/html',resourceType:'Document',transferSize:files[0].size,resourceSize:files[0].size};
  const serverRow={page:'election.html',run:1,path:'/election.html?x=1',status:200,identityBytes:files[0].size,identitySha256:files[0].sha256};
  const pageRequests=correlateBrowserRequests([localRequest,externalRequest],[serverRow],baseOrigin);
  assert.equal(pageRequests[0].url,localRequest.url);
  assert.equal(pageRequests[0].origin,baseOrigin);
  assert.equal(pageRequests[0].serverIdentitySha256,files[0].sha256);
  assert.equal(pageRequests[1].origin,'https://cdn.invalid');
  assert.equal(pageRequests[1].serverIdentitySha256,null);
  const result=await writeElectionResourceSnapshot({root,outDir,manifest,stylesheet,sourceCommit,checkedOutCommit,
  baseOrigin,serverLog:[serverRow],
  results:[{page:'election.html',run:1,pageRequests}]});
 assert.deepEqual(result,{manifestFile:'election-snapshot/manifest.json',files:12,sourceCommit,contentDigest:manifest.digest});
 const snapshot=JSON.parse(await readFile(resolve(outDir,'manifest.json'),'utf8'));
 assert.equal(snapshot.files.length,12);
 assert.equal(snapshot.sourceCommit,sourceCommit);
 assert.equal(snapshot.checkedOutCommit,checkedOutCommit);
 assert.equal(snapshot.contentDigest,manifest.digest);
 assert.equal(snapshot.files[0].serverRequests[0].identitySha256,files[0].sha256);
 assert.equal(snapshot.files[0].lighthouseRequests[0].requests[0].serverIdentitySha256,files[0].sha256);
 assert.equal(snapshot.files[0].lighthouseRequests[0].requests[0].serverIdentityBytes,files[0].size);
 assert.equal(snapshot.files[0].lighthouseRequests[0].requests.length,1,'external request with matching path is excluded');
 assert.equal(snapshot.files[0].lighthouseRequests[0].requests[0].origin,baseOrigin);
 for(const file of snapshot.files){
  const bytes=await readFile(resolve(outDir,...file.snapshotPath.split('/')));
  assert.equal(bytes.length,file.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
 }
}]);

checks.push(['rejects missing or mismatched identity proof for same-origin 200 allowlisted requests',async()=>{
 const baseOrigin='http://127.0.0.1:8820';
 const request={url:`${baseOrigin}/election.html`,origin:baseOrigin,path:'/election.html',statusCode:200};
 for(const proof of [{serverIdentityBytes:files[0].size},{serverIdentitySha256:'f'.repeat(64),serverIdentityBytes:files[0].size},{serverIdentitySha256:files[0].sha256,serverIdentityBytes:files[0].size+1}]){
  await assert.rejects(writeElectionResourceSnapshot({root,outDir:resolve(root,`bad-proof-${Math.random()}`),manifest,stylesheet,baseOrigin,
   results:[{page:'election.html',run:1,pageRequests:[{...request,...proof}]}]}),/lacks matching server bytes/);
 }
}]);

checks.push(['fails if a public resource changes after the content digest was taken',async()=>{
 await writeFile(resolve(root,'election.js'),'changed after manifest');
 await assert.rejects(writeElectionResourceSnapshot({root,outDir:resolve(root,'changed/election-snapshot'),manifest,stylesheet,baseOrigin:'http://127.0.0.1:8820'}),/changed after content manifest/);
}]);

checks.push(['serializes the raw Chrome trace with reproducible SHA-256 and event count',()=>{
 const trace={traceEvents:[
  {name:'RunTask',ts:1,dur:2,args:{data:{url:'https://public.invalid/election.html'}}},
  {name:'FunctionCall',ts:3,dur:1,args:{data:{url:'https://public.invalid/site.js',lineNumber:23}}},
 ]};
 const serialized=serializeRawTrace(trace);
 assert.equal(serialized.traceEventCount,2);
 assert.deepEqual(JSON.parse(serialized.bytes.toString('utf8')),trace);
 assert.equal(serialized.sha256,createHash('sha256').update(serialized.bytes).digest('hex'));
 assert.throws(()=>serializeRawTrace({traceEvents:null}),/raw Chrome trace event list/);
}]);

 for(const [name,run] of checks){await run();console.log(`PASS ${name}`);}
 console.log(`election-lighthouse-evidence-check: ${checks.length} checks passed`);
}finally{await rm(root,{recursive:true,force:true});}
