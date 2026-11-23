import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = (process.env.ETI_BROWSER_BASE_URL || "https://elite-trading-intelligence-eti.cintexatechnologies.workers.dev").replace(/\/$/, "");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const failures = [];
try {
  for (const profile of [
    { name: "desktop", viewport: { width: 1440, height: 960 } },
    { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  ]) {
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: !!profile.isMobile, hasTouch: !!profile.hasTouch, deviceScaleFactor: profile.isMobile ? 2 : 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const response = await page.goto(base + "/terminal", { waitUntil: "domcontentloaded", timeout: 60000 });
    assert.ok(response && response.status() === 200, profile.name + ": terminal route must return HTTP 200");
    await page.waitForSelector("#tt-chart", { timeout: 20000 });
    await page.waitForSelector("#tt-candle-width", { timeout: 20000 });
    await page.waitForTimeout(1800);

    const initial = await page.evaluate(() => {
      const chart = document.querySelector("#tt-chart");
      const card = document.querySelector(".tt-chart-card");
      const controls = document.querySelector(".tt-chart-controls");
      return {
        chartWidth: chart.getBoundingClientRect().width,
        chartHeight: chart.getBoundingClientRect().height,
        cardWidth: card.getBoundingClientRect().width,
        controlsWidth: controls.getBoundingClientRect().width,
        controlsScrollWidth: controls.scrollWidth,
        canvasCount: chart.querySelectorAll("canvas").length,
        bodyWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth
      };
    });
    assert.ok(initial.chartWidth > 250, profile.name + ": chart should have a visible width");
    assert.ok(initial.chartWidth <= initial.cardWidth + 1, profile.name + ": chart must fit inside its parent card");
    assert.ok(initial.chartHeight >= 260, profile.name + ": chart height must be responsive and visible");
    assert.ok(initial.canvasCount >= 1, profile.name + ": chart renderer must create a canvas");
    assert.ok(initial.controlsScrollWidth <= initial.controlsWidth + 2, profile.name + ": chart controls must not overflow horizontally");

    await page.locator("#tt-candle-width").evaluate(el => { el.value = "300"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.locator("#tt-candle-width-value").textContent(), "300px", profile.name + ": 300px candle width control");
    await page.locator("#tt-candle-height").evaluate(el => { el.value = "210"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.locator("#tt-volume-height").evaluate(el => { el.value = "180"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const adjusted = await page.locator("#tt-chart").evaluate(el => ({ height: el.getBoundingClientRect().height, inlineHeight: el.style.height }));
    assert.equal(adjusted.inlineHeight, "460px", profile.name + ": chart height follows candle and volume pane controls");
    assert.ok(adjusted.height >= 460, profile.name + ": adjusted chart height is applied to the rendered surface");

    await page.locator("#tt-candle-width").evaluate(el => { el.value = "20"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.locator("#tt-zoom-in").click();
    assert.equal(await page.locator("#tt-candle-width-value").textContent(), "25px", profile.name + ": zoom-in increases candle spacing");
    await page.locator("#tt-zoom-out").click();
    assert.equal(await page.locator("#tt-candle-width-value").textContent(), "20px", profile.name + ": zoom-out restores candle spacing");
    await page.locator("#tt-chart").hover();
    await page.mouse.wheel(0, -360);
    await page.waitForTimeout(150);
    assert.deepEqual(pageErrors, [], profile.name + ": no uncaught browser JavaScript errors");

    await page.screenshot({ path: "/tmp/eti-terminal-" + profile.name + ".png", fullPage: false });
    console.log(JSON.stringify({ profile: profile.name, initial, adjusted, result: "PASS" }));
    await context.close();
  }

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const home = await desktop.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  assert.ok(home && home.status() === 200, "dashboard route must return HTTP 200");
  await desktop.waitForSelector("#stack", { timeout: 20000 });
  const dashboard = await desktop.evaluate(() => {
    const stack = document.querySelector("#stack");
    const parent = stack.parentElement;
    const frame = document.querySelector("#liveChartFrame");
    return {
      stackWidth: stack.getBoundingClientRect().width,
      parentWidth: parent.getBoundingClientRect().width,
      frameHeight: frame.getBoundingClientRect().height,
      scrollable: stack.scrollWidth >= stack.clientWidth
    };
  });
  assert.ok(dashboard.stackWidth <= dashboard.parentWidth + 1, "dashboard chart viewport must fit its parent container");
  assert.ok(dashboard.frameHeight >= 340, "dashboard chart frame must retain a usable height");
  console.log(JSON.stringify({ profile: "dashboard", dashboard, result: "PASS" }));
  await desktop.close();
} catch (error) {
  failures.push(error.stack || error.message);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
