import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5188';
const OUT = '/tmp/crm-shot';

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: 'networkidle' });

// login if needed
const needLogin = await page.locator('#loginEmail').isVisible().catch(() => false);
if (needLogin) {
  await page.fill('#loginEmail', 'admin@goodjob.com');
  await page.fill('#loginPassword', 'goodjob123');
  await page.click('#loginButton');
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 }).catch(() => {});
}

async function activate(view) {
  await page.evaluate((v) => {
    const el = document.querySelector(`[data-view="${v}"]`);
    if (el) el.click();
  }, view);
  await page.waitForTimeout(900);
}

async function shotTop(name, clip) {
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: clip || undefined, fullPage: !clip });
  console.log('shot', name);
}

// dashboard (default)
await page.waitForTimeout(600);
await shotTop('top-dashboard', { x: 0, y: 0, width: 1440, height: 760 });

await activate('products');
await shotTop('top-products', { x: 0, y: 0, width: 1440, height: 760 });
await shotTop('full-products');

await activate('shipments');
await shotTop('top-shipments', { x: 0, y: 0, width: 1440, height: 760 });
await shotTop('full-shipments');

console.log('ERRORS:', errors.slice(0, 10).join(' | ') || 'none');
await browser.close();
