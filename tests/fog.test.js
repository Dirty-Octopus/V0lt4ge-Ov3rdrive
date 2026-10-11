import test from "node:test";
import assert from "node:assert/strict";
import { entityScale } from "../src/tunnel.js";
import { depthFog, fogTint, fogMaskPixels, wallDepth } from "../src/depth-fog.js";

test("depth attenuation preserves the near plane and progressively obscures distance", () => {
  assert.equal(depthFog(-0.5), 0);
  assert.equal(depthFog(0), 0);
  let previous = 0;
  for (let z = 0; z <= 1.2; z += 0.005) {
    const fog = depthFog(z);
    assert.ok(fog >= previous && fog <= 1);
    assert.ok(fog - previous < 0.012);
    previous = fog;
  }
  assert.ok(depthFog(0.8) > 0.85);
  assert.equal(fogTint("#fff0cd", 0), "#fff0cd");
  assert.ok(depthFog(0.8, 0.35) < depthFog(0.8));
});

test("the mask reconstructs wall depth on every facet rather than screen distance", () => {
  for (let facet = 0; facet < 12; facet++) {
    const angle = facet * Math.PI / 6;
    for (const z of [0, 0.2, 0.5, 0.9]) {
      const radius = entityScale(z) * Math.cos(Math.PI / 12);
      const reconstructed = wallDepth(Math.sin(angle) * radius, -Math.cos(angle) * radius);
      assert.ok(Math.abs(reconstructed - z) < 1e-10);
    }
  }
});

test("fog texture is deterministic, opaque at the horizon, and clear near the player", () => {
  const size = 128;
  const first = fogMaskPixels(size), second = fogMaskPixels(size);
  assert.deepEqual(first, second);
  const alpha = (x, y) => first[(y * size + x) * 4 + 3];
  assert.equal(alpha(64, 64), 255);
  assert.equal(alpha(64, 0), 0);
  assert.equal(alpha(0, 64), 0);
  assert.equal(alpha(127, 127), 0);
  assert.ok(alpha(64, 48) > alpha(64, 32));
});
