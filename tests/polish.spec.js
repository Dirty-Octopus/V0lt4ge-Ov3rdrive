import { test, expect, chromium } from "@playwright/test";

test("independent menu/game defaults, legacy settings migration, persistence and plain copy", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("test-seeded")) {
      localStorage.setItem(
        "voltage-save",
        JSON.stringify({ prefs: { music: 0.12, sfx: 0.64, lang: "zh" } }),
      );
      localStorage.setItem("test-seeded", "1");
    }
  });
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("[data-open=settings]").click();
  await expect(page.locator("#menuMusic-volume")).toHaveValue("70");
  await expect(page.locator("#gameMusic-volume")).toHaveValue("50");
  await expect(page.locator("#sfx-volume")).toHaveValue("64");
  await page.locator("#menuMusic-volume").fill("31");
  await page.locator("#gameMusic-volume").fill("22");
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.audio.debugState.volumes))
    .toEqual({ menuMusic: 0.31, gameMusic: 0.22, sfx: 0.64 });
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("[data-open=settings]").click();
  await expect(page.locator("#menuMusic-volume")).toHaveValue("31");
  await expect(page.locator("#gameMusic-volume")).toHaveValue("22");
  await page.screenshot({ path: "test-results/split-volumes.png" });
  await page.locator("#dialog-back").click();
  await expect(page.locator(".tagline")).toHaveCount(0);
  await expect(page.locator(".hero-art-label")).toHaveCount(0);
  await page.locator("#play").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
  await page.keyboard.press("Escape");
  await expect(page.locator("#dialog-content h2")).toHaveText("已暂停");
  await expect(page.locator(".dialog-lead")).toHaveCount(0);
});

for (const allowed of [true, false])
  test(`menu autoplay ${allowed ? "starts when browser permits" : "waits for a real keypress when blocked"}`, async () => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: [
        `--autoplay-policy=${allowed ? "no-user-gesture-required" : "document-user-activation-required"}`,
        ...(allowed
          ? []
          : [
              "--disable-features=AutoplayIgnoreWebAudio,MediaEngagementBypassAutoplayPolicies,PreloadMediaEngagementData",
            ]),
      ],
    });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      // Playwright locator assertions and page.evaluate use userGesture:true.
      // Reading readiness through either can unlock audio before this test's keypress.
      const observe = async () => {
        const { result, exceptionDetails } = await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
          const audio=window.__gameQA?.audio;
          return {
            ready:Boolean(audio?.ready),
            buttonReady:document.querySelector('#play')?.disabled===false,
            hasBeenActive:navigator.userActivation.hasBeenActive,
            audio:audio?.debugState
          };
        })()`,
            returnByValue: true,
            userGesture: false,
          },
        );
        if (exceptionDetails) throw new Error(exceptionDetails.text);
        return result.value;
      };
      await page.goto("http://localhost:5173/?qa=1");
      await expect
        .poll(async () => {
          const state = await observe();
          return state.ready && state.buttonReady;
        })
        .toBe(true);
      expect((await observe()).hasBeenActive).toBe(false);
      if (!allowed) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const blocked = await observe();
        expect(blocked.hasBeenActive).toBe(false);
        expect(blocked.audio.transport).toBe("idle");
        expect(blocked.audio.contextState).toBe("suspended");
        expect(blocked.audio.uiContextState).toBe("suspended");
        await page.keyboard.press("a");
      }
      await expect
        .poll(async () => (await observe()).audio?.transport)
        .toBe("menu");
      const state = await observe();
      expect(state.hasBeenActive).toBe(!allowed);
      expect(state.audio.contextState).toBe("running");
      expect(state.audio.uiContextState).toBe("running");
      expect(state.audio.menu.loopAt - state.audio.menu.startedAt).toBeCloseTo(
        0.6,
        6,
      );
    } finally {
      await browser.close();
    }
  });

test("only numeral cube faces rotate to letters and reduced motion stays static", async ({
  page,
}) => {
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#game-logo").evaluate((logo) => {
    for (const animation of logo.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 1180;
    }
  });
  await page.screenshot({ path: "test-results/logo-mid.png" });
  const titlePose = await page.locator("#game-logo").evaluate((logo) => ({
    letter: logo.querySelector(".logo-letter").getBoundingClientRect().toJSON(),
    plate: getComputedStyle(logo, "::before").clipPath,
    publisherAnimations: document.querySelector(".publisher").getAnimations()
      .length,
  }));
  expect(titlePose.publisherAnimations).toBe(0);
  const midFocus = await page
    .locator(".cube-vertical .cube-glyph")
    .evaluateAll((faces) =>
      faces.map((face) =>
        Number.parseFloat(
          getComputedStyle(face).filter.match(/blur\(([^p]+)/)[1],
        ),
      ),
    );
  expect(midFocus[0]).toBeGreaterThan(0);
  expect(midFocus[1]).toBeGreaterThan(0);
  await page.locator("#game-logo").evaluate((logo) => {
    for (const animation of logo.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 2600;
    }
  });
  await page.screenshot({ path: "test-results/logo-final.png" });
  const nextTitlePose = await page.locator("#game-logo").evaluate((logo) => ({
    letter: logo.querySelector(".logo-letter").getBoundingClientRect().toJSON(),
    plate: getComputedStyle(logo, "::before").clipPath,
  }));
  expect(nextTitlePose.letter).toEqual(titlePose.letter);
  expect(nextTitlePose.plate).not.toBe(titlePose.plate);
  const finalFocus = await page
    .locator(".cube-vertical .cube-glyph")
    .evaluateAll((faces) =>
      faces.map((face) =>
        Number.parseFloat(
          getComputedStyle(face).filter.match(/blur\(([^p]+)/)[1],
        ),
      ),
    );
  expect(finalFocus[0]).toBeGreaterThan(midFocus[0]);
  expect(finalFocus[1]).toBe(0);
  await expect(page.locator(".cube-vertical .cube-alternate")).toHaveText("A");
  await expect(page.locator(".cube-horizontal .cube-alternate")).toHaveText(
    "E",
  );
  expect(
    await page
      .locator("#game-logo")
      .evaluate(
        (logo) =>
          [...logo.querySelectorAll(".cube-rotor")].flatMap((rotor) =>
            rotor.getAnimations(),
          ).length,
      ),
  ).toBe(2);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled();
  expect(
    await page
      .locator("#game-logo")
      .evaluate((logo) => logo.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await page.screenshot({ path: "test-results/logo-reduced.png" });
});

test("menu selection cuts between silhouettes without moving the hit target", async ({
  page,
}) => {
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled();
  const button = page.locator(".main-nav [data-open=settings]");
  await button.focus();
  await page.waitForTimeout(100);
  const clocks = await button.evaluate((button) =>
    button
      .getAnimations({ subtree: true })
      .filter((animation) => animation.animationName.startsWith("selection-"))
      .map((animation) => ({
        start: animation.startTime,
        delay: animation.effect.getTiming().delay,
        offsets: animation.effect.getKeyframes().map((frame) => frame.offset),
      })),
  );
  expect(clocks).toHaveLength(2);
  expect(clocks[0]).toEqual(clocks[1]);
  const sample = async (time) =>
    button.evaluate((button, time) => {
      for (const animation of button.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
      const frame = getComputedStyle(button, "::before");
      const underprint = getComputedStyle(button, "::after");
      return {
        shape: frame.clipPath,
        angle: frame.transform,
        underprintShape: underprint.clipPath,
        underprintAngle: underprint.transform,
        box: button.getBoundingClientRect().toJSON(),
      };
    }, time);
  const first = await sample(0);
  await page.screenshot({ path: "test-results/menu-selection-a.png" });
  const next = await sample(300);
  await page.screenshot({ path: "test-results/menu-selection-b.png" });
  expect(next.shape).not.toBe(first.shape);
  expect(next.angle).not.toBe(first.angle);
  for (const pose of [first, next]) {
    expect(pose.underprintShape).not.toBe(pose.shape);
  }
  expect(next.box).toEqual(first.box);
  await page.keyboard.press("Enter");
  await expect(page.locator("#dialog-content h2")).toHaveText("游戏设置");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator(".main-nav [data-open=settings]").focus();
  expect(
    await page
      .locator("#menu")
      .evaluate((menu) => menu.getAnimations({ subtree: true }).length),
  ).toBe(0);
});
