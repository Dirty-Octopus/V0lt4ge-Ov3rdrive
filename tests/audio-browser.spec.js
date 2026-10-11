import { test, expect } from "@playwright/test";

test("first gesture during asset loading starts menu audio when decoding finishes", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/audio/phase5.flac", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/?qa=1");
  await page.locator("#audio-toggle").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__gameQA.audio.debugState.contextState),
    )
    .toBe("running");
  expect(await page.evaluate(() => window.__gameQA.audio.ready)).toBe(false);
  release();
  await expect(page.locator("#play")).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.audio.debugState.transport))
    .toBe("menu");
  const menu = await page.evaluate(() => window.__gameQA.audio.debugState.menu);
  expect(menu.loopAt - menu.startedAt).toBeCloseTo(0.6, 6);
});

test("interacting after a failed asset request cannot suppress music on retry", async ({
  page,
}) => {
  let failedOnce = false;
  await page.route("**/audio/phase3.flac", async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 503,
        body: "Temporary audio test failure",
      });
    } else await route.continue();
  });
  await page.goto("/?qa=1");
  await expect(page.locator("#load-label")).toContainText("重试");
  await expect(page.locator("#play")).toBeDisabled();
  await page.locator("[data-open=settings]").click();
  await page.locator("#dialog-back").click();
  expect(
    await page.evaluate(() => window.__gameQA.audio.debugState.transport),
  ).toBe("idle");
  await page.locator("#load-label").click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.audio.debugState.transport))
    .toBe("menu");
  expect(
    await page.evaluate(() => window.__gameQA.audio.debugState.loadedAssets),
  ).toBe(20);
});

test("paused settings keep UI audio live, and returning then restarting creates one game transport", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
  await page.keyboard.press("k");
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.ultimate?.phase))
    .toBe("charge");
  await page.locator("#pause-button").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__gameQA.audio.debugState.contextState),
    )
    .toBe("suspended");
  const before = await page.evaluate(() => ({
    main: window.__gameQA.audio.now,
    ui: window.__gameQA.audio.uiContext.currentTime,
  }));
  await page.locator("#overlay [data-open=settings]").click();
  await page.locator("#menuMusic-volume").fill("28");
  await page.locator("#sfx-volume").fill("61");
  await page.locator("#settings-lang").click();
  const during = await page.evaluate(() => ({
    state: window.__gameQA.audio.debugState,
    ui: window.__gameQA.audio.uiContext.currentTime,
  }));
  expect(during.state.now).toBe(before.main);
  expect(during.ui).toBeGreaterThan(before.ui);
  expect(during.state.volumes).toEqual({
    menuMusic: 0.28,
    gameMusic: 0.5,
    sfx: 0.61,
  });
  await page.locator("#dialog-back").click();
  await page.locator("#quit").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.audio.debugState.transport))
    .toBe("menu");
  expect(
    await page.evaluate(() => window.__gameQA.audio.debugState.game),
  ).toBeNull();
  expect(
    await page.evaluate(() => window.__gameQA.audio.debugState.contextState),
  ).toBe("running");
  const starts = await page.evaluate(async () => {
    const audio = window.__gameQA.audio;
    const original = audio.startGame.bind(audio);
    let calls = 0;
    audio.startGame = () => {
      calls += 1;
      return original();
    };
    await Promise.all([window.__gameQA.startRun(), window.__gameQA.startRun()]);
    return calls;
  });
  expect(starts).toBe(1);
  expect(await page.evaluate(() => window.__gameQA.game.ultimate)).toBeNull();
  expect(errors).toEqual([]);
});
