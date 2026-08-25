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
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));

await p.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

// Login
await p.fill("#loginEmail", "admin@goodjob.com").catch(() => {});
await p.fill("#loginPassword", "goodjob123").catch(() => {});
await p.click("#loginButton").catch(() => {});
await p.waitForTimeout(2500);

async function shot(view, file) {
  await p.click(`button[data-view="${view}"]`).catch((e) => console.log("click fail", view, e.message));
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `${OUT}/${file}`, fullPage: false });
  console.log("shot", view, "->", file);
}

await shot("products", "redesign-products.png");
await shot("shipments", "redesign-shipments.png");

// Also capture the whole shell (sidebar + a view) for context
await p.click('button[data-view="shipments"]').catch(() => {});
await p.waitForTimeout(1200);
await p.screenshot({ path: `${OUT}/redesign-shell.png`, fullPage: false });

console.log("CONSOLE_ERRORS:", JSON.stringify(errs.slice(0, 8)));
await browser.close();
