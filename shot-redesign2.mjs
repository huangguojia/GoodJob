import { chromium } from "playwright";

const BASE = "http://localhost:5188";
const OUT = "/tmp/crm-shot";

const browser = await chromium.launch({
  channel: "chrome",
  proxy: { server: "direct://" },
  args: ["--no-proxy-server"],
});
const ctx = await browser.newContext({
  viewport: { width: 1480, height: 940 },
  ignoreHTTPSErrors: true,
});
const p = await ctx.newPage();
p.on("console", () => {});
p.on("pageerror", () => {});

await p.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

// Login
await p.fill("#loginEmail", "admin@goodjob.com").catch(() => {});
await p.fill("#loginPassword", "goodjob123").catch(() => {});
await p.click("#loginButton").catch(() => {});
await p.waitForTimeout(3000);

async function gotoView(viewName, file) {
  // Use internal router function instead of clicking hidden nav buttons
  const ok = await p.evaluate((v) => {
    try {
      // Try the global activateNavView if available
      if (typeof window.activateNavView === 'function') {
        window.activateNavView(v);
        return true;
      }
      // Fallback: find and click the nav button
      const btn = document.querySelector(`button[data-view="${v}"]`);
      if (btn) { btn.scrollIntoView(); btn.click(); return true; }
      return false;
    } catch(e) { return false; }
  }, viewName);
  console.log("gotoView", viewName, ok ? "OK" : "FAIL");
  await p.waitForTimeout(2000);
  await p.screenshot({ path: `${OUT}/${file}`, fullPage: false });
}

await gotoView("products", "redesign-products-v2.png");
await gotoView("shipments", "redesign-shipments-v2.png");

await browser.close();
