import {chromium, webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNoHorizontalOverflow} from './layout-diagnostics.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const engine = process.env.ENGINE || 'chromium';
const base = process.env.BASE_URL || 'http://127.0.0.1:8767/';
const server = process.env.BASE_URL ? null : spawn('python3', ['-m', 'http.server', '8767', '--bind', '127.0.0.1'], {cwd:root, stdio:'ignore'});
const out = new URL('./results/sticky-navigation/' + engine + '/', import.meta.url);
await mkdir(out, {recursive:true});
const report = {engine, base, checks:[], failures:[], pageErrors:[]};
const browser = await ({chromium, webkit}[engine]).launch();
async function check(name, fn) {
  try { await fn(); report.checks.push({name, status:'PASS'}); }
  catch (e) { report.failures.push({name, error:String(e)}); }
}
try {
  for (let i=0;i<50;i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  for (const width of [320,360,390,430,768,1024,1440]) {
    const context = await browser.newContext({viewport:{width,height:844}, reducedMotion:'reduce'});
    await context.route('**/*', r=>new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
    const page = await context.newPage();
    page.on('pageerror', e=>report.pageErrors.push(String(e)));
    await page.goto(base);
    await page.locator('.global-search-trigger').waitFor({state:'attached'});
    await check(width + ' approved portrait crop loads eagerly within the hero', async()=>{
      await page.locator('.hero-portrait img').evaluate(el=>el.decode());
      assert(await page.locator('main > section').first().evaluate(el=>el.classList.contains('hero')));
      const box = await page.locator('.portrait-frame').boundingBox();
      assert(box && box.width > 0 && box.height > 0);
      assert(box.x >= 0 && box.x + box.width <= width);
      const expectedRatio = width <= 780 ? 2 / 3 : 1.04;
      assert(Math.abs(box.width / box.height - expectedRatio) < 0.02);
      assert.equal(await page.locator('h1').count(),1);
      assert.equal(await page.locator('.hero-portrait img').getAttribute('loading'),'eager');
      await assertNoHorizontalOverflow(page,{directory:fileURLToPath(new URL('./results/sticky-navigation/'+engine+'/diagnostics/',import.meta.url)),label:`${width}-homepage-layout`});
    });
    await page.screenshot({path:fileURLToPath(new URL(width + '-home.png',out))});
    await page.evaluate(()=>scrollTo({top:1200,behavior:'instant'}));
    await page.waitForTimeout(100);
    await check(width + ' header remains at viewport top after scrolling', async()=>{
      const box = await page.locator('.site-header').boundingBox();
      assert(Math.abs(box.y)<1, JSON.stringify(box));
      assert(await page.locator('.brand').isVisible());
    });
    await page.screenshot({path:fileURLToPath(new URL(width + '-scrolled.png',out))});
    if (width<=780) {
      await check(width + ' scrolled menu is reachable, scrollable and closes with focus restored', async()=>{
        // Use the visible button coordinates: locator.click() first calls
        // scrollIntoView, which can scroll a sticky element's original position.
        const toggle = await page.locator('.menu-toggle').boundingBox();
        const scrollBefore = await page.evaluate(()=>scrollY);
        await page.mouse.click(toggle.x+toggle.width/2, toggle.y+toggle.height/2);
        const header = await page.locator('.site-header').boundingBox();
        const menu = await page.locator('#navigation').boundingBox();
        assert(menu.y >= header.y + header.height);
        assert(menu.y + menu.height <= 844);
        assert(await page.locator('main').evaluate(el=>el.inert));
        await page.screenshot({path:fileURLToPath(new URL(width + '-menu.png',out))});
        assert.equal(await page.locator('#navigation .nav-group[open]').count(),0);
        const groups = page.locator('#navigation .nav-group');
        // Reproduce queued native toggle events by activating distinct groups
        // in one task. The last request must win immediately and stay open.
        const burst = await page.evaluate(async()=>{
          const groups=[...document.querySelectorAll('#navigation .nav-group')];
          for (const group of groups) group.querySelector('summary').click();
          const immediate=groups.flatMap((group,index)=>group.open?[index]:[]);
          await new Promise(resolve=>setTimeout(resolve,0));
          const settled=groups.flatMap((group,index)=>group.open?[index]:[]);
          groups.at(-1).querySelector('summary').click();
          await new Promise(resolve=>setTimeout(resolve,0));
          return {immediate,settled,closed:groups.every(group=>!group.open),last:groups.length-1};
        });
        assert.deepEqual(burst.immediate,[burst.last]);
        assert.deepEqual(burst.settled,[burst.last]);
        assert.equal(burst.closed,true);
        for (let pass=0;pass<3;pass++) {
          for (let index=0;index<await groups.count();index++) {
            const group=groups.nth(index);
            const summary=group.locator('summary');
            await summary.focus();
            assert(await summary.evaluate(el=>el===document.activeElement));
            await page.keyboard.press('Enter');
            // Waiting only for one open group can match the previous group.
            // Require the group just activated by Enter, then its rendered link.
            await page.waitForFunction(index=>{
              const groups=[...document.querySelectorAll('#navigation .nav-group')];
              return groups[index]?.open && groups.filter(group=>group.open).length===1;
            },index);
            await group.locator('a').first().waitFor({state:'visible'});
            assert(await group.locator('a').first().isVisible());
          }
        }
        await page.locator('#navigation a').last().scrollIntoViewIfNeeded();
        const last = await page.locator('#navigation a').last().boundingBox();
        assert(last.y >= menu.y && last.y+last.height <= 844);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'false');
        assert(await page.locator('.menu-toggle').evaluate(el=>el===document.activeElement));
        assert.equal(await page.locator('main').evaluate(el=>el.inert),false);
        assert.equal(await page.evaluate(()=>scrollY), scrollBefore);
      });
    }
    await check(width + ' page anchors clear the sticky header', async()=>{
      await page.goto(base+'achievement-metro-green-line.html');
      await page.locator('.civic-article-nav a[href="#case-history"]').click();
      await page.waitForTimeout(100);
      const header = await page.locator('.site-header').boundingBox();
      const target = await page.locator('#case-history').boundingBox();
      assert(target.y >= header.y+header.height-1, JSON.stringify({header,target}));
    });
    if (width===390 || width===1440) {
      await page.goto(base);
      await check(width + ' homepage accessibility', async()=>{
        const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
        assert.deepEqual(a.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);
      });
    }
    if(width===390) {
      await page.goto(base);
      await page.addStyleTag({content:'html{font-size:200%!important}'});
      await check('200% text stays within viewport',async()=>assertNoHorizontalOverflow(page,{directory:fileURLToPath(new URL('./results/sticky-navigation/'+engine+'/diagnostics/',import.meta.url)),label:'200%-text-layout'}));
    }
    await context.close();
  }
  const earlyMenuCheck='restored mobile scroll keeps an early menu focused and aligned after the first header sample';
  const earlyMenuDiagnostics={
    requestedSeed:250,
    fontStatus:null,
    images:null,
    actualSeed:null,
    pendingCallbacksBeforeSample:null,
    menuOpenedBeforeSample:null,
    focusInsideMenuBeforeSample:null,
    firstSample:null,
    afterFirstSample:null,
    settledGeometry:null,
    geometryFailure:null,
  };
  await check(earlyMenuCheck, async()=>{
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'no-preference'});
    try {
      await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
      const page=await context.newPage();
      page.on('pageerror',e=>report.pageErrors.push(String(e)));
      await page.route('**/site.js*',async route=>{
        const response=await route.fetch();
        const source=await response.text();
        const prelude=`(()=>{
          history.scrollRestoration='manual';
          document.documentElement.style.scrollBehavior='auto';
          window.scrollTo({top:250,behavior:'instant'});
          const nativeRequestAnimationFrame=window.requestAnimationFrame.bind(window);
          const observedHeader=document.querySelector('.site-header');
          const observedNavWrap=document.querySelector('.site-header .nav-wrap');
          const observedNavigation=document.querySelector('#navigation');
          const observedToggle=document.querySelector('.menu-toggle');
          const transitionEvents=[];
          const readRect=element=>{
            if(!element)return null;
            const {top,bottom,left,right,width,height}=element.getBoundingClientRect();
            return {top,bottom,left,right,width,height};
          };
          const readGeometry=()=>{
            const active=document.activeElement;
            const headerRect=readRect(observedHeader);
            const navWrapRect=readRect(observedNavWrap);
            const navigationRect=readRect(observedNavigation);
            const inlineMenuTop=observedNavigation?.style.getPropertyValue('--menu-top')||'';
            const expectedMenuTop=headerRect?Math.ceil(headerRect.bottom+12):null;
            const headerStyle=observedHeader?getComputedStyle(observedHeader):null;
            const navWrapStyle=observedNavWrap?getComputedStyle(observedNavWrap):null;
            return {
              compact:observedHeader?.classList.contains('is-compact')===true,
              headerRect,
              navWrapRect,
              navigationRect,
              inlineMenuTop,
              computedMenuTop:observedNavigation?getComputedStyle(observedNavigation).getPropertyValue('--menu-top'):null,
              expectedMenuTop,
              originalHeightPredicate:headerRect!==null&&Math.abs(headerRect.height-52)<=0.5,
              originalAnchorPredicate:expectedMenuTop!==null&&Number.parseFloat(inlineMenuTop)===expectedMenuTop,
              headerMinHeight:headerStyle?.minHeight||null,
              navWrapMinHeight:navWrapStyle?.minHeight||null,
              scrollY:window.scrollY,
              menuExpanded:observedToggle?.getAttribute('aria-expanded')==='true',
              focus:{insideMenu:observedNavigation?.contains(active)===true,tagName:active?.tagName||null,id:active?.id||'',className:typeof active?.className==='string'?active.className:''},
              classes:{header:observedHeader?[...observedHeader.classList]:[],navWrap:observedNavWrap?[...observedNavWrap.classList]:[],navigation:observedNavigation?[...observedNavigation.classList]:[],body:[...document.body.classList]},
              media:{mobile:matchMedia('(max-width: 780px)').matches,desktop:matchMedia('(min-width: 781px)').matches},
              transitionEventCount:transitionEvents.length,
            };
          };
          for(const type of ['transitionrun','transitionstart','transitionend','transitioncancel']){
            document.addEventListener(type,event=>{
              if(event.target!==observedHeader&&event.target!==observedNavWrap)return;
              if(transitionEvents.length===32)transitionEvents.shift();
              transitionEvents.push({
                type,atMs:performance.now(),target:event.target===observedHeader?'header':'nav-wrap',propertyName:event.propertyName,
                headerHeight:readRect(observedHeader)?.height??null,headerBottom:readRect(observedHeader)?.bottom??null,
                navWrapHeight:readRect(observedNavWrap)?.height??null,
                inlineMenuTop:observedNavigation?.style.getPropertyValue('--menu-top')||'',
              });
            },true);
          }
          window.__earlyMenuGeometrySnapshot=()=>({...readGeometry(),transitionEvents:transitionEvents.slice()});
          window.__sampleEarlyMenuGeometry=({frameLimit=16,budgetMs=2000}={})=>new Promise(resolve=>{
            const samples=[];
            let finished=false;
            const finish=status=>{
              if(finished)return;
              finished=true;
              window.clearTimeout(timer);
              resolve({status,samples,transitionEvents:transitionEvents.slice()});
            };
            const timer=window.setTimeout(()=>finish('time-budget-exhausted'),budgetMs);
            const sample=timestamp=>{
              if(finished)return;
              samples.push({frame:samples.length+1,atMs:timestamp,...readGeometry()});
              if(samples.length>=frameLimit)finish('frame-limit-reached');
              else nativeRequestAnimationFrame(sample);
            };
            nativeRequestAnimationFrame(sample);
          });
          window.__waitForStableRestoredLayout=async()=>{
            await document.fonts.ready;
            const images=[...document.images].filter(image=>{
              const rect=image.getBoundingClientRect();
              return image.loading!=='lazy'||image.complete||(rect.bottom>0&&rect.top<innerHeight);
            });
            const imageStates=await Promise.all(images.map(async image=>{
              try { await image.decode(); } catch {}
              return {complete:image.complete,naturalWidth:image.naturalWidth};
            }));
            await new Promise(resolve=>nativeRequestAnimationFrame(()=>nativeRequestAnimationFrame(resolve)));
            return {fontStatus:document.fonts.status,imageCount:document.images.length,observedImages:imageStates};
          };
          const pendingHeaderFrames=[];
          window.requestAnimationFrame=callback=>{pendingHeaderFrames.push(callback);return pendingHeaderFrames.length;};
          window.__pendingHeaderFrames=()=>pendingHeaderFrames.length;
          window.__flushHeaderFrames=()=>{
            const callbacks=pendingHeaderFrames.splice(0);
            window.requestAnimationFrame=nativeRequestAnimationFrame;
            const toggle=document.querySelector('.menu-toggle');
            const navigation=document.querySelector('#navigation');
            const firstSample={
              sampledAtMs:performance.now(),
              scrollY:window.scrollY,
              pendingCallbacks:callbacks.length,
              menuOpenedBeforeSample:toggle?.getAttribute('aria-expanded')==='true',
              focusInsideMenuBeforeSample:navigation?.contains(document.activeElement)===true,
            };
            window.__firstHeaderSample=firstSample;
            callbacks.forEach(callback=>callback(firstSample.sampledAtMs));
            return {callbackCount:callbacks.length,firstSample};
          };
        })();\n`;
        await route.fulfill({response,body:prelude+source});
      });
      await page.goto(base+'service.html');
      assert.equal(await page.evaluate(()=>typeof window.__flushHeaderFrames),'function');
      const layoutReadiness=await page.evaluate(()=>window.__waitForStableRestoredLayout());
      earlyMenuDiagnostics.fontStatus=layoutReadiness.fontStatus;
      earlyMenuDiagnostics.images={
        total:layoutReadiness.imageCount,
        observed:layoutReadiness.observedImages.length,
        states:layoutReadiness.observedImages,
      };
      assert.equal(layoutReadiness.fontStatus,'loaded',JSON.stringify(earlyMenuDiagnostics));
      assert(layoutReadiness.observedImages.every(image=>image.complete),JSON.stringify(earlyMenuDiagnostics));
      await page.evaluate(seed=>window.scrollTo({top:seed,behavior:'instant'}),earlyMenuDiagnostics.requestedSeed);
      await page.waitForFunction(seed=>window.scrollY===seed,earlyMenuDiagnostics.requestedSeed,{polling:10});
      const seededState=await page.evaluate(()=>({actualSeed:window.scrollY,pendingCallbacks:window.__pendingHeaderFrames()}));
      earlyMenuDiagnostics.actualSeed=seededState.actualSeed;
      assert.equal(earlyMenuDiagnostics.actualSeed,earlyMenuDiagnostics.requestedSeed,JSON.stringify(earlyMenuDiagnostics));
      assert(earlyMenuDiagnostics.actualSeed>0,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(seededState.pendingCallbacks,1,JSON.stringify(earlyMenuDiagnostics));
      const toggle=await page.locator('.menu-toggle').boundingBox();
      assert(toggle);
      await page.mouse.click(toggle.x+toggle.width/2,toggle.y+toggle.height/2);
      await page.evaluate(()=>{window.__earlyMenuFocus=document.activeElement;});
      const beforeSample=await page.evaluate(()=>({
        menuOpened:document.querySelector('.menu-toggle').getAttribute('aria-expanded')==='true',
        focusInsideMenu:document.querySelector('#navigation').contains(document.activeElement),
        pendingCallbacks:window.__pendingHeaderFrames(),
      }));
      earlyMenuDiagnostics.menuOpenedBeforeSample=beforeSample.menuOpened;
      earlyMenuDiagnostics.focusInsideMenuBeforeSample=beforeSample.focusInsideMenu;
      earlyMenuDiagnostics.pendingCallbacksBeforeSample=beforeSample.pendingCallbacks;
      assert.equal(beforeSample.menuOpened,true,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(beforeSample.focusInsideMenu,true,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(beforeSample.pendingCallbacks,1,JSON.stringify(earlyMenuDiagnostics));
      const flush=await page.evaluate(()=>window.__flushHeaderFrames());
      earlyMenuDiagnostics.firstSample=flush.firstSample;
      assert.equal(flush.callbackCount,1,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(flush.firstSample.scrollY,earlyMenuDiagnostics.actualSeed,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(flush.firstSample.menuOpenedBeforeSample,true,JSON.stringify(earlyMenuDiagnostics));
      assert.equal(flush.firstSample.focusInsideMenuBeforeSample,true,JSON.stringify(earlyMenuDiagnostics));
      earlyMenuDiagnostics.afterFirstSample=await page.evaluate(()=>({
        compact:document.querySelector('.site-header').classList.contains('is-compact'),
        menuOpened:document.querySelector('.menu-toggle').getAttribute('aria-expanded')==='true',
      }));
      try {
        // This fixture holds requestAnimationFrame for the header sample; poll by timer here.
        await page.waitForFunction(()=>{
          const header=document.querySelector('.site-header');
          const navigation=document.querySelector('#navigation');
          const menuTop=Number.parseFloat(navigation.style.getPropertyValue('--menu-top'));
          return header.classList.contains('is-compact')&&
            Math.abs(header.getBoundingClientRect().height-52)<=0.5&&
            menuTop===Math.ceil(header.getBoundingClientRect().bottom+12);
        },null,{timeout:2000,polling:10});
      } catch(error) {
        try {
          // Preserve the exact end state before taking a short native-RAF trace.
          const terminal=await page.evaluate(()=>window.__earlyMenuGeometrySnapshot());
          const trace=await page.evaluate(()=>window.__sampleEarlyMenuGeometry({frameLimit:16,budgetMs:2000}));
          earlyMenuDiagnostics.geometryFailure={waitError:String(error),terminal,samples:trace.samples,sampleStatus:trace.status,transitionEventsAfterSample:trace.transitionEvents};
        } catch(captureError) {
          earlyMenuDiagnostics.geometryFailure={waitError:String(error),captureError:String(captureError)};
        }
        throw error;
      }
      earlyMenuDiagnostics.settledGeometry=await page.evaluate(()=>{
        const header=document.querySelector('.site-header');
        const navigation=document.querySelector('#navigation');
        const headerBox=header.getBoundingClientRect();
        return {
          scrollY:window.scrollY,
          compact:header.classList.contains('is-compact'),
          headerHeight:headerBox.height,
          menuTop:Number.parseFloat(navigation.style.getPropertyValue('--menu-top')),
          expectedMenuTop:Math.ceil(headerBox.bottom+12),
          menuOpened:document.querySelector('.menu-toggle').getAttribute('aria-expanded')==='true',
          focusInsideMenu:navigation.contains(document.activeElement),
        };
      });
      assert(await page.evaluate(()=>document.querySelector('#navigation').contains(document.activeElement)));
      assert(await page.evaluate(()=>document.activeElement===window.__earlyMenuFocus));
    } finally {
      await context.close();
    }
  });
  const earlyMenuRecord=report.checks.find(item=>item.name===earlyMenuCheck)||report.failures.find(item=>item.name===earlyMenuCheck);
  if(earlyMenuRecord) earlyMenuRecord.diagnostics=earlyMenuDiagnostics;
  await check('no JavaScript navigation remains visible and scrolls normally', async()=>{
    const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
    const page=await context.newPage();
    await page.goto(base);
    assert(await page.locator('#navigation .nav-group summary').first().isVisible());
    assert.equal(await page.locator('.menu-toggle').isVisible(),false);
    assert.equal(await page.locator('.topline').evaluate(el=>getComputedStyle(el).display),'none');
    assert(await page.locator('.header-phone').isVisible());
    assert((await page.locator('.brand-role').innerText()).includes('高雄市議員'));
    assert((await page.locator('.brand-role').innerText()).includes('鳳山區'));
    await page.goto(base+'service.html');
    assert.equal(await page.locator('.header-phone').getAttribute('href'),await page.locator('#contact .contact-card .big-phone').getAttribute('href'));
    await page.goto(base);
    await page.locator('#navigation .nav-group summary').first().click();
    assert(await page.locator('#navigation a').first().isVisible());
    const flow=await page.evaluate(()=>{
      const header=document.querySelector('.site-header').getBoundingClientRect();
      const nav=document.querySelector('#navigation').getBoundingClientRect();
      const main=document.querySelector('main').getBoundingClientRect();
      return{headerBottom:header.bottom,navBottom:nav.bottom,mainTop:main.top};
    });
    assert(flow.navBottom<=flow.headerBottom+1,JSON.stringify(flow));
    assert(flow.mainTop>=flow.headerBottom-1,JSON.stringify(flow));
    const heading=page.locator('main h1').first();
    await heading.scrollIntoViewIfNeeded();
    const headingRect=await heading.boundingBox();
    assert(headingRect&&headingRect.y>=0&&headingRect.y<844,JSON.stringify(headingRect));
    await page.evaluate(()=>scrollTo({top:Math.min(120,document.documentElement.scrollHeight),behavior:'instant'}));
    const headerDocumentTop=await page.locator('.site-header').evaluate(el=>el.getBoundingClientRect().top+scrollY);
    assert(Math.abs(headerDocumentTop)<=1,JSON.stringify({headerDocumentTop,scrollY:await page.evaluate(()=>scrollY)}));
    await context.close();
  });
} finally {
  await browser.close(); server?.kill();
  await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
if(report.failures.length || report.pageErrors.length) process.exitCode=1;
