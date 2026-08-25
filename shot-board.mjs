import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5188';
const OUT = '/tmp/crm-shot';

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
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
  await page.waitForTimeout(900);
}
function log(...a) { console.log(...a); }

// 进入客户视图
await go('customers');
await page.waitForSelector('#customerViewModeSelect', { timeout: 8000 });

// 切到三栏看板
await page.evaluate(() => {
  const sel = document.querySelector('#customerViewModeSelect');
  sel.value = 'board';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(900);

// 读取看板结构(列名/数量/卡片数/标准行)
const boardInfo = await page.evaluate(() => {
  const cols = Array.from(document.querySelectorAll('.customer-board-col')).map((col) => {
    const title = col.querySelector('.col-title')?.textContent?.trim();
    const count = col.querySelector('.col-count')?.textContent?.trim();
    const cards = Array.from(col.querySelectorAll('.customer-board-card'));
    const firstStandard = cards[0]?.querySelector('.standard-row .value')?.textContent?.trim() || '';
    return { title, count, cards: cards.length, firstStandard };
  });
  return {
    boardVisible: !document.querySelector('#customerBoardWorkspace')?.classList.contains('is-hidden'),
    listHidden: document.querySelector('#customerListWorkspace')?.classList.contains('is-hidden'),
    cols
  };
});
log('BOARD:', JSON.stringify(boardInfo, null, 2));

await page.screenshot({ path: `${OUT}/board-view.png` });
log('shot board-view');

// 点击第一张卡片 -> 抽屉 -> 验证 标准 行
await page.evaluate(() => document.querySelector('.customer-board-card')?.click());
await page.waitForTimeout(900);
const drawerInfo = await page.evaluate(() => {
  const open = document.querySelector('#customerDrawer')?.classList.contains('open');
  const labels = Array.from(document.querySelectorAll('#customerDrawer .info-grid .info span')).map(s => s.textContent.trim());
  const hasStandard = labels.includes('客户标准');
  const standardVal = Array.from(document.querySelectorAll('#customerDrawer .info-grid .info'))
    .find(i => i.querySelector('span')?.textContent.trim() === '客户标准')?.querySelector('b')?.textContent.trim() || '';
  return { open, labels, hasStandard, standardVal };
});
log('DRAWER:', JSON.stringify(drawerInfo, null, 2));

await page.screenshot({ path: `${OUT}/board-drawer.png` });
log('shot board-drawer');

console.log('ERRORS:', errors.slice(0, 6).join(' | ') || 'none');
await browser.close();
