import { test, expect } from "@playwright/test";

async function boot(page) {
  await page.goto("/?qa=1");
  await expect(page.locator("#play")).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
}

async function settled(page) {
  await expect(page.locator("[data-text-scramble-active]")).toHaveCount(0);
  await expect(
    page.locator("[data-scramble-run], .scramble-code, .scramble-source"),
  ).toHaveCount(0);
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
}

test("first language click scrambles menu, numbers and intact logo without changing accessible labels", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  await page.evaluate(() => {
    // Hold the intentional poster jitter while measuring text replacement.
    document
      .querySelector("#game-logo")
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.pause());
    window.languageLogoNodes = [
      ...document.querySelectorAll(
        "#game-logo, .logo-letter, .cube-rotor, .cube-face, .cube-glyph",
      ),
    ];
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#game-logo .logo-letter"));
    window.languageLogoBaseline = range.getBoundingClientRect().toJSON();
    window.languageChanges = 0;
    const original = window.__gameQA.audio.playSfx.bind(window.__gameQA.audio);
    window.__gameQA.audio.playSfx = (name) => {
      if (name === "change") window.languageChanges += 1;
      return original(name);
    };
  });
  await page.locator("#lang-toggle").click();
  const mid = await page.evaluate(() => {
    const glyph = document.querySelector(
      "#game-logo .scramble-code",
    ).parentElement;
    const source = glyph
      .querySelector(".scramble-source")
      .getBoundingClientRect();
    const code = glyph.querySelector(".scramble-code").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(
      document.querySelector("#game-logo .logo-letter .scramble-source"),
    );
    const baseline = range.getBoundingClientRect();
    return {
      codes: document.querySelectorAll(".scramble-code").length,
      logo: document.querySelectorAll("#game-logo .scramble-code").length,
      numbers: document.querySelectorAll("#menu-best .scramble-code").length,
      sizer: document.querySelectorAll(".cube-sizer [data-scramble-run]")
        .length,
      printable: [...document.querySelectorAll(".scramble-code")].every(
        (node) => /^[\x21-\x7e]$/.test(node.textContent),
      ),
      aligned:
        Math.abs(source.y - code.y) < 0.1 &&
        Math.abs(source.height - code.height) < 0.1,
      bounded: Math.abs(source.width - code.width) < 0.1,
      baselineStable: ["x", "y", "width", "height"].every(
        (key) =>
          Math.abs(baseline[key] - window.languageLogoBaseline[key]) < 0.1,
      ),
      width: document.querySelector("#play").getBoundingClientRect().width,
      height: document.querySelector("#play").getBoundingClientRect().height,
    };
  });
  expect(mid.codes).toBeGreaterThan(50);
  expect(mid.logo).toBeGreaterThan(10);
  expect(mid.numbers).toBe(6);
  expect(mid.sizer).toBe(0);
  expect(
    mid.printable && mid.aligned && mid.bounded && mid.baselineStable,
  ).toBe(true);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#play")).toHaveAccessibleName(/PLAY/);
  await page.screenshot({ path: "test-results/language-menu-mid.png" });
  await settled(page);
  await expect(page.locator("[data-i18n=play]")).toHaveText("PLAY");
  expect(
    await page.evaluate(() =>
      window.languageLogoNodes.every((node) => node.isConnected),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.languageChanges)).toBe(1);
  const final = await page.locator("#play").boundingBox();
  expect(final.width).toBeCloseTo(mid.width, 1);
  expect(final.height).toBeCloseTo(mid.height, 1);
  expect(errors).toEqual([]);
});

test("settings and background scramble together, fast switches settle cleanly, controls keep working", async ({
  page,
}) => {
  await boot(page);
  await page.locator("[data-open=settings]").click();
  await page.locator("#settings-lang").click();
  expect(await page.locator("#overlay .scramble-code").count()).toBeGreaterThan(
    60,
  );
  expect(await page.locator("#menu .scramble-code").count()).toBeGreaterThan(
    30,
  );
  await page.screenshot({ path: "test-results/language-settings-mid.png" });
  await page.evaluate(() => {
    document.querySelector("#settings-lang").click();
    document.querySelector("#settings-lang").click();
    document.querySelector("#settings-lang").click();
  });
  await settled(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#dialog-content h2")).toHaveText("游戏设置");
  await expect(page.locator("#settings-lang")).toHaveText("中文 → ENGLISH");
  await page.locator("#gameMusic-volume").fill("37");
  expect(
    await page.evaluate(
      () => window.__gameQA.audio.debugState.volumes.gameMusic,
    ),
  ).toBe(0.37);
  await page.locator("[data-difficulty=hard]").click();
  await expect(page.locator("[data-difficulty=hard]")).toHaveClass(
    /\bselected\b/,
  );
  await page.locator("#dialog-back").click();
  await page.locator("#play").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
});

test("language changes in paused settings cannot overwrite live HUD values", async ({
  page,
}) => {
  await boot(page);
  await page.locator("#play").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
  await page.locator("#pause-button").click();
  await page.locator("#overlay [data-open=settings]").click();
  await page.locator("#settings-lang").click();
  await page.evaluate(() => {
    window.__gameQA.game.player.hp = 57;
    window.__gameQA.game.kills = 12;
  });
  await settled(page);
  await expect(page.locator("#hp-number")).toHaveText("57");
  await expect(page.locator("#kills-number")).toHaveText("12");
  await expect(page.locator("#phase-name")).toHaveText("EMBER");
  await page.locator("#dialog-back").click();
  await expect(page.locator("#dialog-content h2")).toHaveText("PAUSED");
  await page.locator("#resume").click();
  await expect
    .poll(() => page.evaluate(() => window.__gameQA.mode))
    .toBe("playing");
});

test("reduced motion changes language immediately with no decorative nodes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);
  await page.locator("#lang-toggle").click();
  await expect(page.locator("[data-i18n=play]")).toHaveText("PLAY");
  await settled(page);
  await page.locator("[data-open=settings]").click();
  await page.locator("#settings-lang").click();
  await expect(page.locator("#dialog-content h2")).toHaveText("游戏设置");
  await settled(page);
});
