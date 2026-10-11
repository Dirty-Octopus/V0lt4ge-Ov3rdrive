/** Shared world coordinates and projection for the tunnel and its occupants. */
export const TUNNEL_PHASE_SPEEDS = Object.freeze([4.8, 6.4, 8.2, 10.3, 12.6]);
export const TUNNEL_MENU_SPEED = 0.65;
export const TUNNEL_SPEED_RESPONSE = 0.34;
export const TUNNEL_PALETTE_DURATION = 1.2;
export const TUNNEL_BAND_WIDTH = 0.22;
export const TUNNEL_STREAK_SPAN = 0.4;
export const TUNNEL_HORIZON = 32;
export const TUNNEL_DEPTH_SPAN = 16;
export const TUNNEL_PLAYER_OFFSET = 1.6;
const DEPTH_FALLOFF = 2.5;
export const ENEMY_SPAWN_DEPTH = 1.18;
// Includes the legs, armor indicator, line widths and animation excursions.
export const ENEMY_RADIUS_RATIO = 32 / 115;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smoothstep = (value) => value * value * (3 - 2 * value);

export function forwardTravel(speed, targetSpeed, dt) {
  const decay = Math.exp(-dt / TUNNEL_SPEED_RESPONSE);
  return {
    distance:
      targetSpeed * dt +
      (speed - targetSpeed) * TUNNEL_SPEED_RESPONSE * (1 - decay),
    speed: targetSpeed + (speed - targetSpeed) * decay,
  };
}

export const depthToOffset = (z) => TUNNEL_PLAYER_OFFSET + z * TUNNEL_DEPTH_SPAN;
export const depthAtScale = (scale) => -Math.log(scale) / DEPTH_FALLOFF;
export const entityScale = (z) => Math.exp(-DEPTH_FALLOFF * z);

export function enemyVisibility(z) {
  // Spawn fully hidden in the aperture, then reveal through its outer lip.
  return smoothstep(clamp((entityScale(z) - 0.085) / 0.075));
}

export function enemyExitDepth(radius, furthestCorner) {
  // Cull only once the innermost edge of the complete sprite clears every
  // corner. Extra margin covers camera sway and a resize between two frames.
  return depthAtScale(
    (furthestCorner * 1.2 + 16) /
      (Math.max(1, radius) * (1 - ENEMY_RADIUS_RATIO)),
  );
}

export class TunnelMotion {
  constructor() {
    this.distance = 0;
    this.speed = TUNNEL_MENU_SPEED;
    this.phase = 1;
    this.paletteWeights = [1, 0, 0, 0, 0];
    this.paletteFrom = [...this.paletteWeights];
    this.paletteAge = TUNNEL_PALETTE_DURATION;
    this.menuMix = 1;
  }

  advance(
    dt,
    {
      phase = 1,
      mode = "playing",
      reducedMotion = false,
      frozen = false,
      speedMultiplier = 1,
      travel = null,
    } = {},
  ) {
    if (mode === "paused" || frozen) return;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const menu = mode === "menu";
    const targetPhase = menu ? 1 : clamp(Math.round(phase), 1, 5);
    if (targetPhase !== this.phase) {
      this.phase = targetPhase;
      this.paletteFrom = [...this.paletteWeights];
      this.paletteAge = 0;
    }
    this.paletteAge = Math.min(TUNNEL_PALETTE_DURATION, this.paletteAge + step);
    const blend = smoothstep(this.paletteAge / TUNNEL_PALETTE_DURATION);
    this.paletteWeights = this.paletteFrom.map(
      (weight, index) =>
        weight * (1 - blend) + (index === this.phase - 1 ? blend : 0),
    );

    if (reducedMotion) {
      this.speed = 0;
      this.menuMix = menu ? 1 : 0;
      return;
    }
    const targetSpeed = menu
      ? TUNNEL_MENU_SPEED
      : mode === "gameover"
        ? 1.2
        : TUNNEL_PHASE_SPEEDS[targetPhase - 1] * speedMultiplier;
    // Integrate the exponential speed response exactly. Replacing phase or mode
    // changes velocity, never world position; frame rate does not change travel.
    const movement = travel ?? forwardTravel(this.speed, targetSpeed, step);
    this.distance += movement.distance;
    this.speed = movement.speed;
    this.menuMix =
      (menu ? 1 : 0) + (this.menuMix - (menu ? 1 : 0)) * Math.exp(-step / 0.19);
  }
}

export function tunnelScale(offset, maxScale = Infinity) {
  // A logarithmic depth projection gives equal world steps equal proportional
  // screen growth, avoiding a near-camera singularity and a stalled horizon.
  return Math.min(
    maxScale,
    entityScale((offset - TUNNEL_PLAYER_OFFSET) / TUNNEL_DEPTH_SPAN),
  );
}

/**
 * Identity and decoration never depend on a visible-list index. Rings enter
 * underneath the central aperture and leave only after the innermost mark is
 * outside every viewport corner, including tall phone layouts.
 */
export function tunnelRings(distance, radius, furthestCorner) {
  const markNear =
    depthToOffset(depthAtScale((furthestCorner * 1.2) / (radius * 0.88))) -
    TUNNEL_BAND_WIDTH;
  const streakNear =
    depthToOffset(depthAtScale((furthestCorner * 1.2) / (radius * 1.15))) -
    TUNNEL_STREAK_SPAN;
  const near = Math.min(markNear, streakNear);
  const first = Math.ceil(distance + near);
  const last = Math.floor(distance + TUNNEL_HORIZON);
  const rings = [];
  for (let id = last; id >= first; id--) {
    rings.push({ id, offset: id - distance, accent: ((id % 4) + 4) % 4 === 0 });
  }
  return rings;
}

export function tunnelMark(id, facet) {
  return {
    visible: (((id + facet) % 3) + 3) % 3 === 0,
    alternate: (((id + facet) % 2) + 2) % 2 === 1,
  };
}

// Screen-space, static ordered ink: transitions retain the exact five palettes
// even when the app applies its final discrete color-gamut filter.
const BAYER_2 = [0, 2, 3, 1];
export const TUNNEL_DITHER = Object.freeze(
  Array.from({ length: 64 }, (_, index) => {
    const x = index % 8,
      y = Math.floor(index / 8);
    return (
      (BAYER_2[(y % 2) * 2 + (x % 2)] * 16 +
        BAYER_2[(Math.floor(y / 2) % 2) * 2 + (Math.floor(x / 2) % 2)] * 4 +
        BAYER_2[Math.floor(y / 4) * 2 + Math.floor(x / 4)] +
        0.5) /
      64
    );
  }),
);
