import {
  BALANCE,
  DIFFICULTIES,
  PHASES,
  LANE_COUNT,
  TAU,
  angleDistance,
  phaseForKills,
  wrapAngle,
} from "./balance.js";
import {
  TUNNEL_PHASE_SPEEDS,
  TUNNEL_DEPTH_SPAN,
  ENEMY_SPAWN_DEPTH,
  forwardTravel,
} from "./tunnel.js";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Intersect the time interval in which one moving coordinate overlaps a slab.
function overlapWindow(start, travel, radius, from = 0, to = 1) {
  if (Math.abs(travel) < 1e-12)
    return Math.abs(start) <= radius ? [from, to] : null;
  const first = (-radius - start) / travel;
  const last = (radius - start) / travel;
  const enter = Math.max(from, Math.min(first, last));
  const exit = Math.min(to, Math.max(first, last));
  return enter <= exit ? [enter, exit] : null;
}

// A hit requires angular AND depth overlap at the same instant. Treating these
// axes as separate yes/no sweeps would falsely hit enemies crossed at different
// times. Periodic copies also make the 0/2π seam behave like any other angle.
function bulletHitTime(bullet, enemy, angularTravel) {
  const depth = overlapWindow(
    bullet.prevZ - enemy.prevZ,
    bullet.z - bullet.prevZ - (enemy.z - enemy.prevZ),
    BALANCE.bulletHitDepth,
  );
  if (!depth) return null;
  const firstAngle = bullet.prevAngle + angularTravel * depth[0];
  const lastAngle = bullet.prevAngle + angularTravel * depth[1];
  const firstCopy = Math.ceil(
    (Math.min(firstAngle, lastAngle) - BALANCE.bulletHitAngle - enemy.angle) /
      TAU,
  );
  const lastCopy = Math.floor(
    (Math.max(firstAngle, lastAngle) + BALANCE.bulletHitAngle - enemy.angle) /
      TAU,
  );
  let earliest = null;
  for (let copy = firstCopy; copy <= lastCopy; copy += 1) {
    const angular = overlapWindow(
      bullet.prevAngle - (enemy.angle + copy * TAU),
      angularTravel,
      BALANCE.bulletHitAngle,
      depth[0],
      depth[1],
    );
    if (angular && (earliest === null || angular[0] < earliest))
      earliest = angular[0];
  }
  return earliest;
}

/** Pure game simulation: no DOM, Web Audio, or rendering dependencies. */
export class Game {
  constructor({ onEvent = null, random = Math.random } = {}) {
    this.onEvent = onEvent;
    this.random = random;
    this.events = [];
    this.mode = "menu";
    this.audioNow = 0;
    this._reset("normal");
  }

  _reset(difficulty) {
    this.difficulty = Object.hasOwn(DIFFICULTIES, difficulty)
      ? difficulty
      : "normal";
    this.settings = DIFFICULTIES[this.difficulty];
    this.player = {
      angle: Math.PI,
      angularVelocity: 0,
      tilt: 0,
      hp: BALANCE.maxHp,
      charge: 100,
      invulnerable: false,
      blink: false,
    };
    this.enemies = [];
    this.bullets = [];
    this.phase = 1;
    this.kills = 0;
    this.score = 0;
    this.elapsed = 0;
    this.forwardSpeed = TUNNEL_PHASE_SPEEDS[0] * this.settings.speed;
    this.frameTravel = 0;
    this.enemyExitZ = -2;
    this.shots = 0;
    this.ultimateUses = 0;
    this.ultimate = null;
    this.hitStop = 0;
    this.shake = 0;
    this.damageFlash = 0;
    this.ultimateFlash = 0;
    this._spawnTimer = BALANCE.firstSpawn;
    this._fireTimer = 0;
    this._damageSafeUntil = -Infinity;
    this._ultimateHeld = false;
    this._nextId = 1;
    this._lastSpawnLane = -1;
    this._touchAngularVelocity = 0;
    this.events.length = 0;
  }

  start(difficulty = "normal") {
    this._reset(difficulty);
    this.mode = "playing";
    return this;
  }

  drainEvents() {
    return this.events.splice(0);
  }

  _emit(type, data = {}) {
    const event = {
      type,
      elapsed: this.elapsed,
      audioNow: this.audioNow,
      ...data,
    };
    this.events.push(event);
    if (this.events.length > 512)
      this.events.splice(0, this.events.length - 512);
    // The callback is synchronous so the ultimate's exact decoded audio times
    // can be installed before the first rendered frame of its charge animation.
    if (this.onEvent) this.onEvent(event);
  }

  /**
   * Accepts GameAudio.playUltimate() output directly. endAt includes recovery;
   * an older timing object with only end gets BALANCE.ultimateRecovery appended.
   */
  setUltimate(timing) {
    if (!this.ultimate || !timing) return false;
    const startAt = timing.startAt ?? timing.start ?? this.audioNow;
    const burstAt = timing.burstAt;
    const explosionAt = timing.explosionAt;
    const audioEnd = timing.audioEnd ?? timing.end ?? timing.endAt;
    const endAt = timing.endAt ?? audioEnd + BALANCE.ultimateRecovery;
    if (
      ![startAt, burstAt, explosionAt, audioEnd, endAt].every(
        Number.isFinite,
      ) ||
      startAt > burstAt ||
      burstAt > explosionAt ||
      explosionAt > audioEnd ||
      audioEnd > endAt
    )
      return false;
    Object.assign(this.ultimate, {
      startAt,
      burstAt,
      explosionAt,
      audioEnd,
      endAt,
    });
    return true;
  }

  _activateUltimate() {
    if (this.ultimate || this.player.charge < 100 || this.mode !== "playing")
      return false;
    const startAt = this.audioNow;
    const burstAt = startAt + BALANCE.ultimateFallback.charge;
    const explosionAt = burstAt + BALANCE.ultimateFallback.burst;
    const audioEnd = explosionAt + BALANCE.ultimateFallback.explosion;
    this.ultimate = {
      phase: "charge",
      startAt,
      burstAt,
      explosionAt,
      audioEnd,
      endAt: audioEnd + BALANCE.ultimateRecovery,
      progress: 0,
      remaining: audioEnd + BALANCE.ultimateRecovery - startAt,
      burstFired: false,
      explosionFired: false,
    };
    this.player.charge = 0;
    this.player.hp = BALANCE.maxHp;
    this.player.invulnerable = true;
    this.ultimateUses += 1;
    this._emit("ultimate-request");
    return true;
  }

  _updateUltimate() {
    const ultimate = this.ultimate;
    if (!ultimate) return;
    const now = this.audioNow;
    ultimate.remaining = Math.max(0, ultimate.endAt - now);
    if (now >= ultimate.burstAt && !ultimate.burstFired) {
      ultimate.burstFired = true;
      this.shake = Math.max(this.shake, 0.6);
      this.ultimateFlash = 0.7;
      this._emit("ultimate-burst");
    }
    if (now >= ultimate.explosionAt && !ultimate.explosionFired) {
      ultimate.explosionFired = true;
      this.shake = 1;
      this.hitStop = 0.095;
      this.ultimateFlash = 1;
      // Snapshot protects iteration while _kill removes entries and emits events.
      const targets = [...this.enemies];
      for (const enemy of targets) this._kill(enemy, true);
      this.bullets.length = 0;
      this._emit("ultimate-explosion", { cleared: targets.length });
    }
    if (now >= ultimate.endAt) {
      this.ultimate = null;
      this.player.blink = false;
      this._emit("ultimate-end");
      return;
    }
    if (now < ultimate.burstAt) {
      ultimate.phase = "charge";
      ultimate.progress = clamp(
        (now - ultimate.startAt) /
          Math.max(0.001, ultimate.burstAt - ultimate.startAt),
        0,
        1,
      );
    } else if (now < ultimate.explosionAt) {
      ultimate.phase = "burst";
      ultimate.progress = clamp(
        (now - ultimate.burstAt) /
          Math.max(0.001, ultimate.explosionAt - ultimate.burstAt),
        0,
        1,
      );
    } else if (now < ultimate.audioEnd) {
      ultimate.phase = "explosion";
      ultimate.progress = clamp(
        (now - ultimate.explosionAt) /
          Math.max(0.001, ultimate.audioEnd - ultimate.explosionAt),
        0,
        1,
      );
    } else {
      ultimate.phase = "recovery";
      ultimate.progress = clamp(
        (now - ultimate.audioEnd) /
          Math.max(0.001, ultimate.endAt - ultimate.audioEnd),
        0,
        1,
      );
    }
    this.player.blink =
      ultimate.remaining < 0.8 && Math.floor(now * 16) % 2 === 0;
  }

  update(dt, input = {}, audioNow = this.audioNow + dt) {
    this.frameTravel = 0;
    if (this.mode !== "playing") return;
    dt = Number.isFinite(dt) ? clamp(dt, 0, 1) : 0;
    this.audioNow = Number.isFinite(audioNow) ? audioNow : this.audioNow + dt;
    this.elapsed += dt;
    this.shake = Math.max(0, this.shake - dt * 2.8);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 3);
    this.ultimateFlash = Math.max(0, this.ultimateFlash - dt * 2.5);
    // Swipes are an accumulated displacement, so consume them once per frame,
    // not once per simulation substep. Positive input moves right from bottom.
    const touchDelta = Number.isFinite(input.angleDelta) ? input.angleDelta : 0;
    this._touchAngularVelocity = dt > 0 ? -touchDelta / dt : 0;
    this.player.angularVelocity = 0;
    if (touchDelta !== 0) {
      this.player.angle = wrapAngle(this.player.angle - touchDelta);
      this.player.tilt = clamp(touchDelta * 3, -0.5, 0.5);
    }

    const ultimatePressed = Boolean(input.ultimate);
    if (ultimatePressed && !this._ultimateHeld) this._activateUltimate();
    this._ultimateHeld = ultimatePressed;
    this._updateUltimate();
    this.player.invulnerable =
      Boolean(this.ultimate) || this.audioNow < this._damageSafeUntil;
    if (!this.ultimate)
      this.player.blink =
        this.player.invulnerable && Math.floor(this.audioNow * 14) % 2 === 0;

    if (!this.player.invulnerable) {
      this.player.hp = Math.max(0, this.player.hp - BALANCE.hpDrain * dt);
      if (this.player.hp <= 0) {
        this._gameOver("decay");
        return;
      }
    }

    // The simulation may freeze briefly on impact. The audio clock, ultimate,
    // invulnerability, health drain, and visual flashes continue in real time.
    const stopped = Math.min(dt, this.hitStop);
    this.hitStop = Math.max(0, this.hitStop - dt);
    const simulationTime = dt - stopped;
    if (simulationTime <= 0) return;
    const steps = Math.max(1, Math.ceil(simulationTime / (1 / 60)));
    const step = simulationTime / steps;
    for (let index = 0; index < steps && this.mode === "playing"; index += 1)
      this._step(step, input);
  }

  _step(dt, input) {
    const movement = forwardTravel(
      this.forwardSpeed,
      TUNNEL_PHASE_SPEEDS[this.phase - 1] * this.settings.speed,
      dt,
    );
    this.forwardSpeed = movement.speed;
    this.frameTravel += movement.distance;
    const move = clamp(Number(input.move) || 0, -1, 1);
    this.player.angularVelocity =
      -move * BALANCE.moveSpeed + this._touchAngularVelocity || 0;
    this.player.angle = wrapAngle(
      this.player.angle - move * BALANCE.moveSpeed * dt,
    );
    this.player.tilt +=
      (move * 0.5 - this.player.tilt) * (1 - Math.exp(-dt * 13));
    this._fireTimer = Math.max(0, this._fireTimer - dt);
    if (input.fire && this._fireTimer <= 0 && !this.ultimate) {
      this._shoot();
      this._fireTimer += BALANCE.fireInterval;
    }

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      // No fresh targets appear inside the clearing explosion. The ring gets
      // a short readable breather before the next wave enters the horizon.
      if (
        !this.ultimate ||
        this.ultimate.phase === "charge" ||
        this.ultimate.phase === "burst"
      )
        this._spawn();
      const phase = PHASES[this.phase - 1];
      this._spawnTimer +=
        phase.spawnInterval * this.settings.spawn * (0.9 + this.random() * 0.2);
    }

    for (const enemy of this.enemies) {
      enemy.prevZ = enemy.z;
      const motionRatio = enemy.motionRatio ?? 1;
      enemy.speed = (this.forwardSpeed / TUNNEL_DEPTH_SPAN) * motionRatio;
      enemy.z -= (movement.distance / TUNNEL_DEPTH_SPAN) * motionRatio;
      enemy.age += dt;
    }
    for (const bullet of [...this.bullets]) {
      bullet.prevZ = bullet.z;
      bullet.prevAngle = bullet.angle;
      bullet.z += (bullet.speed ?? BALANCE.bulletSpeed) * dt;
      const angularTravel = (bullet.angularVelocity || 0) * dt;
      bullet.angle = wrapAngle(bullet.angle + angularTravel);
      let target = null;
      let targetTime = Infinity;
      for (const enemy of this.enemies) {
        const time = bulletHitTime(bullet, enemy, angularTravel);
        if (time !== null && time < targetTime) {
          target = enemy;
          targetTime = time;
        }
      }
      if (target) {
        target.hp -= 1;
        target.hitFlash = 1;
        this.bullets.splice(this.bullets.indexOf(bullet), 1);
        this._emit("hit", {
          enemy: { ...target },
          angle: target.angle,
          z: target.z,
        });
        if (target.hp <= 0) this._kill(target, false);
      } else if (bullet.z > 1.05)
        this.bullets.splice(this.bullets.indexOf(bullet), 1);
    }

    for (const enemy of [...this.enemies]) {
      enemy.hitFlash = Math.max(0, (enemy.hitFlash || 0) - dt * 6);
      if (!enemy.passedPlayer && enemy.z <= 0.04) {
        enemy.passedPlayer = true;
        if (
          enemy.prevZ >= -0.04 &&
          angleDistance(enemy.angle, this.player.angle) < BALANCE.playerHitAngle
        ) {
          this.enemies.splice(this.enemies.indexOf(enemy), 1);
          if (!this.player.invulnerable)
            this._damage(
              enemy.type === "barrier"
                ? this.settings.damage * 0.8
                : this.settings.damage,
              enemy,
            );
          continue;
        }
      }
      if (enemy.z < this.enemyExitZ) {
        this.enemies.splice(this.enemies.indexOf(enemy), 1);
        this._emit("escaped", { enemy: { ...enemy } });
      }
    }
  }

  _shoot() {
    let angle = this.player.angle;
    const angularVelocity = clamp(
      this.player.angularVelocity * BALANCE.bulletMomentum,
      -BALANCE.bulletMaxAngularVelocity,
      BALANCE.bulletMaxAngularVelocity,
    );
    let closest = null;
    for (const enemy of this.enemies) {
      // Aim assist adjusts only the launch angle within a small cone. The
      // captured momentum is never canceled, damped, or retargeted in flight.
      const flightTime = Math.max(
        0,
        (enemy.z - 0.025) / (BALANCE.bulletSpeed + enemy.speed),
      );
      const launchAngle = wrapAngle(enemy.angle - angularVelocity * flightTime);
      if (
        enemy.z > 0.035 &&
        angleDistance(launchAngle, this.player.angle) < BALANCE.aimAssist &&
        (!closest || enemy.z < closest.z)
      ) {
        closest = enemy;
        angle = launchAngle;
      }
    }
    const bullet = {
      id: this._nextId++,
      angle,
      prevAngle: angle,
      launchAngle: angle,
      angularVelocity,
      speed: BALANCE.bulletSpeed,
      z: 0.025,
      prevZ: 0.025,
    };
    this.bullets.push(bullet);
    this.shots += 1;
    this._emit("shot", { angle, z: bullet.z, bullet: { ...bullet } });
  }

  _spawn() {
    const phase = PHASES[this.phase - 1];
    // The first targets arrive near the player's starting lane to teach aim.
    // Later waves spread around the entire tube, avoiding identical neighbors.
    let lane;
    if (this.kills < 3 && this.elapsed < 15)
      lane = Math.round((this.player.angle / TAU) * LANE_COUNT) % LANE_COUNT;
    else {
      lane = Math.floor(this.random() * LANE_COUNT);
      if (lane === this._lastSpawnLane)
        lane =
          (lane + 1 + Math.floor(this.random() * (LANE_COUNT - 1))) %
          LANE_COUNT;
    }
    this._lastSpawnLane = lane;
    const roll = this.random();
    const type =
      roll < phase.barrier
        ? "barrier"
        : roll < phase.barrier + phase.armored
          ? "armored"
          : "drone";
    const hp = type === "armored" ? 3 : type === "barrier" ? 2 : 1;
    const enemy = {
      id: this._nextId++,
      type,
      lane,
      angle: (lane / LANE_COUNT) * TAU,
      z: ENEMY_SPAWN_DEPTH,
      prevZ: ENEMY_SPAWN_DEPTH,
      hp,
      maxHp: hp,
      age: 0,
      hitFlash: 0,
      seed: this.random(),
      speed: this.forwardSpeed / TUNNEL_DEPTH_SPAN,
    };
    this.enemies.push(enemy);
    this._emit("spawn", { enemy: { ...enemy } });
  }

  _kill(enemy, ultimate = false) {
    const index = this.enemies.indexOf(enemy);
    if (index === -1) return;
    this.enemies.splice(index, 1);
    const obstacle = enemy.type === "barrier";
    const value = Math.round(
      (obstacle ? 50 : enemy.type === "armored" ? 180 : 100) *
        this.phase *
        this.settings.score,
    );
    this.score += value;
    if (!obstacle) {
      this.kills += 1;
      this.player.hp = Math.min(
        BALANCE.maxHp,
        this.player.hp + this.settings.heal,
      );
      this.player.charge = Math.min(
        100,
        this.player.charge +
          (100 / BALANCE.ultimateKills) *
            (ultimate ? BALANCE.ultimateKillCharge : 1),
      );
      if (this.player.charge > 99.999) this.player.charge = 100;
    }
    if (!ultimate) {
      this.hitStop = Math.max(
        this.hitStop,
        enemy.type === "armored" ? 0.034 : 0.018,
      );
      this.shake = Math.max(this.shake, enemy.type === "armored" ? 0.21 : 0.12);
    }
    this._emit("kill", {
      enemy: { ...enemy },
      angle: enemy.angle,
      z: enemy.z,
      ultimate,
      obstacle,
      value,
      kills: this.kills,
    });
    const phase = phaseForKills(this.kills);
    if (phase !== this.phase) {
      this.phase = phase;
      this._spawnTimer = Math.min(
        this._spawnTimer,
        PHASES[phase - 1].spawnInterval,
      );
      this._emit("phase", { phase, kills: this.kills });
    }
  }

  _damage(amount, enemy) {
    this.player.hp = Math.max(0, this.player.hp - amount);
    this._damageSafeUntil = this.audioNow + BALANCE.damageInvulnerability;
    this.player.invulnerable = true;
    this.damageFlash = 1;
    this.shake = Math.max(this.shake, 0.6);
    this.hitStop = Math.max(this.hitStop, 0.065);
    this._emit("damage", { amount, hp: this.player.hp, enemy: { ...enemy } });
    if (this.player.hp <= 0) this._gameOver("collision");
  }

  _gameOver(reason) {
    if (this.mode !== "playing") return;
    this.mode = "gameover";
    this.player.hp = 0;
    this._emit("gameover", {
      reason,
      score: this.score,
      kills: this.kills,
      phase: this.phase,
      survived: this.elapsed,
    });
  }
}

export default Game;
