import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.BASE_URL || 'http://127.0.0.1:4173/';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});
try {
  await page.goto(base+'index.html');
  assert(await page.getByRole('heading',{name:'2026 鳳山選戰',exact:true}).isVisible());
  assert.match(await page.locator('.campaign-entry-compact').innerText(),/勝選倒數/);
  assert.match(await page.locator('.campaign-entry-compact').innerText(),/10\/23/);
  assert.match(await page.locator('.campaign-entry-compact').innerText(),/11\/28/);
  assert.equal(await page.locator('.campaign-quick-grid').count(),0);
  const countdownColor=await page.locator('.campaign-entry-compact .campaign-kicker').evaluate(el=>getComputedStyle(el).color);
  assert.match(countdownColor,/255/);
  const account=await page.locator('.home-account').boundingBox();
  const contact=await page.locator('.home-contact').boundingBox();
  assert(account && contact && account.y < contact.y,'political donation must appear before contact');
  await page.goto(base+'election.html');
  assert(await page.getByRole('heading',{name:'2026 鳳山選戰',exact:true}).isVisible());
  assert.equal(await page.locator('.campaign-nav-grid').count(),0);
  assert.equal(await page.locator('#campaign-platforms,#campaign-tracking,#campaign-events').count(),0);
  for (const label of ['2026 政見 →','政績與服務 →','公開行程與活動 →']) assert(await page.getByRole('link',{name:label,exact:true}).isVisible());
  await page.goto(base+'activities.html');
  assert(await page.getByRole('heading',{name:'公開行程與活動',exact:true}).isVisible());
  console.log('Election compact public mode QA passed');
} finally { await browser.close(); }
