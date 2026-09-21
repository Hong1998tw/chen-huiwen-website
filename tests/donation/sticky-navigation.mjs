import {chromium, webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
  for (const width of [320,390,430,768,1024,1440]) {
    const context = await browser.newContext({viewport:{width,height:844}, reducedMotion:'reduce'});
    await context.route('**/*', r=>new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
    const page = await context.newPage();
    page.on('pageerror', e=>report.pageErrors.push(String(e)));
    await page.goto(base);
    await page.locator('.global-search-trigger').waitFor({state:'attached'});
    await check(width + ' portrait is the first content and visible without scrolling', async()=>{
      await page.locator('.hero-portrait img').evaluate(el=>el.decode());
      assert.equal(await page.locator('main > section').first().getAttribute('class'), 'hero');
      const box = await page.locator('.hero-portrait img').boundingBox();
      assert(box.y >= 0 && box.y + box.height <= 844);
      assert.equal(await page.locator('h1').count(),1);
      assert.equal(await page.locator('.hero-portrait img').getAttribute('loading'),'eager');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
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
      await check('200% text stays within viewport',async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
    }
    await context.close();
  }
  await check('no JavaScript navigation remains visible and scrolls normally', async()=>{
    const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
    const page=await context.newPage();
    await page.goto(base);
    assert(await page.locator('#navigation a').first().isVisible());
    assert.equal(await page.locator('.site-header').evaluate(el=>getComputedStyle(el).position),'relative');
    await context.close();
  });
} finally {
  await browser.close(); server?.kill();
  await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
if(report.failures.length || report.pageErrors.length) process.exitCode=1;
