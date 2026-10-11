import { test, expect } from "@playwright/test";

const boot = async (page) => {
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 30_000 });
};

async function expectDialog(page, kind) {
  const dialog = page.locator("#overlay");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-kind", kind);
  const buttons = dialog.locator("button");
  expect(await buttons.count()).toBeGreaterThan(0);
  expect(
    await buttons.evaluateAll((controls) =>
      controls.filter((control) => !control.classList.contains("comic-control"))
        .map((control) => control.id || control.textContent.trim()),
    ),
    `Every ${kind} action should share the comic control treatment`,
  ).toEqual([]);
  // Wait for entrance/page transitions, not the intentionally repeating ink.
  await expect.poll(() => dialog.evaluate((element) =>
    element.getAnimations({ subtree: true }).filter((animation) =>
      animation.playState === "running" &&
      !animation.animationName?.startsWith("selection-"),
    ).length,
  )).toBe(0);
}

async function expectReachableBack(page, selector = "#dialog-back") {
  const back = page.locator(selector);
  await back.scrollIntoViewIfNeeded();
  await expect(back).toBeInViewport({ ratio: 0.95 });
  return back;
}

async function expectNoHorizontalOverflow(page) {
  const geometry = await page.locator("#overlay").evaluate((dialog) => {
    const content = dialog.querySelector("#dialog-content");
    const sheet = dialog.querySelector(".dialog-sheet");
    const box = dialog.getBoundingClientRect();
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      // The outer paper underprint intentionally extends a few pixels; the
      // inner sheet is the actual scroll container and must never pan sideways.
      sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
      contentOverflow: content.scrollWidth - content.clientWidth,
      left: box.left,
      right: box.right,
    };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.sheetOverflow).toBeLessThanOrEqual(1);
  expect(geometry.contentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
}

async function expectFocusVisible(control) {
  await expect(control).toBeFocused();
  const indicator = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      shadow: style.boxShadow !== "none",
    };
  });
  expect(indicator.visible).toBe(true);
  expect(indicator.outline || indicator.shadow).toBe(true);
}

async function inspectSelection(control) {
  await expect.poll(() => control.evaluate((element) =>
    element.getAnimations({ subtree: true })
      .filter((animation) => animation.animationName?.startsWith("selection-")).length,
  )).toBe(2);
  const clocks = await control.evaluate((element) =>
    element.getAnimations({ subtree: true })
      .filter((animation) => animation.animationName?.startsWith("selection-"))
      .map((animation) => ({
        start: animation.startTime,
        delay: animation.effect.getTiming().delay,
        duration: animation.effect.getTiming().duration,
        offsets: animation.effect.getKeyframes().map((frame) => frame.computedOffset),
      })),
  );
  expect(clocks[0]).toEqual(clocks[1]);
  expect(clocks[0].duration).toBe(1120);
  expect(clocks[0].delay).toBe(0);
  expect(clocks[0].offsets).toEqual([0, 0.2, 0.42, 0.64, 0.83, 1]);
  const sample = (time) => control.evaluate((element, time) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      if (!animation.animationName?.startsWith("selection-")) continue;
      animation.pause();
      animation.currentTime = time;
    }
    const front = getComputedStyle(element, "::before");
    const back = getComputedStyle(element, "::after");
    const box = element.getBoundingClientRect();
    return {
      front: { shape: front.clipPath, transform: front.transform },
      back: { shape: back.clipPath, transform: back.transform },
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  }, time);
  const first = await sample(0);
  const second = await sample(300);
  expect(first.front.shape).not.toBe(first.back.shape);
  expect(second.front.shape).not.toBe(second.back.shape);
  expect(second.front.shape).not.toBe(first.front.shape);
  expect(second.front.transform).not.toBe(first.front.transform);
  expect(second.back.shape).not.toBe(first.back.shape);
  expect(second.back.transform).not.toBe(first.back.transform);
  expect(second.box).toEqual(first.box);
  return first.box;
}

test("desktop secondary pages share accessible controls and stable synchronized selection ink", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  for (const kind of ["settings", "guide", "records"]) {
    await page.locator(`.main-nav [data-open=${kind}]`).click();
    await expectDialog(page, kind);
    await expectNoHorizontalOverflow(page);
    if (kind === "settings") {
      const back = await expectReachableBack(page);
      // A real Tab establishes keyboard modality; programmatic focus directly
      // after opening with a mouse correctly does not imply :focus-visible.
      await page.locator("#reduce-motion").focus();
      await page.keyboard.press("Tab");
      await expect(back).toBeFocused();
      const focusedBox = await inspectSelection(back);
      await back.evaluate((element) => element.blur());
      await page.mouse.move(0, 0);
      await back.hover();
      const hoveredBox = await inspectSelection(back);
      expect(hoveredBox).toEqual(focusedBox);

      await page.locator("[data-difficulty=hard]").focus();
      await page.keyboard.press("Tab");
      await expectFocusVisible(page.locator("#menuMusic-volume"));
      await page.locator("#settings-lang").focus();
      await page.keyboard.press("Tab");
      await expectFocusVisible(page.locator("#reduce-motion"));
      await page.screenshot({ path: testInfo.outputPath("dialog-settings-desktop.png") });
    }
    await (await expectReachableBack(page)).click();
    await expect(page.locator("#overlay")).not.toBeVisible();
  }

  await page.locator("#play").click();
  await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
  await page.keyboard.press("Escape");
  await expectDialog(page, "pause");
  await page.locator("#overlay [data-open=settings]").click();
  await expectDialog(page, "settings");
  await expect(page.locator("[data-difficulty=normal]")).toBeDisabled();
  await (await expectReachableBack(page)).click();
  await expectDialog(page, "pause");
  await page.locator("#resume").click();
  await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
  await page.evaluate(() => { window.__gameQA.game.player.hp = 0.001; });
  await expectDialog(page, "gameover");
  await expectNoHorizontalOverflow(page);
  await page.locator("#retry").click();
  await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
  await page.evaluate(() => { window.__gameQA.game.player.hp = 0.001; });
  await expectDialog(page, "gameover");
  await (await expectReachableBack(page, "#quit")).click();
  await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("menu");
  expect(errors).toEqual([]);
});

test("390px Chinese and English dialogs fit, return actions remain reachable, and language changes retain controls", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await boot(page);
    for (const language of ["zh", "en"]) {
      if (language === "en") {
        await page.locator(".main-nav [data-open=settings]").tap();
        await expectDialog(page, "settings");
        await page.locator("#settings-lang").tap();
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        // Exercise real handlers while/after the ASCII overlay settles.
        await page.locator("#menuMusic-volume").fill("43");
        await expect.poll(() => page.evaluate(() => window.__gameQA.audio.debugState.volumes.menuMusic)).toBe(0.43);
        await page.locator("[data-difficulty=hard]").tap();
        await expect.poll(() => page.evaluate(() => window.__gameQA.prefs.difficulty)).toBe("hard");
        await (await expectReachableBack(page)).tap();
      }
      for (const kind of ["settings", "guide", "records"]) {
        await page.locator(`.main-nav [data-open=${kind}]`).tap();
        await expectDialog(page, kind);
        await expect(page.locator("#app")).not.toHaveAttribute("data-text-scramble-active", "true");
        await expectNoHorizontalOverflow(page);
        const back = await expectReachableBack(page);
        if (kind === "settings")
          await page.screenshot({ path: testInfo.outputPath(`dialog-settings-mobile-${language}.png`) });
        await back.tap();
        await expect(page.locator("#overlay")).not.toBeVisible();
      }
      await page.locator("#play").tap();
      await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
      await page.locator("#pause-button").tap();
      await expectDialog(page, "pause");
      await expectNoHorizontalOverflow(page);
      await expectReachableBack(page, "#quit");
      await page.locator("#resume").tap();
      await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
      await page.evaluate(() => { window.__gameQA.game.player.hp = 0.001; });
      await expectDialog(page, "gameover");
      await expectNoHorizontalOverflow(page);
      await (await expectReachableBack(page, "#quit")).tap();
      await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("menu");
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("reduced-motion dialogs keep their controls and language switch without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);
  for (const kind of ["settings", "guide", "records"]) {
    await page.locator(`.main-nav [data-open=${kind}]`).click();
    await expectDialog(page, kind);
    if (kind === "settings") {
      await page.locator("#settings-lang").click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("#app")).not.toHaveAttribute("data-text-scramble-active", "true");
      await expect(page.locator(".scramble-code")).toHaveCount(0);
      await page.locator("#gameMusic-volume").fill("33");
      await expect.poll(() => page.evaluate(() => window.__gameQA.audio.debugState.volumes.gameMusic)).toBe(0.33);
    }
    await expectNoHorizontalOverflow(page);
    const back = await expectReachableBack(page);
    await back.focus();
    await back.hover();
    expect(await page.locator("#overlay").evaluate((dialog) =>
      dialog.getAnimations({ subtree: true }).length,
    )).toBe(0);
    await back.click();
    await expect(page.locator("#overlay")).not.toBeVisible();
  }
});
