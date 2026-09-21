import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const out='artifacts/astra-redesign/screenshots';await mkdir(out,{recursive:true});
const label=process.env.CAPTURE_LABEL||'latest';
const browser=await chromium.launch();const page=await browser.newPage();
for(const width of [1440,390]){
 await page.setViewportSize({width,height:width===390?844:960});
 for(const route of ['index.html','achievements.html','achievement-metro-green-line.html','service.html','news.html','petition.html','explore.html','404.html']){
  await page.goto('http://127.0.0.1:8766/'+route);await page.waitForTimeout(250);
  await page.screenshot({path:`${out}/${label}-${route.replace('.html','')}-${width}.png`,fullPage:false});
  if(route==='index.html'){
   await page.locator('.civic-stories').scrollIntoViewIfNeeded();await page.locator('.civic-feature-photo img').evaluate(img=>img.decode());
   await page.locator('.civic-stories').screenshot({path:`${out}/${label}-reading-${width}.png`});
  }
  if(route==='achievements.html'){
   await page.locator('#achievement-map').scrollIntoViewIfNeeded();await page.locator('#achievement-map').hover();await page.locator('.case-marker').first().waitFor();await page.waitForTimeout(500);
   await page.locator('.map-panel').screenshot({path:`${out}/${label}-map-${width}.png`});
   await page.getByRole('button',{name:'只看列表',exact:true}).click();await page.locator('#case-results').screenshot({path:`${out}/${label}-list-${width}.png`});
  }
 }
}
await browser.close();
