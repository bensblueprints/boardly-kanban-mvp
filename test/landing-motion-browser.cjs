const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const { chromium } = require(
  process.env.BOARDLY_PLAYWRIGHT_MODULE ||
    "/home/ben/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);
(async () => {
  const app = express(),
    dist = path.resolve("dist");
  app.get("/", (req, res) =>
    res.sendFile(path.join(dist, "landing/index.html")),
  );
  app.use(express.static(dist));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base =
    process.env.BOARDLY_LANDING_VERIFY_ORIGIN ||
    `http://127.0.0.1:${server.address().port}`;
  const live = base.startsWith("https:");
  const output =
    process.env.BOARDLY_BROWSER_OUTPUT ||
    "/home/ben/.local/share/boardly-ops/motion-20260910";
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: live
      ? ["--host-resolver-rules=MAP boardlyagent.com 104.21.80.128"]
      : [],
  });
  const errors = [],
    missing = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const prefix = live ? "live" : "local";
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().startsWith(base) && r.status() >= 400)
      missing.push({ url: new URL(r.url()).pathname, status: r.status() });
  });
  const fits = async (width) =>
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `Page fits ${width}px`,
    );
  async function settle() {
    await page.waitForFunction(
      () => document.documentElement.dataset.marketingReady === "true",
    );
    await page.evaluate(() => document.fonts.ready);
  }
  async function shot(name) {
    await page.screenshot({ path: path.join(output, `${prefix}-${name}.png`) });
  }
  try {
    assert.equal((await page.goto(base)).status(), 200);
    await settle();
    assert.match(await page.title(), /Boardly/);
    assert.equal(
      await page.locator("link[rel=canonical]").getAttribute("href"),
      "https://boardlyagent.com/",
    );
    await page
      .locator(".hero-enter")
      .last()
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await fits(1440);
    await shot("hero-desktop");
    assert.ok(
      await page.evaluate(() =>
        document.getAnimations().some((a) => a.playState === "running"),
      ),
      "Motion is actually running",
    );
    await page.getByRole("tab", { name: "Companies", exact: true }).click();
    assert.equal(
      await page
        .getByRole("tab", { name: "Companies", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.locator("#preview-companies img").evaluate((i) => i.decode());
    await page
      .getByRole("tab", { name: "Companies", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page
        .getByRole("tab", { name: "Task details", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.locator("#preview-details img").evaluate((i) => i.decode());
    await page
      .getByRole("tab", { name: "Task details", exact: true })
      .press("Home");
    assert.equal(
      await page
        .getByRole("tab", { name: "Projects", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    for (const img of await page.locator("img").all()) {
      if (await img.isVisible()) await img.scrollIntoViewIfNeeded();
      await img.evaluate((i) =>
        Promise.race([
          i.decode(),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(Error("Image did not decode: " + i.getAttribute("src"))),
              10000,
            ),
          ),
        ]),
      );
    }
    const badAnchors = await page
      .locator('a[href^="#"]')
      .evaluateAll((as) =>
        as
          .filter((a) => !document.getElementById(a.hash.slice(1)))
          .map((a) => a.hash),
      );
    assert.deepEqual(badAnchors, []);
    assert.ok((await page.locator('a[href="/sign-up"]').count()) >= 3);
    assert.ok((await page.locator('a[href="/sign-in"]').count()) >= 2);
    assert.ok((await page.locator('a[href="/app"]').count()) >= 1);
    await page.locator("#features").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    assert.match(
      await page.locator(".ai-answer").innerText(),
      /launch checklist/,
    );
    await page.getByRole("button", { name: "Work", exact: true }).click();
    assert.match(await page.locator(".ai-answer").innerText(), /assignment/i);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.locator(".bento-grid").scrollIntoViewIfNeeded();
    await page.waitForTimeout(950);
    await shot("features-desktop");
    await page.locator("#apps").scrollIntoViewIfNeeded();
    await page.waitForTimeout(950);
    const icon = await page.locator(".window-logo").boundingBox();
    assert.ok(
      icon.width <= 21 && icon.height <= 21,
      "Window logo stays icon sized",
    );
    assert.ok(
      !/[×✕✖]/.test(await page.locator(".desktop-bar").innerText()),
      "No oversized window close decoration",
    );
    await shot("desktop-preview");
    await page.locator("#computers").scrollIntoViewIfNeeded();
    await page.waitForTimeout(950);
    await shot("computers-desktop");
    await page.locator("#free").scrollIntoViewIfNeeded();
    await page.waitForTimeout(950);
    await shot("free-desktop");
    const summary = page.locator(".faq summary").first();
    await summary.click();
    assert.equal(await summary.evaluate((e) => e.parentElement.open), true);
    await summary.press("Enter");
    assert.equal(await summary.evaluate((e) => e.parentElement.open), false);
    await page
      .getByRole("button", { name: "Pause motion", exact: true })
      .click();
    assert.equal(
      await page.locator("html").getAttribute("data-motion"),
      "paused",
    );
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      ),
      0,
      "Pause stops movement",
    );
    await page.reload();
    await settle();
    assert.equal(
      await page.locator("html").getAttribute("data-motion"),
      "paused",
      "Pause survives reload",
    );
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(width);
      await page.evaluate(() => scrollTo(0, 0));
      await shot("hero-" + width);
      await page.locator("#features").scrollIntoViewIfNeeded();
      await shot("features-" + width);
      await page.locator("#apps").scrollIntoViewIfNeeded();
      await shot("desktop-preview-" + width);
      await page.locator("#computers").scrollIntoViewIfNeeded();
      await shot("computers-" + width);
      await page.locator("#free").scrollIntoViewIfNeeded();
      await shot("free-" + width);
      const logo = await page.locator(".window-logo").boundingBox();
      assert.ok(logo.width <= 21 && logo.height <= 21);
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      assert.equal(await page.locator("#mobile-nav").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#mobile-nav").isVisible(), false);
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await page
        .locator("#mobile-nav")
        .getByRole("link", { name: "The workspace", exact: true })
        .click();
      assert.equal(await page.locator("#mobile-nav").isVisible(), false);
      await fits(width);
    }
    await page
      .getByRole("button", { name: "Resume motion", exact: true })
      .click();
    assert.equal(
      await page.locator("html").getAttribute("data-motion"),
      "enabled",
    );
    const reduced = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 390, height: 844 },
    });
    const rp = await reduced.newPage();
    await rp.goto(base);
    await rp.waitForFunction(
      () => document.documentElement.dataset.marketingReady === "true",
    );
    assert.equal(
      await rp.locator("html").getAttribute("data-motion"),
      "paused",
    );
    assert.equal(
      await rp.getByRole("button", { name: "Reduced motion on" }).isDisabled(),
      true,
    );
    assert.equal(
      await rp.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      ),
      0,
    );
    await rp.getByRole("tab", { name: "Companies", exact: true }).click();
    assert.equal(await rp.locator("#preview-companies").isVisible(), true);
    await reduced.close();
    const plain = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const np = await plain.newPage();
    await np.goto(base);
    assert.equal(await np.getByRole("heading", { level: 1 }).isVisible(), true);
    assert.equal(
      await np.locator('.hero-actions a[href="/sign-up"]').isVisible(),
      true,
    );
    assert.ok(await np.locator(".desktop-image").getAttribute("src"));
    await plain.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(missing, []);
    const report = {
      origin: base,
      motion: true,
      preview_tabs_and_keyboard: true,
      ai_modes: true,
      desktop_logo_max_px: 21,
      mobile_widths: [320, 390, 768],
      pause_persists: true,
      reduced_motion: true,
      no_js_content: true,
      links: true,
      javascript_errors: errors,
      missing_assets: missing,
    };
    fs.writeFileSync(
      path.join(output, `${prefix}-verification.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    await shot("failure").catch(() => {});
    console.error(e.message);
    console.error(
      JSON.stringify({
        errors,
        missing,
        layout: await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll("body *")]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.right > innerWidth + 1 || r.left < -1;
            })
            .slice(0, 18)
            .map((e) => ({
              tag: e.tagName,
              cls: e.className,
              rect: {
                x: e.getBoundingClientRect().x,
                w: e.getBoundingClientRect().width,
              },
              overflow: getComputedStyle(e).overflow,
            })),
        })),
      }),
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})();
