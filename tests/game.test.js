import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";
import { TUNNEL_DEPTH_SPAN } from "../src/tunnel.js";
import {
  BALANCE,
  PHASES,
  TAU,
  angleDistance,
  phaseForKills,
  wrapAngle,
} from "../src/balance.js";

function makeGame(options = {}, difficulty = "normal") {
  const game = new Game({ random: () => 0.5, ...options }).start(difficulty);
  game._spawnTimer = Infinity;
  return game;
}

function target(game, overrides = {}) {
  const enemy = {
    id: game._nextId++,
    angle: game.player.angle,
    z: 0.25,
    prevZ: 0.25,
    type: "drone",
    hp: 1,
    maxHp: 1,
    speed: game.forwardSpeed / TUNNEL_DEPTH_SPAN,
    age: 0,
    seed: 0.5,
    ...overrides,
  };
  game.enemies.push(enemy);
  return enemy;
}

function advance(game, seconds, input = {}) {
  const frames = Math.ceil(seconds * 120);
  for (let index = 0; index < frames; index += 1)
    game.update(seconds / frames, input);
}

test("each run resets to 100 health, one ultimate, and phase one", () => {
  const game = makeGame();
  game.player.hp = 1;
  game.player.charge = 0;
  game.kills = 80;
  game.start("hard");
  assert.equal(game.player.hp, 100);
  assert.equal(game.player.charge, 100);
  assert.equal(game.kills, 0);
  assert.equal(game.phase, 1);
  assert.equal(game.mode, "playing");
  assert.equal(game.difficulty, "hard");
});

test("health drain is frame-rate independent and constant across difficulty", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    const fine = makeGame({}, difficulty);
    const coarse = makeGame({}, difficulty);
    advance(fine, 10);
    for (let frame = 0; frame < 10; frame += 1) coarse.update(1, {});
    assert.ok(Math.abs(fine.player.hp - (100 - BALANCE.hpDrain * 10)) < 1e-8);
    assert.ok(Math.abs(fine.player.hp - coarse.player.hp) < 1e-8);
  }
});

test("holding fire shoots forward and an early kill repairs more than one spawn interval of decay", () => {
  const game = makeGame();
  game.player.hp = 75;
  target(game);
  advance(game, 0.4, { fire: true });
  assert.equal(game.kills, 1);
  assert.equal(game.enemies.length, 0);
  assert.ok(game.player.hp > 82);
  assert.ok(game.settings.heal > BALANCE.hpDrain * PHASES[0].spawnInterval);
  assert.ok(game.drainEvents().some((event) => event.type === "shot"));
});

test("aim assist hits a nearby lane angle and swept collision survives a dropped frame", () => {
  const game = makeGame();
  target(game, { angle: game.player.angle + BALANCE.aimAssist * 0.8, z: 0.55 });
  game.update(0.5, { fire: true }, 0.5);
  assert.equal(game.kills, 1);
});

test("normal attacks break armored enemies and obstacles with different health", () => {
  const game = makeGame();
  target(game, { type: "armored", hp: 3, maxHp: 3 });
  advance(game, 0.65, { fire: true });
  assert.equal(game.kills, 1);
  game.player.hp = 75;
  game.bullets.length = 0;
  target(game, { type: "barrier", hp: 2, maxHp: 2 });
  advance(game, 0.55, { fire: true });
  assert.equal(game.enemies.length, 0);
  assert.equal(
    game.kills,
    1,
    "destroying obstacles does not advance enemy-kill phases",
  );
  assert.ok(game.player.hp < 75, "obstacles do not restore health");
});

test("24 ordinary kills recharge one ultimate without floating-point shortfall", () => {
  const game = makeGame();
  game.player.charge = 0;
  for (let index = 0; index < BALANCE.ultimateKills; index += 1) {
    // Phase changes shorten the spawn timer; keep this a controlled 24 kills.
    game._spawnTimer = Infinity;
    game.bullets.length = 0;
    target(game);
    advance(game, 0.36, { fire: true });
  }
  assert.equal(game.kills, BALANCE.ultimateKills);
  assert.equal(game.player.charge, 100);
  assert.equal(game.phase, 2);
});

test("phases advance at every threshold and cap at five", () => {
  for (let index = 1; index < PHASES.length; index += 1) {
    assert.equal(phaseForKills(PHASES[index].kills - 1), index);
    assert.equal(phaseForKills(PHASES[index].kills), index + 1);
  }
  assert.equal(phaseForKills(100000), 5);
  const game = makeGame();
  game.kills = PHASES[1].kills - 1;
  target(game);
  advance(game, 0.3, { fire: true });
  assert.equal(game.phase, 2);
  assert.equal(
    game.drainEvents().filter((event) => event.type === "phase").length,
    1,
  );
});

test("collisions deduct health once and grant temporary protection from a pileup", () => {
  const game = makeGame();
  target(game, { z: 0.03 });
  target(game, { z: 0.03 });
  game.update(0.016, {});
  assert.ok(
    Math.abs(
      game.player.hp - (100 - BALANCE.hpDrain * 0.016 - game.settings.damage),
    ) < 1e-8,
  );
  assert.equal(game.enemies.length, 0);
  assert.equal(game.player.invulnerable, true);
  assert.equal(
    game.drainEvents().filter((event) => event.type === "damage").length,
    1,
  );
});

test("ultimate heals immediately, follows exact audio times, clears all targets, and protects through recovery", () => {
  let game;
  const received = [];
  game = makeGame({
    onEvent(event) {
      received.push(event);
      if (event.type === "ultimate-request")
        game.setUltimate({
          start: 10,
          startAt: 10,
          burstAt: 12,
          explosionAt: 12.5,
          audioEnd: 16.2,
          endAt: 16.85,
        });
    },
  });
  game.player.hp = 4;
  game.update(0.01, { ultimate: true }, 10);
  assert.equal(game.player.hp, 100);
  assert.equal(game.player.charge, 0);
  assert.equal(game.player.invulnerable, true);
  assert.equal(game.ultimate.phase, "charge");
  assert.equal(game.ultimate.endAt, 16.85);
  target(game, { z: 0.65 });
  target(game, { type: "barrier", z: 0.65 });
  game.update(0.01, {}, 11.99);
  assert.equal(game.enemies.length, 2);
  game.update(0.01, {}, 12);
  assert.equal(game.ultimate.phase, "burst");
  assert.equal(game.enemies.length, 2);
  game.hitStop = 1;
  game.update(0.01, {}, 12.5);
  assert.equal(game.ultimate.phase, "explosion");
  assert.equal(game.enemies.length, 0);
  assert.equal(game.kills, 1);
  assert.equal(game.player.hp, 100);
  game.update(0.01, {}, 16.3);
  assert.equal(game.ultimate.phase, "recovery");
  assert.equal(game.player.invulnerable, true);
  game.update(0.01, {}, 16.85);
  assert.equal(game.ultimate, null);
  assert.equal(game.player.invulnerable, false);
  assert.equal(
    received.filter((event) => event.type === "ultimate-burst").length,
    1,
  );
  assert.equal(
    received.filter((event) => event.type === "ultimate-explosion").length,
    1,
  );
  assert.equal(
    received.filter((event) => event.type === "ultimate-end").length,
    1,
  );
});

test("holding ultimate does not reactivate it, and empty charge cannot activate it", () => {
  const game = makeGame();
  game.update(0.01, { ultimate: true }, 1);
  game.update(0.01, { ultimate: true }, 20);
  game.player.charge = 100;
  game.update(0.01, { ultimate: true }, 20.01);
  assert.equal(game.ultimate, null);
  game.update(0.01, { ultimate: false }, 20.02);
  game.player.charge = 99;
  game.update(0.01, { ultimate: true }, 20.03);
  assert.equal(game.ultimate, null);
});

test("hit stop freezes positions while the audio clock and health drain continue", () => {
  const game = makeGame();
  const enemy = target(game);
  game.hitStop = 0.2;
  game.update(0.1, { move: 1 }, 4);
  assert.equal(enemy.z, 0.25);
  assert.equal(game.audioNow, 4);
  assert.ok(game.player.hp < 100);
  assert.equal(game.player.angle, Math.PI);
});

test("positive controls move right from the starting position; swipe delta is consumed once", () => {
  const game = makeGame();
  game.update(0.5, { angleDelta: 0.2 }, 0.5);
  assert.ok(Math.abs(game.player.angle - (Math.PI - 0.2)) < 1e-8);
  assert.ok(Math.sin(game.player.angle) > 0);
  const before = game.player.angle;
  game.update(0.1, { move: 1 }, 0.6);
  assert.ok(game.player.angle < before);
  assert.ok(angleDistance(0.01, Math.PI * 2 - 0.01) < 0.021);
});

test("zero health emits game over exactly once and stops simulation", () => {
  const game = makeGame();
  game.player.hp = 0.01;
  game.update(0.1, {});
  assert.equal(game.mode, "gameover");
  assert.equal(game.player.hp, 0);
  const elapsed = game.elapsed;
  game.update(1, { fire: true, ultimate: true });
  assert.equal(game.elapsed, elapsed);
  assert.equal(
    game.drainEvents().filter((event) => event.type === "gameover").length,
    1,
  );
});

test("stationary shots have no lateral momentum and stay on their launch angle", () => {
  const game = makeGame();
  game.update(1 / 60, { fire: true });
  const bullet = game.bullets[0];
  const angle = bullet.angle;
  assert.equal(bullet.angularVelocity, 0);
  assert.equal(bullet.speed, BALANCE.bulletSpeed);
  advance(game, 0.25);
  assert.equal(bullet.angle, angle);
});

test("keyboard shots inherit their own directional momentum through release and reversal", () => {
  const game = makeGame();
  game.update(1 / 60, { move: 1, fire: true });
  const rightward = game.bullets[0];
  const velocity = -BALANCE.moveSpeed * BALANCE.bulletMomentum;
  assert.equal(game.player.angularVelocity, -BALANCE.moveSpeed);
  assert.equal(rightward.angularVelocity, velocity);
  const angle = rightward.angle;
  advance(game, 0.2);
  assert.equal(game.player.angularVelocity, 0);
  assert.ok(
    angleDistance(rightward.angle, wrapAngle(angle + velocity * 0.2)) < 1e-8,
  );
  game.update(1 / 60, { move: -1, fire: true });
  const leftward = game.bullets.find((bullet) => bullet.id !== rightward.id);
  assert.equal(
    rightward.angularVelocity,
    velocity,
    "existing shot does not reverse with the player",
  );
  assert.equal(
    leftward.angularVelocity,
    -velocity,
    "new shot captures the reversed movement",
  );
});

test("touch shots inherit displacement per second and fast swipes cannot create extreme spin", () => {
  const game = makeGame();
  game.update(0.02, { angleDelta: 0.03, fire: true });
  assert.equal(game.player.angularVelocity, -1.5);
  assert.ok(
    Math.abs(game.bullets[0].angularVelocity - -1.5 * BALANCE.bulletMomentum) <
      1e-8,
  );
  const mixed = makeGame();
  mixed.update(0.02, { angleDelta: 0.03, move: 0.5, fire: true });
  assert.ok(
    Math.abs(
      mixed.bullets[0].angularVelocity -
        (-1.5 - BALANCE.moveSpeed * 0.5) * BALANCE.bulletMomentum,
    ) < 1e-8,
  );
  for (const direction of [-1, 1]) {
    const fast = makeGame();
    fast.update(0.01, { angleDelta: direction * 3, fire: true });
    assert.equal(
      fast.bullets[0].angularVelocity,
      -direction * BALANCE.bulletMaxAngularVelocity,
    );
  }
});

test("aim assist preserves moving-shot momentum while modestly leading a nearby target", () => {
  const game = makeGame();
  target(game, { angle: game.player.angle - 0.12 });
  game.update(1 / 60, { move: 1, fire: true });
  const bullet = game.bullets[0];
  assert.equal(
    bullet.angularVelocity,
    -BALANCE.moveSpeed * BALANCE.bulletMomentum,
  );
  assert.ok(
    angleDistance(bullet.launchAngle, game.player.angle) <= BALANCE.aimAssist,
  );
  advance(game, 0.25);
  assert.equal(game.kills, 1);
});

test("inertial shots wrap around the tunnel seam without changing velocity", () => {
  const game = makeGame();
  game.player.angle = 0.2;
  game.update(1 / 60, { move: 1, fire: true });
  const bullet = game.bullets[0];
  const before = bullet.angle;
  advance(game, 0.2);
  assert.ok(bullet.angle > Math.PI);
  assert.ok(bullet.angle >= 0 && bullet.angle < TAU);
  assert.ok(
    angleDistance(
      bullet.angle,
      wrapAngle(before + bullet.angularVelocity * 0.2),
    ) < 1e-8,
  );
});

function movingBullet(game, overrides = {}) {
  const bullet = {
    id: game._nextId++,
    angle: 0,
    prevAngle: 0,
    launchAngle: 0,
    angularVelocity: 3.2,
    speed: BALANCE.bulletSpeed,
    z: 0.1,
    prevZ: 0.1,
    ...overrides,
  };
  game.bullets.push(bullet);
  return bullet;
}

test("angular and depth sweeps catch an impact between both sampled endpoints", () => {
  const game = makeGame();
  movingBullet(game);
  target(game, { angle: 0.48, z: 0.328, speed: 0, motionRatio: 0 });
  // Exercise one deliberately coarse integration step: both start and end
  // angles miss, but the arc passes through the target halfway through.
  game._step(0.3, {});
  assert.equal(game.kills, 1);
  assert.equal(game.bullets.length, 0);
});

test("swept collision also catches arcs crossing the angular wrap seam", () => {
  const game = makeGame();
  movingBullet(game, { angle: 0.1, angularVelocity: -3.2 });
  target(game, { angle: TAU - 0.12, z: 0.2045, speed: 0, motionRatio: 0 });
  game._step(0.15, {});
  assert.equal(game.kills, 1);
});

test("crossing an enemy angle and depth at different times is a miss", () => {
  const game = makeGame();
  movingBullet(game);
  target(game, { angle: 0.1, z: 0.5, speed: 0, motionRatio: 0 });
  game._step(0.3, {});
  assert.equal(game.kills, 0);
  assert.equal(game.enemies[0].hp, 1);
  assert.equal(game.bullets.length, 1);
});

test("one curved shot hits the first intersected enemy regardless of array order", () => {
  const game = makeGame();
  movingBullet(game);
  const later = target(game, { angle: 0.64, z: 0.404, speed: 0, motionRatio: 0 });
  const earlier = target(game, { angle: 0.32, z: 0.252, speed: 0, motionRatio: 0 });
  game._step(0.3, {});
  assert.equal(game.kills, 1);
  assert.equal(game.enemies.length, 1);
  assert.equal(game.enemies[0].id, later.id);
  assert.ok(
    game
      .drainEvents()
      .some((event) => event.type === "kill" && event.enemy.id === earlier.id),
  );
});
