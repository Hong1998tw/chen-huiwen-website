import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const out='artifacts/astra-redesign/screenshots';await mkdir(out,{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage();
for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:960});for(const route of ['index.html','achievements.html','achievement-metro-green-line.html','service.html','news.html','petition.html','explore.html','404.html']){await page.goto('http://127.0.0.1:8766/'+route);await page.waitForTimeout(350);await page.screenshot({path:`${out}/baseline-${route.replace('.html','')}-${width}.png`,fullPage:false});}}
await browser.close();
