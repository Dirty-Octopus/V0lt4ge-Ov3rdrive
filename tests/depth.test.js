import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { Renderer } from "../src/renderer.js";
import {
  TunnelMotion, TUNNEL_DEPTH_SPAN, TUNNEL_PHASE_SPEEDS, ENEMY_RADIUS_RATIO,
  entityScale, tunnelScale, depthToOffset, enemyVisibility, enemyExitDepth,
} from "../src/tunnel.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function setup(difficulty = "normal") {
  const game = new Game({ random: () => 0.5 }).start(difficulty);
  game._spawnTimer = Infinity;
  game._spawn();
  const enemy = game.enemies[0];
  enemy.angle = 0;
  return { game, enemy };
}

test("all enemy types stay registered to tunnel rings through phases and hit stop", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    for (const type of ["drone", "armored", "barrier"]) {
      const { game, enemy } = setup(difficulty);
      enemy.type = type;
      const tunnel = new TunnelMotion();
      const worldOffset = depthToOffset(enemy.z);
      for (let frame = 0; frame < 120; frame++) {
        game.phase = Math.floor(frame / 24) + 1;
        if (frame === 60) game.hitStop = 0.09;
        const dt = frame % 2 ? 1 / 30 : 1 / 144;
        game.update(dt);
        tunnel.advance(dt, { phase: game.phase,
          travel: { distance: game.frameTravel, speed: game.forwardSpeed } });
        close(depthToOffset(enemy.z) + tunnel.distance, worldOffset);
        close(entityScale(enemy.z), tunnelScale(worldOffset - tunnel.distance));
        close(enemy.speed, game.forwardSpeed / TUNNEL_DEPTH_SPAN);
      }
    }
  }
});

test("spawn starts invisible, then reveals progressively without a minimum sprite size", () => {
  const { game, enemy } = setup();
  assert.equal(enemyVisibility(enemy.z), 0);
  assert.ok(entityScale(enemy.z) < 0.075);
  let previous = 0, partialFrames = 0;
  for (let frame = 0; frame < 120; frame++) {
    game.update(1 / 120);
    const visibility = enemyVisibility(enemy.z);
    assert.ok(visibility >= previous);
    assert.ok(visibility - previous < 0.025);
    if (visibility > 0 && visibility < 1) partialFrames++;
    previous = visibility;
  }
  assert.ok(partialFrames > 30);
});

test("near projection keeps moving past the old clamp and limits approach acceleration", () => {
  const zs = [1, 0.7, 0.4, 0.1, 0, -0.06, -0.12, -0.3, -0.6];
  for (let i = 1; i < zs.length; i++)
    assert.ok(entityScale(zs[i]) > entityScale(zs[i - 1]));
  // Previously the last tenth of depth was >20x faster than the far interval.
  const farStep = entityScale(0.8) - entityScale(0.9);
  const nearStep = entityScale(0) - entityScale(0.1);
  assert.ok(nearStep / farStep < 8);
});

test("missed enemies stay in flight and cannot collide with a player moving behind them", () => {
  for (const type of ["drone", "barrier"]) {
    const { game, enemy } = setup();
    enemy.type = type;
    enemy.z = 0.05;
    game.update(0.4);
    assert.ok(game.enemies.includes(enemy));
    assert.ok(enemy.z < -0.06);
    const oldZ = enemy.z;
    game.player.angle = enemy.angle;
    game.update(0.3);
    assert.ok(game.enemies.includes(enemy));
    assert.ok(enemy.z < oldZ);
    assert.equal(game.drainEvents().filter(e => e.type === "damage").length, 0);
  }
});

test("complete enemy silhouettes clear every viewport corner before removal", () => {
  for (const [radius, corner] of [[160, 440], [111, 367], [40, 370], [60, 700]]) {
    const { game, enemy } = setup();
    game.enemyExitZ = enemyExitDepth(radius, corner);
    enemy.z = 0.05;
    let previousZ = enemy.z;
    while (game.enemies.includes(enemy)) {
      previousZ = enemy.z;
      game.update(1 / 120);
      if (radius * entityScale(enemy.z) * (1 - ENEMY_RADIUS_RATIO) <= corner)
        assert.ok(game.enemies.includes(enemy), "visible tail must survive");
    }
    assert.ok(radius * entityScale(previousZ) * (1 - ENEMY_RADIUS_RATIO) > corner);
    assert.equal(game.drainEvents().filter(e => e.type === "escaped").length, 1);
  }
});

test("renderer consumes actual simulation travel, including partial hit-stop frames", () => {
  const context = new Proxy({}, { get(target, property) {
    return target[property] ?? (target[property] = () => {});
  }});
  const renderer = new Renderer({ getContext: () => context,
    getBoundingClientRect: () => ({ width: 390, height: 844 }), style: {} });
  const { game, enemy } = setup();
  renderer.render(game, 0, { mode: "playing" });
  for (const stopped of [0, 0.01, 0.2, 0]) {
    game.hitStop = stopped;
    const beforeDistance = renderer.tunnel.distance, beforeZ = enemy.z;
    game.update(1 / 30);
    renderer.render(game, 1 / 30, { mode: "playing" });
    close(renderer.tunnel.distance - beforeDistance,
      (beforeZ - enemy.z) * TUNNEL_DEPTH_SPAN);
    const projected = renderer.project(enemy.angle, enemy.z);
    close(projected.scale, entityScale(enemy.z));
  }
  const before = renderer.tunnel.distance;
  renderer.render(game, 1 / 30, { mode: "paused" });
  close(renderer.tunnel.distance, before);
  assert.equal(game.forwardSpeed, TUNNEL_PHASE_SPEEDS[0]);
});
