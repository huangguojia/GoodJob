import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5188';
const OUT = '/tmp/crm-shot';

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
const needLogin = await page.locator('#loginEmail').isVisible().catch(() => false);
if (needLogin) {
  await page.fill('#loginEmail', 'admin@goodjob.com');
  await page.fill('#loginPassword', 'goodjob123');
  await page.click('#loginButton');
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 }).catch(() => {});
}
await page.waitForTimeout(700);

async function go(view) {
  await page.evaluate((v) => document.querySelector(`[data-view="${v}"]`)?.click(), view);
  await page.waitForTimeout(800);
}
async function shot(name, clip) {
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: clip || undefined, fullPage: !clip });
  console.log('shot', name);
}

// 1) 换肤界面
await go('theme');
await shot('theme-view');

// 2) 选 indigo 预设 -> 看 products / shipments 联动
await page.evaluate(() => document.querySelector('[data-theme-pick="indigo"]')?.click());
await page.waitForTimeout(500);
await go('products');
await shot('products-indigo', { x: 0, y: 0, width: 1440, height: 780 });
await go('shipments');
await shot('shipments-indigo', { x: 0, y: 0, width: 1440, height: 780 });
await go('dashboard');
await shot('dashboard-indigo', { x: 0, y: 0, width: 1440, height: 780 });

// 3) 恢复 ocean
await go('theme');
await page.evaluate(() => document.querySelector('[data-theme-pick="ocean"]')?.click());
await page.waitForTimeout(500);
await go('products');
await shot('products-ocean', { x: 0, y: 0, width: 1440, height: 780 });

// 4) 自定义主色 #be123c
await go('theme');
await page.evaluate(() => {
  const el = document.querySelector('#themeCustomColor');
  el.value = '#be123c';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
await go('products');
await shot('products-custom', { x: 0, y: 0, width: 1440, height: 780 });
await go('shipments');
await shot('shipments-custom', { x: 0, y: 0, width: 1440, height: 780 });

// 5) 验证后端 PATCH /api/profile/theme
const patch = await page.evaluate(async () => {
  const m = document.cookie.match(/gj_csrf=([^;]+)/);
  const csrf = m ? decodeURIComponent(m[1]) : '';
  const r = await fetch('/api/profile/theme', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ theme: 'indigo' }),
    credentials: 'same-origin'
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
});
console.log('PATCH /api/profile/theme ->', JSON.stringify(patch));

// 6) 恢复默认并保存
await page.evaluate(async () => {
  const m = document.cookie.match(/gj_csrf=([^;]+)/);
  const csrf = m ? decodeURIComponent(m[1]) : '';
  await fetch('/api/profile/theme', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ theme: 'ocean' }), credentials: 'same-origin' });
});

console.log('ERRORS:', errors.slice(0, 6).join(' | ') || 'none');
await browser.close();
