/** All durations are seconds. Depth is 0 at the player, ~1 at the far aperture. */
export const TAU = Math.PI * 2;
export const LANE_COUNT = 12;
export const BALANCE = Object.freeze({
  maxHp: 100,
  hpDrain: 1.65,
  killHeal: 9,
  ultimateKills: 24,
  ultimateKillCharge: 0.5,
  ultimateRecovery: 0.65,
  moveSpeed: 2.85,
  fireInterval: 0.145,
  bulletSpeed: 1.52,
  bulletMomentum: 0.55,
  bulletMaxAngularVelocity: 3.2,
  bulletHitDepth: 0.035,
  aimAssist: 0.21,
  bulletHitAngle: 0.115,
  playerHitAngle: 0.23,
  damageInvulnerability: 0.8,
  firstSpawn: 0.6,
  // These fallback durations are replaced by decoded WAV timings at activation.
  ultimateFallback: Object.freeze({
    charge: 2.041655,
    burst: 0.562494,
    explosion: 3.729161,
  }),
});

export const DIFFICULTIES = Object.freeze({
  easy: Object.freeze({
    spawn: 1.22,
    speed: 0.86,
    damage: 17,
    heal: 11,
    score: 0.8,
  }),
  normal: Object.freeze({ spawn: 1, speed: 1, damage: 23, heal: 9, score: 1 }),
  hard: Object.freeze({
    spawn: 0.84,
    speed: 1.15,
    damage: 29,
    heal: 8,
    score: 1.3,
  }),
});

export const PHASES = Object.freeze([
  Object.freeze({
    kills: 0,
    spawnInterval: 1.24,
    armored: 0,
    barrier: 0,
  }),
  Object.freeze({
    kills: 12,
    spawnInterval: 1.02,
    armored: 0.12,
    barrier: 0.07,
  }),
  Object.freeze({
    kills: 32,
    spawnInterval: 0.83,
    armored: 0.22,
    barrier: 0.11,
  }),
  Object.freeze({
    kills: 64,
    spawnInterval: 0.67,
    armored: 0.27,
    barrier: 0.14,
  }),
  Object.freeze({
    kills: 105,
    spawnInterval: 0.54,
    armored: 0.34,
    barrier: 0.17,
  }),
]);

export function phaseForKills(kills) {
  let phase = 1;
  for (let index = 1; index < PHASES.length; index += 1) {
    if (kills >= PHASES[index].kills) phase = index + 1;
  }
  return phase;
}

export function wrapAngle(angle) {
  return ((angle % TAU) + TAU) % TAU;
}

export function angleDistance(a, b) {
  return Math.abs(((((a - b + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
}
