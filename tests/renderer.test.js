import test from "node:test";
import assert from "node:assert/strict";
import { Renderer } from "../src/renderer.js";
import {
  TunnelMotion,
  TUNNEL_PHASE_SPEEDS,
  TUNNEL_PALETTE_DURATION,
  TUNNEL_BAND_WIDTH,
  TUNNEL_STREAK_SPAN,
  TUNNEL_DITHER,
  tunnelScale,
  tunnelRings,
  tunnelMark,
  depthToOffset,
  depthAtScale,
} from "../src/tunnel.js";

function advance(motion, seconds, options, rate = 60) {
  const count = Math.ceil(seconds * rate);
  for (let index = 0; index < count; index++)
    motion.advance(seconds / count, options);
}

test("phase changes change speed without moving or reindexing the world", () => {
  const motion = new TunnelMotion();
  advance(motion, 137, { phase: 1 });
  const distance = motion.distance;
  const speed = motion.speed;
  const rings = tunnelRings(distance, 160, 440);
  motion.advance(0, { phase: 5 });
  assert.equal(motion.distance, distance);
  assert.equal(motion.speed, speed);
  assert.deepEqual(tunnelRings(motion.distance, 160, 440), rings);
  motion.advance(1 / 60, { phase: 5 });
  assert.ok(motion.distance > distance);
  assert.ok(motion.distance - distance < TUNNEL_PHASE_SPEEDS[4] / 60);
  assert.ok(motion.speed > speed && motion.speed < TUNNEL_PHASE_SPEEDS[4]);
});

test("travel is independent of frame rate through acceleration and phase transitions", () => {
  const slow = new TunnelMotion(),
    fast = new TunnelMotion();
  for (const [phase, seconds] of [
    [1, 2.4],
    [2, 0.2],
    [5, 3.6],
    [3, 1.7],
  ]) {
    advance(slow, seconds, { phase }, 30);
    advance(fast, seconds, { phase }, 144);
  }
  assert.ok(Math.abs(slow.distance - fast.distance) < 1e-9);
  assert.ok(Math.abs(slow.speed - fast.speed) < 1e-9);
});

test("each difficulty phase reaches a strictly faster forward speed", () => {
  const motion = new TunnelMotion();
  let previous = 0;
  for (let phase = 1; phase <= 5; phase++) {
    advance(motion, 3, { phase });
    assert.ok(motion.speed > previous);
    assert.ok(Math.abs(motion.speed - TUNNEL_PHASE_SPEEDS[phase - 1]) < 0.002);
    previous = motion.speed;
  }
});

test("ring cartridge marks retain identity, angle and color across a distance wrap", () => {
  const before = tunnelRings(41.999, 160, 440);
  const after = tunnelRings(42.001, 160, 440);
  const oldById = new Map(before.map((ring) => [ring.id, ring]));
  for (const ring of after) {
    const old = oldById.get(ring.id);
    if (!old) continue;
    assert.ok(Math.abs(old.offset - ring.offset - 0.002) < 1e-10);
    assert.equal(ring.accent, old.accent);
    for (let facet = 0; facet < 12; facet++)
      assert.deepEqual(tunnelMark(ring.id, facet), tunnelMark(old.id, facet));
  }
});

test("decorations recycle under the aperture or beyond the viewport, never on screen", () => {
  for (const [radius, corner] of [
    [160, 440],
    [111, 367],
    [96, 510],
    // The entry warp reaches 35% of the normal projection radius.
    [160 * 0.35, 440],
    [111 * 0.35, 367],
    [96 * 0.35, 510],
    [40, 370],
  ]) {
    for (let distance = 0; distance < 2; distance += 0.01) {
      const before = tunnelRings(distance, radius, corner);
      const after = tunnelRings(distance + 0.015, radius, corner);
      const nextIds = new Set(after.map((ring) => ring.id));
      const oldIds = new Set(before.map((ring) => ring.id));
      for (const ring of before.filter((ring) => !nextIds.has(ring.id))) {
        assert.ok(
          tunnelScale(ring.id - distance - 0.015 + TUNNEL_BAND_WIDTH) *
            radius *
            0.88 >
            corner,
        );
        assert.ok(
          tunnelScale(ring.id - distance - 0.015 + TUNNEL_STREAK_SPAN) *
            radius *
            1.15 >
            corner,
        );
      }
      for (const ring of after.filter((ring) => !oldIds.has(ring.id))) {
        assert.ok(
          tunnelScale(ring.offset) < 0.081,
          "new ring must be hidden inside aperture",
        );
      }
    }
  }
});

test("wide-FOV bands survive until their complete tail is offscreen", () => {
  const radius = 40,
    corner = 370,
    // Position this band's rear edge just inside the furthest viewport corner.
    distance = 41 - depthToOffset(depthAtScale(corner / (radius * 0.88))) +
      TUNNEL_BAND_WIDTH - 0.1;
  const rings = tunnelRings(distance, radius, corner);
  const passing = rings.find((ring) => ring.id === 41);
  assert.ok(
    passing,
    "leading-edge clipping must not remove the still-visible tail",
  );
  assert.ok(
    tunnelScale(passing.offset + TUNNEL_BAND_WIDTH) * radius * 0.88 < corner,
  );
  const outsideDistance = distance + 3;
  assert.ok(!tunnelRings(outsideDistance, radius, corner).some((ring) => ring.id === 41));
  assert.ok(
    tunnelScale(41 - outsideDistance + TUNNEL_STREAK_SPAN) * radius * 1.15 > corner,
  );
});

test("pausing and resuming the entrance preserves its FOV and camera position", () => {
  const context = new Proxy(
    {},
    {
      get(target, property) {
        if (!(property in target)) target[property] = () => {};
        return target[property];
      },
    },
  );
  const renderer = new Renderer({
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 390, height: 844 }),
    style: {},
  });
  const game = {
    phase: 1,
    player: { angle: Math.PI, hp: 100 },
    enemies: [],
    bullets: [],
  };
  const options = {
    mode: "intro",
    introProgress: 0.1725,
    audioNow: 0.23,
    menuPortrait: false,
  };
  renderer.render(game, 1 / 60, options);
  const camera = () => [
    renderer.zoom,
    renderer.radius,
    renderer.cx,
    renderer.cy,
    renderer.tunnel.distance,
    renderer.time,
    renderer.introProgress,
  ];
  const before = camera();
  assert.ok(renderer.zoom < 0.5);
  for (let frame = 0; frame < 120; frame++) {
    renderer.render(game, 1 / 60, {
      ...options,
      mode: "paused",
      introProgress: 1,
    });
    assert.deepEqual(camera(), before);
  }
  renderer.render(game, 0, options);
  assert.deepEqual(camera(), before);
});

test("palette transitions begin continuously, normalize, and finish in 1.2 seconds", () => {
  const motion = new TunnelMotion();
  motion.advance(0, { phase: 2 });
  assert.deepEqual(motion.paletteWeights, [1, 0, 0, 0, 0]);
  motion.advance(TUNNEL_PALETTE_DURATION / 2, { phase: 2 });
  assert.deepEqual(motion.paletteWeights, [0.5, 0.5, 0, 0, 0]);
  const halfway = [...motion.paletteWeights];
  motion.advance(0, { phase: 5 });
  assert.deepEqual(motion.paletteWeights, halfway);
  advance(motion, TUNNEL_PALETTE_DURATION, { phase: 5 });
  assert.deepEqual(motion.paletteWeights, [0, 0, 0, 0, 1]);
  assert.equal(new Set(TUNNEL_DITHER).size, 64);
});

test("menu, intro, playing and pause preserve the same world origin", () => {
  const motion = new TunnelMotion();
  advance(motion, 8, { mode: "menu" });
  for (const mode of [
    "intro",
    "playing",
    "paused",
    "playing",
    "gameover",
    "menu",
  ]) {
    const before = motion.distance;
    const cameraBefore = motion.menuMix;
    motion.advance(0, { mode });
    assert.equal(motion.distance, before);
    assert.equal(motion.menuMix, cameraBefore);
    motion.advance(0.016, { mode });
    assert.ok(
      mode === "paused" ? motion.distance === before : motion.distance > before,
    );
  }
  const before = motion.distance;
  advance(motion, 2, { mode: "playing", reducedMotion: true });
  assert.equal(motion.distance, before);
});
