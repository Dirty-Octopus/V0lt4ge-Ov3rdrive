import { test, expect } from "@playwright/test";

const boot = async (page) => {
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 30_000 });
};

test("desktop menu, translated preferences and audio-synchronized complete combat flow", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await boot(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.locator("[data-open=settings]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#overlay")).toBeVisible();
  expect(await page.evaluate(() => window.__gameQA.mode)).toBe("menu");
  await page.locator("#dialog-back").click();
  await page.screenshot({ path: "test-results/menu-desktop.png" });
  await page.locator("[data-open=settings]:visible").click();
  await page.locator("[data-difficulty=hard]").click();
  await page.locator("#settings-lang").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("#menuMusic-volume").fill("42");
  await expect
    .poll(() =>
      page.evaluate(() => window.__gameQA.audio.debugState.volumes.menuMusic),
    )
    .toBe(0.42);
  await page.screenshot({ path: "test-results/settings-desktop.png" });
  await page.locator("#settings-lang").click();
  await page.locator("[data-difficulty=normal]").click();
  await page.locator("#dialog-back").click();
  await page.locator("#play").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
  const angle = await page.evaluate(() => window.__gameQA.game.player.angle);
  await page.keyboard.down("d");
  await page.waitForTimeout(250);
  await page.keyboard.up("d");
  expect(await page.evaluate(() => window.__gameQA.game.player.angle)).not.toBe(
    angle,
  );
  await page.keyboard.down("j");
  await page.waitForTimeout(250);
  await page.keyboard.up("j");
  expect(await page.evaluate(() => window.__gameQA.game.shots)).toBeGreaterThan(
    0,
  );
  await page.screenshot({ path: "test-results/game-desktop.png" });
  await page.keyboard.press("k");
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.ultimate?.phase))
    .toBe("charge");
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.player.hp))
    .toBe(100);
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.__gameQA.audio.debugState.contextState),
    )
    .toBe("suspended");
  const pauseTime = await page.evaluate(() => window.__gameQA.audio.now);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__gameQA.audio.now)).toBe(pauseTime);
  await page.locator("[data-open=settings]:visible").click();
  await expect(page.locator("[data-difficulty=normal]")).toBeDisabled();
  await page.locator("#dialog-back").click();
  await page.locator("#resume").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.ultimate?.phase), {
      timeout: 7000,
    })
    .toBe("explosion");
  await page.screenshot({ path: "test-results/ultimate-desktop.png" });
  const timing = await page.evaluate(
    () => window.__gameQA.audio.debugState.ultimate,
  );
  expect(timing.burstAt - timing.start).toBeGreaterThan(2);
  expect(timing.explosionAt - timing.burstAt).toBeCloseTo(0.5625, 3);
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.ultimate), {
      timeout: 7000,
    })
    .toBeNull();
  await page.evaluate(() => {
    const { game } = window.__gameQA;
    game.kills = 104;
    const enemy = {
      id: 999999,
      type: "drone",
      angle: game.player.angle,
      z: 0.5,
      hp: 1,
    };
    game.enemies.push(enemy);
    game._kill(enemy, false);
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__gameQA.audio.debugState.game.phase),
    )
    .toBe(5);
  const phases = await page.evaluate(
    () => window.__gameQA.audio.debugState.game.phaseStarts,
  );
  expect(new Set(phases).size).toBe(1);
  await page.evaluate(() => (window.__gameQA.game.player.hp = 0.001));
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("gameover");
  await page.screenshot({ path: "test-results/gameover-desktop.png" });
  await page.locator("#quit").click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.audio.debugState.transport))
    .toBe("menu");
  expect(errors).toEqual([]);
});

test("mobile layout, swipe and independent fire/ultimate buttons", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await boot(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({ path: "test-results/menu-mobile.png" });
  await page.locator("#play").tap();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
  const angle = await page.evaluate(() => window.__gameQA.game.player.angle);
  await page.mouse.move(110, 450);
  await page.mouse.down();
  await page.mouse.move(205, 450, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.player.angle))
    .not.toBe(angle);
  const fire = await page.locator("#touch-fire").boundingBox();
  await page.mouse.move(fire.x + fire.width / 2, fire.y + fire.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__gameQA.game.shots)).toBeGreaterThan(
    1,
  );
  await page.screenshot({ path: "test-results/game-mobile.png" });
  await page.locator("#touch-ultimate").tap();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.game.ultimate?.phase))
    .toBe("charge");
  await page.locator("#pause-button").tap();
  await page.locator("#quit").tap();
  await expect(page.locator("#menu")).toBeVisible();
  await context.close();
});
