import { test, expect } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`depth fog darkens the distant tunnel while preserving the near field at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // Keep repeated pixel reads on one raster backend. Chrome can otherwise
    // migrate this canvas from GPU to CPU between the comparison frames.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, options) {
        return getContext.call(this, kind, kind === "2d"
          ? { ...options, willReadFrequently: true } : options);
      };
    });
    await page.goto("/?qa=1");
    await expect(page.locator("#play")).toBeEnabled();
    await page.locator("#play").click();
    await expect.poll(() => page.evaluate(() => window.__gameQA.mode)).toBe("playing");
    const result = await page.evaluate(() => {
      const q = window.__gameQA, r = q.renderer;
      q.game.enemies = [];
      q.game.bullets = [];
      r.particles = [];
      q.pauseRun();
      document.querySelector("#overlay").close();
      const mask = r.fogMask;
      const pixels = () => r.ctx.getImageData(0, 0, r.width, r.height).data;
      r.render(q.game, 0, { mode: "paused" });
      const fogged = pixels();
      r.fogMask = null;
      r.render(q.game, 0, { mode: "paused" });
      const clear = pixels();
      r.fogMask = mask;
      r.render(q.game, 0, { mode: "paused" });
      let distantFog = 0, distantClear = 0, nearDifference = 0;
      let nearChannels = 0, nearMaxDifference = 0;
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const scale = Math.hypot(x - r.cx, y - r.cy) / r.radius;
          const i = (y * r.width + x) * 4;
          if (scale > 0.1 && scale < 0.35) {
            for (let c = 0; c < 3; c++) {
              distantFog += fogged[i + c];
              distantClear += clear[i + c];
            }
          }
          if (scale > 1.1) {
            for (let c = 0; c < 3; c++) {
              const difference = Math.abs(fogged[i + c] - clear[i + c]);
              nearDifference += difference;
              nearMaxDifference = Math.max(nearMaxDifference, difference);
              nearChannels++;
            }
          }
        }
      }
      return { hasMask: Boolean(mask), distantFog, distantClear,
        nearMeanDifference: nearDifference / nearChannels, nearMaxDifference };
    });
    expect(result.hasMask).toBe(true);
    expect(result.distantFog).toBeLessThan(result.distantClear * 0.65);
    // Allow only insignificant channel rounding, never near-field darkening.
    expect(result.nearMeanDifference).toBeLessThan(0.001);
    expect(result.nearMaxDifference).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/depth-fog-${viewport.width}.png` });
  });
}
