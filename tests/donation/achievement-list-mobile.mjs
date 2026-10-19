import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withTimeout} from './page-font-artifact-lifecycle.mjs';
import {startStaticServer} from './static-server.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(root,'tests/donation/results/achievement-list');
const FILTER_DIALOG_CLOSE_TIMEOUT_MS=3000;
await mkdir(output,{recursive:true});
const publicCases=JSON.parse(await readFile(resolve(root,'data/achievements.json'),'utf8')).filter(row=>row.status!=='待核驗');
const report={scope:'P-ACH-LIST mobile filters and map/list presentation',checks:[],failures:[],screenshots:[],diagnostics:{focusSequence:[],cleanupErrors:[]}};
let server,browser,page;
const focusSnapshot=async phase=>{
 const state=await page.evaluate(phase=>{
  const dialog=document.querySelector('#case-filter-dialog'),element=document.activeElement;
  let insideClosedDetails=false;
  for(let ancestor=element?.parentElement;ancestor&&ancestor!==dialog;ancestor=ancestor.parentElement){
   if(ancestor.tagName==='DETAILS'&&!ancestor.open&&ancestor.querySelector(':scope > summary')!==element)insideClosedDetails=true;
  }
  const bounds=element?.getBoundingClientRect();
  const label=(element?.getAttribute('aria-label')||element?.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
  return{phase,key:element?`${element.tagName.toLowerCase()}#${element.id||''}:${label}`:'none',tag:element?.tagName.toLowerCase()||null,id:element?.id||'',insideDialog:!!dialog?.contains(element),visible:!!bounds&&bounds.width>0&&bounds.height>0&&getComputedStyle(element).visibility!=='hidden',disabled:!!element?.matches(':disabled'),inert:!!element?.closest('[inert]'),insideClosedDetails,dialogOpen:!!dialog?.open};
 },phase);
 report.diagnostics.focusSequence.push(state);
 return state;
};
const waitForFilterDialogClosed=async action=>{
 try{
  await page.waitForFunction(()=>{
   const dialog=document.querySelector('#case-filter-dialog'),trigger=document.querySelector('#case-filter-open');
   return !!dialog&&!dialog.open&&trigger?.getAttribute('aria-expanded')==='false'
    &&!document.documentElement.classList.contains('case-filter-dialog-open')
    &&!document.body.classList.contains('case-filter-dialog-open')
    &&document.activeElement===trigger;
  },null,{timeout:FILTER_DIALOG_CLOSE_TIMEOUT_MS});
 }catch(error){
  const state=await withTimeout(page.evaluate(()=>{
   const dialog=document.querySelector('#case-filter-dialog'),trigger=document.querySelector('#case-filter-open');
   return{open:dialog?.open??null,ariaExpanded:trigger?.getAttribute('aria-expanded')??null,
    htmlOpenClass:document.documentElement.classList.contains('case-filter-dialog-open'),
    bodyOpenClass:document.body.classList.contains('case-filter-dialog-open'),
    focusReturned:document.activeElement===trigger,activeElement:{tag:document.activeElement?.tagName.toLowerCase()||null,id:document.activeElement?.id||''}};
  }),750,`${action} close-state diagnostic`).catch(diagnosticError=>({captureError:String(diagnosticError)}));
  throw new Error(`${action} did not reach the complete closed state within ${FILTER_DIALOG_CLOSE_TIMEOUT_MS}ms; observed ${JSON.stringify(state)}; wait error: ${String(error)}`);
 }
};
const check=async(name,fn)=>{
 let details,failure;
 try{details=await fn();}catch(error){failure=String(error);}
 finally{
  try{
   const dialog=page?.locator('#case-filter-dialog');
   if(dialog&&await dialog.evaluate(element=>element.open)){
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#case-filter-dialog')?.open===false);
   }
  }catch(error){report.diagnostics.cleanupErrors.push({after:name,error:String(error)});}
 }
 if(failure){report.checks.push({name,status:'Failed',error:failure});report.failures.push(name);}
 else report.checks.push({name,status:'Passed',...(details===undefined?{}:{details})});
};

try{
 server=await startStaticServer({root,compression:'none'});
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(server.url).origin?route.continue():route.fulfill({status:204,body:''}));
 page=await context.newPage();page.setDefaultTimeout(8000);
 page.on('pageerror',error=>report.failures.push('pageerror: '+String(error)));
 await page.goto(new URL('achievements.html#case-results',server.url).href,{waitUntil:'domcontentloaded'});

 await check('390 mobile first screen keeps keyword and the first result card visible',async()=>{
  report.diagnostics.firstScreen=await page.evaluate(()=>{
   const rect=selector=>{const element=document.querySelector(selector);if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0}};
   const fields=document.querySelector('#case-filter-fields'),dialog=document.querySelector('#case-filter-dialog');
   return{viewport:{width:innerWidth,height:innerHeight},activeElement:{tag:document.activeElement?.tagName.toLowerCase(),id:document.activeElement?.id||''},search:rect('#case-search'),filterTrigger:rect('#case-filter-open'),firstResult:rect('#case-list .case-card'),mapPanelHidden:document.querySelector('.map-panel')?.hidden,fieldsParent:{tag:fields?.parentElement?.tagName.toLowerCase(),id:fields?.parentElement?.id||'',className:fields?.parentElement?.className||'',insideDialog:!!dialog?.contains(fields)}};
  });
  await page.screenshot({path:resolve(output,'achievement-list-390-first-screen.png')});
  report.screenshots.push('achievement-list-390-first-screen.png');
  assert(await page.locator('#case-search').isVisible());
  assert(await page.locator('#case-filter-open').isVisible());
  assert.equal(await page.locator('#case-filter-dialog').evaluate(dialog=>dialog.open),false);
  assert.equal(await page.locator('#case-filter-fields').evaluate(fields=>fields.parentElement.matches('.case-filter-dialog-slot')&&fields.closest('#case-filter-dialog')!==null),true,'The single filter field group must live in the dialog slot');
  assert.equal(await page.locator('.map-panel').isHidden(),true);
  assert.equal(await page.locator('#case-list .case-card:visible').count(),10);
  const first=await page.locator('#case-list .case-card:visible').first().boundingBox();
  assert(first&&first.y<844&&first.y+first.height>0,JSON.stringify(first));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 });

 await check('Mobile modal traps keyboard focus, closes on Escape and returns focus',async()=>{
  const trigger=page.locator('#case-filter-open'),dialog=page.locator('#case-filter-dialog');
  await trigger.click();
  await page.waitForFunction(()=>document.querySelector('#case-filter-dialog')?.open===true);
  await page.screenshot({path:resolve(output,'achievement-list-390-filter-dialog.png')});
  report.screenshots.push('achievement-list-390-filter-dialog.png');
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  assert(await page.locator('html').evaluate(element=>element.classList.contains('case-filter-dialog-open')));
  assert(await page.locator('body').evaluate(element=>element.classList.contains('case-filter-dialog-open')));
  assert.equal(await page.locator('#case-filter-dialog').getAttribute('aria-labelledby'),'case-filter-title');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
  const initialFocus=await focusSnapshot('initial focus after opening');
  assert(initialFocus.insideDialog&&initialFocus.visible&&!initialFocus.disabled&&!initialFocus.inert&&!initialFocus.insideClosedDetails,JSON.stringify(initialFocus));
  const tabStops=await dialog.evaluate(element=>{
   const eligible=node=>{
    if(node.tabIndex<0||node.matches(':disabled')||node.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
    const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||!node.getClientRects().length)return false;
    for(let ancestor=node.parentElement;ancestor&&ancestor!==element;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open&&ancestor.querySelector(':scope > summary')!==node)return false;
    return true;
   };
   return[...element.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(eligible).map(node=>{const label=(node.getAttribute('aria-label')||node.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);return{key:`${node.tagName.toLowerCase()}#${node.id||''}:${label}`,tag:node.tagName.toLowerCase(),id:node.id||'',label,disabled:node.matches(':disabled'),insideClosedDetails:false};});
  });
  report.diagnostics.dialogTabStops=tabStops;
  assert(tabStops.length>=2,'Dialog should expose its close action and filter controls');
  const focusBoundary=boundary=>dialog.evaluate((element,boundary)=>{
   const eligible=node=>{
    if(node.tabIndex<0||node.matches(':disabled')||node.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
    const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||!node.getClientRects().length)return false;
    for(let ancestor=node.parentElement;ancestor&&ancestor!==element;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open&&ancestor.querySelector(':scope > summary')!==node)return false;
    return true;
   };
   const stops=[...element.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(eligible),target=boundary==='first'?stops[0]:stops.at(-1);target?.focus();
   const label=(target?.getAttribute('aria-label')||target?.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
   return target?`${target.tagName.toLowerCase()}#${target.id||''}:${label}`:'none';
  },boundary);
  await focusBoundary('last');
  await focusSnapshot('last tab stop before Tab');
  await page.keyboard.press('Tab');
  const afterTab=await focusSnapshot('after Tab from last tab stop');
  assert.equal(afterTab.key,tabStops[0].key,`Tab should wrap to the first enabled, visible dialog control: ${JSON.stringify(afterTab)}`);
  await focusBoundary('first');
  await focusSnapshot('first tab stop before Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  const afterShiftTab=await focusSnapshot('after Shift+Tab from first tab stop');
  assert.equal(afterShiftTab.key,tabStops.at(-1).key,`Shift+Tab should wrap to the last enabled, visible dialog control: ${JSON.stringify(afterShiftTab)}`);
  await page.locator('#case-filter-close').click();
  await waitForFilterDialogClosed('Close button click');
  assert(await trigger.evaluate(element=>element===document.activeElement));
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('html').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
  assert.equal(await page.locator('body').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
  await trigger.click();
  await page.waitForFunction(()=>{const dialog=document.querySelector('#case-filter-dialog');return dialog?.open&&dialog.contains(document.activeElement);});
  await page.keyboard.press('Escape');
  await waitForFilterDialogClosed('Escape key');
  assert.equal(await dialog.evaluate(element=>element.open),false);
  assert(await trigger.evaluate(element=>element===document.activeElement));
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('html').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
  assert.equal(await page.locator('body').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
 });

 await check('Filter selections, removable chips, URL hash and popstate stay synchronized',async()=>{
  const trigger=page.locator('#case-filter-open');
  await trigger.click();
  if(await page.locator('.advanced-filters').getAttribute('open')===null)await page.locator('.advanced-filters > summary').click();
  await page.locator('#village-filter').selectOption('v:文德里');
  await page.locator('#category-filter').selectOption('社福與衛環');
  await page.locator('#subcategory-filter').selectOption('寵物');
  await page.locator('#status-filter').selectOption('已完成');
  const year=await page.locator('#year-filter option').nth(1).getAttribute('value');
  assert(year);await page.locator('#year-filter').selectOption(year);
  await page.waitForFunction(()=>['village','category','subcategory','status','year'].every(key=>new URL(location.href).searchParams.has(key)));
  assert.equal(new URL(page.url()).hash,'#case-results');
  assert.equal(await page.locator('.active-case-filters button').count(),5);
  assert.equal(await page.evaluate(()=>document.querySelector('#village-filter').value),'v:文德里');
  assert.equal(await page.evaluate(()=>document.querySelector('#category-filter').value),'社福與衛環');
  await page.screenshot({path:resolve(output,'achievement-list-390-filtered.png')});
  report.screenshots.push('achievement-list-390-filtered.png');
  const axe=await new AxeBuilder({page}).include('#case-filter-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  if(axe.violations.length)await writeFile(resolve(output,'axe-mobile-dialog.json'),JSON.stringify(axe.violations,null,2));
  assert.deepEqual(axe.violations.map(item=>item.id),[],JSON.stringify(axe.violations.map(item=>({id:item.id,targets:item.nodes.map(node=>node.target)}))));
  await page.locator('#case-filter-close').click();
  const filters=[['category','社福與衛環'],['subcategory','寵物'],['status','已完成'],['year',await page.locator('#year-filter option:checked').textContent()],['village','文德里']];
  for(const [key,label] of filters){
   const chip=page.getByRole('button',{name:'移除篩選：'+label,exact:true});
   await chip.focus();
   if(key==='category')await page.keyboard.press('Enter');else await chip.click();
   await page.waitForFunction(name=>!new URL(location.href).searchParams.has(name),key);
   assert.equal(new URL(page.url()).hash,'#case-results');
  }
  assert.equal(await page.locator('.active-case-filters button').count(),0);
  assert(await page.evaluate(()=>document.querySelector('#case-filter-open')===document.activeElement));
  await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('status','已完成');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));});
  await page.waitForFunction(()=>window.HuiwenCases?.getState().filters.status==='已完成');
  await page.goBack();
  await page.waitForFunction(()=>window.HuiwenCases?.getState().filters.status==='all');
  assert.equal(new URL(page.url()).hash,'#case-results');
 });

 await check('390 map appears below results at 45vh with attribution and keyboard markers',async()=>{
  await page.getByRole('button',{name:'地圖與列表',exact:true}).click();
  await page.locator('#achievement-map').scrollIntoViewIfNeeded();
  const mapBounds=await page.locator('#achievement-map').boundingBox();
  report.diagnostics.mobileMap={map:mapBounds,attributionVisible:await page.locator('.leaflet-control-attribution').isVisible(),markers:await page.locator('.case-marker').count(),firstResult:await page.locator('#case-list .case-card:visible').first().boundingBox()};
  await page.screenshot({path:resolve(output,'achievement-list-390-map-diagnostic.png')});
  report.screenshots.push('achievement-list-390-map-diagnostic.png');
  await page.locator('.leaflet-control-attribution').waitFor();
  const bounds=await page.locator('#achievement-map').boundingBox();
  report.diagnostics.mobileMap.attributionVisible=await page.locator('.leaflet-control-attribution').isVisible();
  await page.screenshot({path:resolve(output,'achievement-list-390-map-and-list.png')});
  report.screenshots.push('achievement-list-390-map-and-list.png');
  assert(bounds&&Math.abs(bounds.height-844*.45)<2,JSON.stringify(bounds));
  assert(await page.locator('.leaflet-control-attribution').isVisible());
  const firstCard=await page.locator('#case-list .case-card:visible').first().boundingBox();
  const map=await page.locator('#achievement-map').boundingBox();
  assert(firstCard&&map&&firstCard.y<map.y,'List should remain before the map on mobile');
  const marker=page.locator('.case-marker').first();
  await marker.waitFor({state:'visible'});assert.equal(await marker.getAttribute('tabindex'),'0');
  await marker.focus();await page.keyboard.press('Enter');await page.locator('.leaflet-popup').waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 });

 await check('Resize to 1440 restores the same controls and selected state',async()=>{
  await page.getByRole('button',{name:'只看列表',exact:true}).click();
  await page.locator('#case-filter-open').click();
  if(await page.locator('.advanced-filters').getAttribute('open')===null)await page.locator('.advanced-filters > summary').click();
  await page.locator('#status-filter').selectOption('已完成');
  await page.locator('#status-filter').focus();
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:resolve(output,'achievement-list-1440.png')});
  report.screenshots.push('achievement-list-1440.png');
  await page.waitForFunction(()=>!document.querySelector('#case-filter-dialog')?.open&&document.querySelector('#case-filter-fields')?.parentElement.matches('.map-controls'));
  await page.waitForFunction(()=>document.activeElement?.id==='status-filter');
  assert.equal(await page.locator('#case-filter-open').isVisible(),false);
  assert.equal(await page.locator('#status-filter').inputValue(),'已完成');
  assert(await page.locator('#status-filter').evaluate(element=>element===document.activeElement));
  assert.equal(await page.locator('html').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
  assert.equal(await page.locator('body').evaluate(element=>element.classList.contains('case-filter-dialog-open')),false);
  const ids=await page.locator('[id]').evaluateAll(elements=>elements.map(element=>element.id));
  assert.equal(ids.length,new Set(ids).size,'filter controls must not be cloned');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>window.scrollTo(0,0));
  report.diagnostics.desktop=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},fieldsParent:document.querySelector('#case-filter-fields')?.parentElement?.className,filterTriggerHidden:document.querySelector('#case-filter-open')?.hidden,focusedElement:{tag:document.activeElement?.tagName.toLowerCase(),id:document.activeElement?.id||''}}));
  const axe=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  if(axe.violations.length)await writeFile(resolve(output,'axe-desktop.json'),JSON.stringify(axe.violations,null,2));
  assert.deepEqual(axe.violations.map(item=>item.id),[],JSON.stringify(axe.violations.map(item=>({id:item.id,targets:item.nodes.map(node=>node.target)}))));
  await page.screenshot({path:resolve(output,'achievement-list-1440.png')});
 });

 await check('Unsupported dialog keeps controls inline and usable',async()=>{
  const fallback=await browser.newContext({viewport:{width:390,height:844}});
  await fallback.addInitScript(()=>Object.defineProperty(HTMLDialogElement.prototype,'showModal',{value:undefined,configurable:true}));
  await fallback.route('**/*',route=>new URL(route.request().url()).origin===new URL(server.url).origin?route.continue():route.fulfill({status:204,body:''}));
  const fallbackPage=await fallback.newPage();await fallbackPage.goto(new URL('achievements.html',server.url).href,{waitUntil:'domcontentloaded'});
  assert.equal(await fallbackPage.locator('#case-filter-open').isVisible(),false);
  assert.equal(await fallbackPage.locator('#case-filter-fields').evaluate(fields=>fields.parentElement.matches('.map-controls')),true);
  assert(await fallbackPage.locator('#village-filter').isVisible());
  assert.equal(await fallbackPage.locator('#case-list .case-card:visible').count(),10);
  assert(await fallbackPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await fallback.close();
 });

 await check('No JavaScript retains inline filters, noscript guidance and the full server-rendered list',async()=>{
  const noJs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  await noJs.route('**/*',route=>new URL(route.request().url()).origin===new URL(server.url).origin?route.continue():route.fulfill({status:204,body:''}));
  const noJsPage=await noJs.newPage();await noJsPage.goto(new URL('achievements.html',server.url).href,{waitUntil:'domcontentloaded'});
  assert.equal(await noJsPage.locator('#case-filter-open').isVisible(),false);
  assert.equal(await noJsPage.locator('#case-filter-fields').evaluate(fields=>fields.parentElement.matches('.map-controls')),true);
  assert.equal(await noJsPage.locator('#case-list .case-card:visible').count(),publicCases.length);
  assert.match(await noJsPage.locator('noscript').innerText(),/完整紀錄與詳情頁仍可直接閱讀/);
  assert(await noJsPage.locator('#village-filter').isVisible());
  await noJs.close();
 });

 await check('Mobile and desktop screenshots were captured',async()=>assert(report.screenshots.length>=4,report.screenshots.join(', ')));
 await context.close();
}catch(error){
 report.failures.push('setup: '+String(error));
}finally{
 await browser?.close();
 await server?.close();
 await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
}

console.log(JSON.stringify(report,null,2));
if(report.failures.length)process.exitCode=1;
