import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5188';
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
const needLogin = await page.locator('#loginEmail').isVisible().catch(() => false);
if (needLogin) {
  await page.fill('#loginEmail', 'admin@goodjob.com');
  await page.fill('#loginPassword', 'goodjob123');
  await page.click('#loginButton');
  await page.waitForSelector('#dashboard', { state: 'visible', timeout: 15000 }).catch(() => {});
}
await page.waitForTimeout(700);

async function readState(label) {
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const sidebar = document.querySelector('.sidebar');
    const navBg = sidebar ? getComputedStyle(sidebar).backgroundColor : '';
    const theme = document.documentElement.dataset.theme;
    const brand = cs.getPropertyValue('--brand').trim();
    const nav = cs.getPropertyValue('--nav').trim();
    const tint = cs.getPropertyValue('--brand-tint').trim();
    let hsColor = '';
    const hs = document.querySelector('.pc-hs');
    if (hs) hsColor = getComputedStyle(hs).color;
    let btnBg = '';
    const av = document.querySelector('.view.active');
    const btn = av && (av.querySelector('.btn.primary') || av.querySelector('.btn-primary'));
    if (btn) btnBg = getComputedStyle(btn).backgroundColor;
    return { theme, brand, nav, tint, navBg, hsColor, btnBg };
  });
  console.log(label, JSON.stringify(s));
}
async function go(v) {
  await page.evaluate((x) => document.querySelector(`[data-view="${x}"]`)?.click(), v);
  await page.waitForTimeout(700);
}
async function pickPreset(id) {
  await page.evaluate((x) => document.querySelector(`[data-theme-pick="${x}"]`)?.click(), id);
  await page.waitForTimeout(400);
}
async function setCustom(hex) {
  await page.evaluate((h) => {
    const el = document.querySelector('#themeCustomColor');
    el.value = h;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, hex);
  await page.waitForTimeout(400);
}

await go('products'); await readState('DEFAULT(ocean)');
await go('theme'); await pickPreset('indigo');
await go('products'); await readState('INDIGO 预设');
await go('theme'); await setCustom('#ffff00');
await go('products'); await readState('CUSTOM #ffff00(浅黄→应自动加深)');
await go('theme'); await setCustom('#be123c');
await go('products'); await readState('CUSTOM #be123c');
await go('theme'); await pickPreset('rose');
await go('products'); await readState('ROSE 预设');
await go('theme'); await pickPreset('ocean');
await go('products'); await readState('OCEAN 恢复');

await browser.close();
