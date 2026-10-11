/**
 * Original, resolution-independent pixel illustrations and a faceted 3D tunnel.
 * Audio effects follow their exact clock; tunnel travel integrates frame time
 * across screen and phase changes. Low display resolution preserves the pixels.
 */
import {
  TunnelMotion,
  TUNNEL_BAND_WIDTH,
  TUNNEL_STREAK_SPAN,
  TUNNEL_DITHER,
  tunnelScale,
  tunnelRings,
  tunnelMark,
  entityScale,
  enemyVisibility,
  enemyExitDepth,
} from "./tunnel.js";
import { createFogMask, fogTint } from "./depth-fog.js";

const INK = "#11111b";
const PAPER = "#fff0cd";
const RED = "#ff392e";
const GOLD = "#ffd538";
const BLUE = "#224bfa";
const CYAN = "#72ecdd";
const ORANGE = "#ff8b32";
const DARKRED = "#551b35";
const DARKBLUE = "#182365";
const TAU = Math.PI * 2;
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const fract = (n) => n - Math.floor(n);
const hash = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const rainbow = [RED, ORANGE, GOLD, CYAN, BLUE, "#ef74ed"];
const TUNNEL_PALETTES = [
  [INK, DARKBLUE, "#273aad", INK, "#342141", DARKBLUE, GOLD, BLUE],
  [INK, "#273aad", DARKBLUE, INK, "#184454", DARKBLUE, GOLD, BLUE],
  [INK, DARKRED, DARKBLUE, "#422343", "#23235c", INK, GOLD, BLUE],
  [DARKRED, INK, "#382256", DARKBLUE, INK, "#57263a", RED, RED],
  [INK, "#652436", DARKRED, "#3c234d", INK, "#242468", RED, RED],
];

function poly(ctx, points, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], i) =>
    i
      ? ctx.lineTo(Math.round(x), Math.round(y))
      : ctx.moveTo(Math.round(x), Math.round(y)),
  );
  ctx.closePath();
  ctx.fill();
}

function line(ctx, points, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  points.forEach(([x, y], i) =>
    i
      ? ctx.lineTo(Math.round(x), Math.round(y))
      : ctx.moveTo(Math.round(x), Math.round(y)),
  );
  ctx.stroke();
}

function polygonPoints(x, y, radius, sides = 12, rotation = 0) {
  return Array.from({ length: sides }, (_, i) => [
    x + Math.sin((i / sides) * TAU + rotation) * radius,
    y - Math.cos((i / sides) * TAU + rotation) * radius,
  ]);
}

function ring(ctx, x, y, outer, inner, color, sides = 12, rotation = 0) {
  const out = polygonPoints(x, y, outer, sides, rotation);
  const inn = polygonPoints(x, y, inner, sides, rotation);
  for (let i = 0; i < sides; i++)
    poly(
      ctx,
      [out[i], out[(i + 1) % sides], inn[(i + 1) % sides], inn[i]],
      color,
    );
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.fogMask = canvas.ownerDocument ? createFogMask(canvas.ownerDocument) : null;
    this.time = 0;
    this.tunnel = new TunnelMotion();
    this.paletteKey = "";
    this.paletteFills = TUNNEL_PALETTES[0];
    this.sceneMode = "menu";
    this.introProgress = 0;
    this.particles = [];
    this.trails = [];
    this.lastAngle = Math.PI;
    this.lastTrail = 0;
    this.pulses = [];
    this.shake = 0;
    this.flash = 0;
    this.phaseReveal = 0;
    this.width = 640;
    this.height = 360;
    this.resize();
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    const cssW = box.width || window.innerWidth;
    const cssH = box.height || window.innerHeight;
    // Every physical pixel is a visible choice, including on high-DPI displays.
    const density = cssW < 600 ? 1.4 : Math.max(1.8, cssH / 420);
    this.width = Math.max(240, Math.round(cssW / density));
    this.height = Math.round((this.width * cssH) / cssW);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.imageSmoothingEnabled = false;
    this.canvas.style.imageRendering = "pixelated";
  }

  onEvent(event) {
    if (!event) return;
    const type = typeof event === "string" ? event : event.type;
    const data = event.enemy || event;
    const angle = Number.isFinite(data.angle) ? data.angle : this.lastAngle;
    const z = Number.isFinite(data.z) ? data.z : 0.04;
    if (type === "kill") {
      this.emit(angle, z, 18, [GOLD, PAPER, RED, CYAN], 0.46);
      this.pulses.push({ angle, z, life: 0.3, max: 0.3 });
      this.shake = Math.max(this.shake, 0.13);
    } else if (type === "shot") {
      this.emit(angle, 0.03, 4, [GOLD, ORANGE, PAPER], 0.18, 0.45);
    } else if (type === "damage") {
      this.flash = 0.28;
      this.shake = 0.7;
      this.emit(angle, 0, 22, [RED, PAPER, ORANGE], 0.55);
    } else if (type === "ultimate-burst") {
      this.shake = 0.65;
      this.emit(angle, 0, 35, [GOLD, PAPER, ORANGE], 0.5, 1.5);
    } else if (type === "ultimate-explosion") {
      this.shake = 1;
      for (let i = 0; i < 12; i++)
        this.emit((i / 12) * TAU, 0.3, 9, [GOLD, PAPER, RED], 1.1, 1.8);
    } else if (type === "phase") {
      this.phaseReveal = 1.15;
    } else if (type === "gameover") {
      this.emit(angle, 0, 40, [RED, GOLD, PAPER], 1.4);
      this.shake = 0.5;
    }
    // A strict budget keeps huge synchronized explosions smooth on phones.
    if (this.particles.length > 300)
      this.particles.splice(0, this.particles.length - 300);
  }

  emit(angle, z, count, colors, lifetime, force = 1) {
    for (let i = 0; i < count; i++) {
      const seed = this.time * 731 + i * 19 + this.particles.length;
      const direction = hash(seed) * TAU;
      const speed = (10 + hash(seed + 1) * 58) * force;
      this.particles.push({
        angle,
        z,
        dx: 0,
        dy: 0,
        vx: Math.sin(direction) * speed,
        vy: Math.cos(direction) * speed,
        life: lifetime * (0.5 + hash(seed + 2) * 0.5),
        max: lifetime,
        color: colors[i % colors.length],
        size: 1 + Math.floor(hash(seed + 3) * 3),
      });
    }
  }

  render(game = {}, dt = 1 / 60, options = {}) {
    const ctx = this.ctx;
    const mode = options.mode || "menu";
    const menu = mode === "menu";
    const paused = mode === "paused";
    const reduced = options.reducedMotion === true;
    if (!paused) this.sceneMode = mode;
    if (mode === "intro")
      this.introProgress = clamp(options.introProgress ?? 0);
    const intro = this.sceneMode === "intro";
    if (mode === "intro" && this.mode !== "intro" && this.mode !== "paused") {
      this.particles.length = 0;
      this.pulses.length = 0;
      this.trails.length = 0;
      this.shake = 0;
      this.flash = 0;
      this.lastAngle = game.player?.angle ?? Math.PI;
    }
    const step = Math.min(0.06, Math.max(0, dt));
    if (!paused) this.time += step;
    this.audioNow = options.audioNow ?? game.audioNow ?? this.time;
    this.mode = mode;
    this.reduced = reduced;
    this.menuPortrait = options.menuPortrait !== false;
    this.game = game;
    this.phase = game.phase || 1;
    this.tunnel.advance(step, {
      phase: this.phase,
      mode,
      reducedMotion: reduced,
      speedMultiplier: game.settings?.speed ?? 1,
      travel:
        mode === "playing" && Number.isFinite(game.frameTravel)
          ? { distance: game.frameTravel, speed: game.forwardSpeed }
          : null,
      frozen: !menu && (game.hitStop || 0) > 0 && mode !== "playing",
    });
    const menuMix = this.tunnel.menuMix;
    const w = this.width,
      h = this.height;
    this.portrait = w / h < 0.85;
    this.cx = w * (0.5 + ((this.portrait ? 0.65 : 0.73) - 0.5) * menuMix);
    this.cy =
      h * ((this.portrait ? 0.435 : 0.5) * (1 - menuMix) + 0.46 * menuMix);
    const gameRadius = Math.min(
      w * (this.portrait ? 0.4 : 0.37),
      h * (this.portrait ? 0.315 : 0.385),
    );
    this.radius =
      gameRadius * (1 - menuMix) + Math.min(w * 0.46, h * 0.68) * menuMix;
    this.zoom = 1;
    if (intro && !reduced) {
      const p = this.introProgress;
      this.zoom =
        p < 0.24
          ? 1 - 0.65 * Math.sin(((p / 0.24) * Math.PI) / 2)
          : 1 -
            0.65 *
              Math.exp(-6 * ((p - 0.24) / 0.76)) *
              Math.cos(((p - 0.24) / 0.76) * Math.PI * 3.1);
    }
    if (!reduced) {
      this.cx +=
        Math.sin(this.time * 0.37) * Math.min(5, w * 0.006) * (1 - menuMix);
      this.cy += Math.sin(this.time * 0.51) * 3 * (1 - menuMix);
    }
    this.radius *= this.zoom;
    game.enemyExitZ = enemyExitDepth(
      this.radius,
      Math.hypot(Math.max(this.cx, w - this.cx), Math.max(this.cy, h - this.cy)),
    );
    ctx.save();
    const impact = reduced ? 0 : Math.max(this.shake, game.shake || 0);
    if (impact > 0.01)
      ctx.translate(
        Math.round(Math.sin(this.time * 153) * impact * 5),
        Math.round(Math.cos(this.time * 197) * impact * 3),
      );
    ctx.fillStyle = INK;
    ctx.fillRect(-10, -10, w + 20, h + 20);
    this.drawTunnel();
    if (menu) {
      ctx.save();
      ctx.globalAlpha = menuMix;
      this.drawMenu();
      ctx.restore();
    } else {
      this.drawTrack();
      this.drawEntities(game);
      this.drawTrails(paused ? 0 : step, game.player);
      this.drawPlayer(game.player || { angle: Math.PI, hp: 100 });
      this.drawParticles(paused ? 0 : step);
      if (game.ultimate) this.drawUltimate(game.ultimate);
      if (intro) this.drawIntro(this.introProgress);
      this.drawDamage(
        Math.max(this.flash, game.damageFlash || 0),
        game.player?.hp ?? 100,
      );
      this.drawFrame(game);
      if (menuMix > 0.004) {
        ctx.save();
        ctx.globalAlpha = menuMix;
        this.drawMenu();
        ctx.restore();
      }
    }
    ctx.restore();
    if (!paused) {
      this.shake = Math.max(0, this.shake - step * 2.5);
      this.flash = Math.max(0, this.flash - step);
      this.phaseReveal = Math.max(0, this.phaseReveal - step);
    }
  }

  project(angle, z, orbit = 1) {
    const scale = entityScale(z);
    return {
      x: this.cx + Math.sin(angle) * this.radius * scale * orbit,
      y: this.cy - Math.cos(angle) * this.radius * scale * orbit,
      scale,
    };
  }

  updateTunnelPalette() {
    const weights = this.tunnel.paletteWeights;
    const key = weights.map((weight) => Math.round(weight * 64)).join(",");
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const active = weights
      .map((weight, phase) => ({ weight, phase }))
      .filter(({ weight }) => weight > 0.0001);
    this.paletteFills = TUNNEL_PALETTES[0].map((_, slot) => {
      const colors = active.map(({ phase }) => TUNNEL_PALETTES[phase][slot]);
      if (colors.every((color) => color === colors[0])) return colors[0];
      const tile = document.createElement("canvas");
      tile.width = tile.height = 8;
      const tileCtx = tile.getContext("2d");
      for (let index = 0; index < 64; index++) {
        let accumulated = 0;
        let phase = active[active.length - 1].phase;
        for (const candidate of active) {
          accumulated += candidate.weight;
          if (TUNNEL_DITHER[index] <= accumulated) {
            phase = candidate.phase;
            break;
          }
        }
        tileCtx.fillStyle = TUNNEL_PALETTES[phase][slot];
        tileCtx.fillRect(index % 8, Math.floor(index / 8), 1, 1);
      }
      return this.ctx.createPattern(tile, "repeat");
    });
  }

  drawTunnel() {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    const cx = this.cx,
      cy = this.cy,
      radius = this.radius;
    const rotation = -Math.PI / 12;
    this.updateTunnelPalette();
    const colors = this.paletteFills;
    const outer = Math.max(w, h) * 1.6;
    const out = polygonPoints(cx, cy, outer, 12, rotation);
    const inner = polygonPoints(cx, cy, radius * 0.075, 12, rotation);
    for (let facet = 0; facet < 12; facet++) {
      poly(
        ctx,
        [
          out[facet],
          out[(facet + 1) % 12],
          inner[(facet + 1) % 12],
          inner[facet],
        ],
        colors[facet % 6],
      );
      const a = ((facet + 0.07) / 12) * TAU + rotation;
      const b = ((facet + 0.14) / 12) * TAU + rotation;
      poly(
        ctx,
        [
          [cx + Math.sin(a) * outer, cy - Math.cos(a) * outer],
          [cx + Math.sin(b) * outer, cy - Math.cos(b) * outer],
          [cx + Math.sin(b) * radius * 0.07, cy - Math.cos(b) * radius * 0.07],
          [cx + Math.sin(a) * radius * 0.07, cy - Math.cos(a) * radius * 0.07],
        ],
        facet % 3 === 0 ? BLUE : INK,
      );
    }
    const furthestCorner = Math.hypot(
      Math.max(cx, w - cx),
      Math.max(cy, h - cy),
    );
    const rings = tunnelRings(this.tunnel.distance, radius, furthestCorner);
    const maxScale = (furthestCorner * 4) / radius;
    for (const worldRing of rings) {
      const { id, offset, accent } = worldRing;
      const ro = radius * tunnelScale(offset, maxScale);
      const ri = radius * tunnelScale(offset + TUNNEL_BAND_WIDTH, maxScale);
      const pointsA = polygonPoints(cx, cy, ro, 12, rotation);
      const pointsB = polygonPoints(cx, cy, ri, 12, rotation);
      for (let facet = 0; facet < 12; facet++) {
        let color = INK;
        if (facet === 2 || facet === 8) color = accent ? PAPER : BLUE;
        else if (facet === 4 || facet === 10) color = accent ? GOLD : "#2d4ed7";
        else if (facet === 0 || facet === 6) color = accent ? colors[6] : BLUE;
        else color = accent ? "#515bbb" : INK;
        poly(
          ctx,
          [
            pointsA[facet],
            pointsA[(facet + 1) % 12],
            pointsB[(facet + 1) % 12],
            pointsB[facet],
          ],
          color,
        );
        const mark = tunnelMark(id, facet);
        if (mark.visible) {
          const a = ((facet + 0.44) / 12) * TAU + rotation;
          const b = ((facet + 0.6) / 12) * TAU + rotation;
          const r2 = ri * 0.88;
          poly(
            ctx,
            [
              [cx + Math.sin(a) * ri, cy - Math.cos(a) * ri],
              [cx + Math.sin(b) * ri, cy - Math.cos(b) * ri],
              [cx + Math.sin(b) * r2, cy - Math.cos(b) * r2],
              [cx + Math.sin(a) * r2, cy - Math.cos(a) * r2],
            ],
            mark.alternate ? BLUE : "#5362bd",
          );
        }
      }
      // These streaks are also fixed to world rings. They fade in at the outer
      // track and leave the viewport naturally, instead of wrapping on screen.
      if (!this.reduced && this.tunnel.menuMix < 0.99 && ro > radius * 1.05) {
        const alpha =
          clamp((ro / radius - 1.05) / 0.35) * (1 - this.tunnel.menuMix);
        ctx.save();
        ctx.globalAlpha = alpha;
        for (let ray = 0; ray < 3; ray++) {
          const a = hash(id * 11 + ray * 23) * TAU;
          const head = ro * 1.15;
          const tail =
            radius * tunnelScale(offset + TUNNEL_STREAK_SPAN, maxScale) * 1.15;
          line(
            ctx,
            [
              [cx + Math.sin(a) * tail, cy - Math.cos(a) * tail],
              [cx + Math.sin(a) * head, cy - Math.cos(a) * head],
            ],
            ray === 0 ? GOLD : BLUE,
            ro > radius * 2 ? 2 : 1,
          );
        }
        ctx.restore();
      }
    }
    poly(ctx, polygonPoints(cx, cy, radius * 0.081, 12, rotation), INK);
    ring(ctx, cx, cy, radius * 0.096, radius * 0.082, colors[7], 12, rotation);
    if (this.fogMask)
      ctx.drawImage(this.fogMask, cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.fillStyle = GOLD;
    ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
  }

  drawTrack() {
    const ctx = this.ctx;
    ring(
      ctx,
      this.cx,
      this.cy,
      this.radius * 1.05,
      this.radius * 1.038,
      "#5563a4",
      48,
    );
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const p = this.project(a, -0.007, 1.08);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(a);
      ctx.fillStyle = i % 3 ? BLUE : GOLD;
      ctx.fillRect(-2, -2, 4, 1);
      ctx.restore();
    }
  }

  drawEntities(game) {
    const ctx = this.ctx;
    const entities = [
      ...(game.enemies || []).map((e) => ({ ...e, entityKind: "enemy" })),
      ...(game.bullets || []).map((b) => ({ ...b, entityKind: "bullet" })),
    ].sort((a, b) => b.z - a.z);
    for (const entity of entities) {
      const p = this.project(entity.angle, entity.z);
      if (entity.entityKind === "bullet") {
        const rearZ = Math.max(0, entity.z - 0.08);
        const trailAge = (entity.z - rearZ) / (entity.speed || 1.52);
        const rear = this.project(
          entity.angle - (entity.angularVelocity || 0) * trailAge,
          rearZ,
        );
        line(
          ctx,
          [
            [rear.x, rear.y],
            [p.x, p.y],
          ],
          fogTint(RED, entity.z, 0.35),
          Math.max(2, p.scale * 7),
        );
        line(
          ctx,
          [
            [rear.x, rear.y],
            [p.x, p.y],
          ],
          fogTint(GOLD, entity.z, 0.35),
          Math.max(1, p.scale * 3),
        );
        const size = Math.max(2, p.scale * 4);
        poly(
          ctx,
          [
            [p.x, p.y - size],
            [p.x + size, p.y],
            [p.x, p.y + size],
            [p.x - size, p.y],
          ],
          fogTint(PAPER, entity.z, 0.35),
        );
        continue;
      }
      const visibility = enemyVisibility(entity.z);
      if (visibility <= 0) continue;
      const size = (p.scale * this.radius) / 115;
      ctx.save();
      ctx.globalAlpha = visibility;
      ctx.translate(Math.round(p.x), Math.round(p.y));
      ctx.rotate(entity.angle);
      ctx.scale(size, size);
      this.drawEnemy(entity, this.time);
      ctx.restore();
    }
  }

  drawEnemy(enemy, time) {
    const ctx = this.ctx;
    const shade = (color) => fogTint(color, enemy.z);
    if (enemy.type === "barrier") {
      // An unmistakable physical obstruction with hazard-stripe ceramic armor.
      poly(
        ctx,
        [
          [-18, -9],
          [-12, -14],
          [12, -14],
          [18, -9],
          [18, 9],
          [12, 14],
          [-12, 14],
          [-18, 9],
        ],
        shade(INK),
      );
      poly(
        ctx,
        [
          [-15, -8],
          [-10, -11],
          [10, -11],
          [15, -7],
          [15, 8],
          [10, 11],
          [-10, 11],
          [-15, 7],
        ],
        shade(GOLD),
      );
      for (let i = -17; i < 15; i += 9)
        poly(
          ctx,
          [
            [i, -8],
            [i + 5, -8],
            [i + 13, 8],
            [i + 8, 8],
          ],
          shade(INK),
        );
      ctx.fillStyle = shade(PAPER);
      ctx.fillRect(-16, -11, 4, 4);
      ctx.fillRect(12, 7, 4, 4);
      ctx.fillStyle = shade(RED);
      ctx.fillRect(-3, -3, 6, 6);
      return;
    }
    const armored = enemy.type === "armored";
    const twitch = this.reduced
      ? 0
      : Math.round(Math.sin(time * 10 + (enemy.seed || enemy.id || 0)) * 2);
    const shell = armored ? shade(PAPER) : shade(CYAN);
    const accent = armored ? shade(RED) : shade(BLUE);
    // Six jointed legs around an exposed biological core and mechanical shell.
    for (let side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const y = -7 + i * 6;
        line(
          ctx,
          [
            [side * 6, y],
            [side * (13 + (i % 2) * 3), y - 4 + twitch],
            [side * (18 - (i % 2) * 2), y + 1 + twitch],
          ],
          shade(INK),
          5,
        );
        line(
          ctx,
          [
            [side * 6, y],
            [side * (13 + (i % 2) * 3), y - 4 + twitch],
            [side * (18 - (i % 2) * 2), y + 1 + twitch],
          ],
          shell,
          2,
        );
      }
    }
    poly(
      ctx,
      [
        [-8, -14],
        [7, -14],
        [12, -7],
        [10, 8],
        [4, 14],
        [-4, 14],
        [-11, 7],
        [-12, -7],
      ],
      shade(INK),
    );
    poly(
      ctx,
      [
        [-6, -11],
        [5, -11],
        [9, -5],
        [7, 7],
        [0, 11],
        [-8, 5],
        [-9, -5],
      ],
      shell,
    );
    poly(
      ctx,
      [
        [0, -10],
        [6, -7],
        [6, 3],
        [0, 8],
        [-5, 3],
        [-5, -6],
      ],
      accent,
    );
    ctx.fillStyle = shade(INK);
    ctx.fillRect(-7, -3, 14, 4);
    ctx.fillStyle = shade(GOLD);
    ctx.fillRect(-5, -2, 3, 2);
    ctx.fillRect(2, -2, 3, 2);
    ctx.fillStyle = shade(RED);
    ctx.fillRect(-2, 5, 4, 3);
    ctx.fillStyle = shade(PAPER);
    ctx.fillRect(-6, -10, 3, 3);
    if (armored && enemy.hp > 1) {
      line(
        ctx,
        [
          [-11, -12],
          [0, -17],
          [11, -12],
        ],
        shade(GOLD),
        3,
      );
    }
  }

  drawTrails(dt, player) {
    if (!player) return;
    const difference = Math.atan2(
      Math.sin(player.angle - this.lastAngle),
      Math.cos(player.angle - this.lastAngle),
    );
    if (
      Math.abs(difference) > 0.002 &&
      this.time - this.lastTrail > 0.023 &&
      !this.reduced
    ) {
      this.trails.push({
        angle: this.lastAngle,
        life: 0.19,
        tilt: player.tilt || 0,
      });
      this.lastTrail = this.time;
    }
    this.lastAngle = player.angle;
    for (const trail of this.trails) {
      trail.life -= dt;
      const p = this.project(trail.angle, 0);
      this.ctx.save();
      this.ctx.globalAlpha = clamp(trail.life / 0.19) * 0.6;
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(trail.angle - Math.PI);
      const s = this.radius / 150;
      this.ctx.scale(s, s);
      poly(
        this.ctx,
        [
          [-7, 1],
          [-13, 11],
          [-3, 8],
          [1, 18],
          [5, 8],
          [13, 11],
          [7, 1],
        ],
        trail.life > 0.1 ? GOLD : RED,
      );
      this.ctx.restore();
    }
    this.trails = this.trails.filter((trail) => trail.life > 0).slice(-14);
  }

  drawPlayer(player) {
    const ctx = this.ctx;
    const angle = player.angle ?? Math.PI;
    const p = this.project(angle, 0);
    const s = this.radius / 132;
    const ultimate = this.game.ultimate;
    const blinking =
      player.blink ||
      (ultimate &&
        ultimate.remaining < 0.85 &&
        Math.floor(this.audioNow * 12) % 2);
    if (blinking && !this.reduced) return;
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.rotate(angle - Math.PI + clamp(player.tilt || 0, -1, 1) * 0.62);
    ctx.scale(s, s);
    // Ground shadow and a golden aiming line are always legible over the tube.
    ctx.fillStyle = INK;
    ctx.fillRect(-12, 10, 24, 5);
    if (player.invulnerable)
      ring(
        ctx,
        0,
        0,
        21,
        20,
        ultimate
          ? rainbow[Math.floor(this.audioNow * 7) % rainbow.length]
          : CYAN,
        10,
      );
    this.drawMage(0, 0, 1, this.time, !!ultimate, false);
    ctx.restore();
    if (ultimate?.phase === "charge") {
      const charge = clamp(
        (this.audioNow - ultimate.startAt) /
          (ultimate.burstAt - ultimate.startAt),
      );
      ring(
        ctx,
        p.x,
        p.y,
        s * (25 - charge * 10),
        s * (23 - charge * 10),
        GOLD,
        8,
        this.time * 2,
      );
      for (let i = 0; i < 7; i++) {
        const a = (i * TAU) / 7 + this.time * 2;
        const r = s * (17 + 30 * fract(this.time * 1.6 + i / 7));
        ctx.fillStyle = i % 2 ? GOLD : PAPER;
        ctx.fillRect(
          Math.round(p.x + Math.sin(a) * r),
          Math.round(p.y + Math.cos(a) * r),
          2,
          2,
        );
      }
    }
  }

  drawMage(x, y, size, time, invulnerable = false, hero = false) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size, size);
    const coat = invulnerable
      ? rainbow[Math.floor(this.audioNow * 8) % rainbow.length]
      : RED;
    const lining = invulnerable
      ? rainbow[(Math.floor(this.audioNow * 8) + 2) % rainbow.length]
      : ORANGE;
    const flick = this.reduced ? 0 : Math.floor(Math.sin(time * 8) * 2);
    // Long diagonal coat, broad collar, tucked head: original ember-mage silhouette.
    poly(
      ctx,
      [
        [-8, -8],
        [-15, -2],
        [-12, 4],
        [-16, 14],
        [-9, 13],
        [-10, 19],
        [-2, 16],
        [3, 18],
        [10, 13],
        [15, 16],
        [12, 4],
        [16, -3],
        [7, -9],
      ],
      INK,
    );
    poly(
      ctx,
      [
        [-8, -6],
        [-13, -1],
        [-9, 4],
        [-12, 12],
        [-5, 10],
        [-6, 15],
        [0, 12],
        [3, 16],
        [7, 11],
        [12, 13],
        [8, 3],
        [13, -2],
        [6, -7],
      ],
      coat,
    );
    poly(
      ctx,
      [
        [-7, 1],
        [-11, 11],
        [-6, 9],
        [-6, 13],
        [-1, 9],
        [1, 2],
      ],
      DARKRED,
    );
    poly(
      ctx,
      [
        [3, 0],
        [3, 11],
        [7, 7],
        [8, 10],
        [8, 1],
      ],
      lining,
    );
    poly(
      ctx,
      [
        [-11, -2],
        [-5, 2],
        [-2, -2],
        [-6, -6],
      ],
      GOLD,
    );
    poly(
      ctx,
      [
        [5, -7],
        [12, -3],
        [4, 3],
        [2, -2],
      ],
      GOLD,
    );
    // Hood erupts into a jagged flame crest. All marks align to sprite pixels.
    poly(
      ctx,
      [
        [-8, -5],
        [-10, -10],
        [-6, -13],
        [-7, -21 - flick],
        [-3, -18],
        [1, -27 - flick],
        [4, -18],
        [9, -21 + flick],
        [8, -14],
        [11, -10],
        [7, -4],
        [2, -2],
        [-3, -3],
      ],
      INK,
    );
    poly(
      ctx,
      [
        [-6, -6],
        [-7, -10],
        [-3, -13],
        [-4, -17],
        [-1, -15],
        [2, -22 - flick],
        [4, -14],
        [7, -17],
        [6, -11],
        [8, -9],
        [5, -5],
        [1, -3],
      ],
      coat,
    );
    poly(
      ctx,
      [
        [-4, -8],
        [-3, -13],
        [0, -11],
        [2, -17],
        [4, -11],
        [6, -9],
        [3, -5],
        [0, -4],
      ],
      GOLD,
    );
    poly(
      ctx,
      [
        [-5, -8],
        [0, -7],
        [5, -9],
        [4, -5],
        [0, -3],
        [-4, -5],
      ],
      INK,
    );
    ctx.fillStyle = PAPER;
    ctx.fillRect(-3, -7, 2, 1);
    ctx.fillRect(2, -8, 2, 1);
    // A fire-held forward hand clarifies which direction attacks travel.
    poly(
      ctx,
      [
        [9, -1],
        [15, -5],
        [19, -3],
        [17, 1],
        [11, 4],
      ],
      INK,
    );
    poly(
      ctx,
      [
        [12, -1],
        [16, -3],
        [17, -1],
        [14, 1],
      ],
      GOLD,
    );
    poly(
      ctx,
      [
        [14, -5],
        [12, -9],
        [16, -8],
        [18, -15 - flick],
        [20, -9],
        [23, -11],
        [22, -5],
        [18, -3],
      ],
      RED,
    );
    poly(
      ctx,
      [
        [16, -6],
        [16, -9],
        [18, -8],
        [19, -12],
        [20, -7],
        [19, -5],
      ],
      GOLD,
    );
    ctx.fillStyle = PAPER;
    ctx.fillRect(18, -7, 1, 2);
    ctx.fillStyle = INK;
    ctx.fillRect(-5, 14, 3, 5);
    ctx.fillRect(4, 13, 3, 5);
    if (hero) {
      // Deliberately offset ink hatching evokes a printed comic panel.
      for (let i = 0; i < 6; i++)
        line(
          ctx,
          [
            [-9 + i, 5],
            [-12 + i, 11],
          ],
          INK,
          0.6,
        );
      ctx.fillStyle = PAPER;
      ctx.fillRect(-10, -1, 3, 1);
      ctx.fillRect(5, 3, 1, 5);
    }
    ctx.restore();
  }

  drawParticles(dt) {
    const ctx = this.ctx;
    for (const particle of this.particles) {
      particle.life -= dt;
      particle.dx += particle.vx * dt;
      particle.dy += particle.vy * dt;
      particle.vy += dt * 35;
      const p = this.project(particle.angle, particle.z);
      const fade = clamp(particle.life / (particle.max * 0.4));
      if (fade < 0.3 && Math.floor(this.time * 30) % 2) continue;
      ctx.fillStyle = fogTint(particle.color, particle.z, 0.35);
      const size = Math.max(1, Math.round(particle.size * fade));
      ctx.fillRect(
        Math.round(p.x + particle.dx),
        Math.round(p.y + particle.dy),
        size,
        size,
      );
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
    for (const pulse of this.pulses) {
      pulse.life -= dt;
      const p = this.project(pulse.angle, pulse.z);
      const t = 1 - pulse.life / pulse.max;
      const r = (5 + t * 20) * Math.max(0.5, p.scale);
      ring(
        ctx,
        p.x,
        p.y,
        r,
        r - (1 - t) * 4,
        fogTint(t < 0.3 ? PAPER : GOLD, pulse.z, 0.35),
        8,
        t * 0.4,
      );
    }
    this.pulses = this.pulses.filter((pulse) => pulse.life > 0);
  }

  drawUltimate(ultimate) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    const now = this.audioNow;
    const p = this.project(this.game.player?.angle ?? Math.PI, 0);
    if (now < ultimate.burstAt) {
      const t = clamp(
        (now - ultimate.startAt) / (ultimate.burstAt - ultimate.startAt),
      );
      const darkness = t * 0.23;
      ctx.fillStyle = `rgba(17,17,27,${darkness})`;
      ctx.fillRect(0, 0, w, h);
      ring(
        ctx,
        this.cx,
        this.cy,
        this.radius * (1.1 - t * 0.95),
        this.radius * (1.085 - t * 0.95),
        GOLD,
        12,
        t * 0.35,
      );
      if (t > 0.65) {
        const r = (t - 0.65) * 32;
        poly(
          ctx,
          [
            [p.x - r * 2, p.y],
            [p.x - r * 0.25, p.y - r * 0.25],
            [p.x, p.y - r * 2],
            [p.x + r * 0.25, p.y - r * 0.25],
            [p.x + r * 2, p.y],
            [p.x + r * 0.25, p.y + r * 0.25],
            [p.x, p.y + r * 2],
            [p.x - r * 0.25, p.y + r * 0.25],
          ],
          PAPER,
        );
      }
      return;
    }
    if (now < ultimate.explosionAt) {
      const t = clamp(
        (now - ultimate.burstAt) / (ultimate.explosionAt - ultimate.burstAt),
      );
      const width = (11 + t * 25) * Math.min(1.7, this.radius / 120);
      const dx = this.cx - p.x,
        dy = this.cy - p.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length,
        ny = dx / length;
      // Expanding fire-cannon with a hard ivory core and printed red shock front.
      poly(
        ctx,
        [
          [p.x + nx * width, p.y + ny * width],
          [this.cx + nx * width * 0.35, this.cy + ny * width * 0.35],
          [this.cx - nx * width * 0.35, this.cy - ny * width * 0.35],
          [p.x - nx * width, p.y - ny * width],
        ],
        RED,
      );
      poly(
        ctx,
        [
          [p.x + nx * width * 0.64, p.y + ny * width * 0.64],
          [this.cx + nx * width * 0.2, this.cy + ny * width * 0.2],
          [this.cx - nx * width * 0.2, this.cy - ny * width * 0.2],
          [p.x - nx * width * 0.64, p.y - ny * width * 0.64],
        ],
        GOLD,
      );
      line(
        ctx,
        [
          [p.x, p.y],
          [this.cx, this.cy],
        ],
        PAPER,
        Math.max(3, width * 0.35),
      );
      ring(
        ctx,
        this.cx,
        this.cy,
        3 + t * this.radius * 0.6,
        t * this.radius * 0.45,
        GOLD,
        12,
        t * 0.2,
      );
      return;
    }
    const t = now - ultimate.explosionAt;
    // One impact frame, then a long decaying shock front follows the real sound.
    if (t < 0.065) {
      ctx.fillStyle = this.reduced ? GOLD : PAPER;
      ctx.globalAlpha = this.reduced ? 0.25 : 0.88;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (t < 1.15) {
      const r = this.radius * (0.1 + Math.pow(t / 1.15, 0.65) * 3.8);
      ring(
        ctx,
        this.cx,
        this.cy,
        r,
        r * (0.74 + t * 0.17),
        t < 0.22 ? PAPER : t < 0.6 ? GOLD : RED,
        12,
        0.13,
      );
      ring(ctx, this.cx, this.cy, r * 0.65, r * 0.61, GOLD, 12, -0.13);
      for (let i = 0; i < 16; i++) {
        const a = (i * TAU) / 16;
        const start = r * (0.7 + hash(i) * 0.25);
        line(
          ctx,
          [
            [this.cx + Math.sin(a) * start, this.cy + Math.cos(a) * start],
            [
              this.cx + Math.sin(a) * r * 1.24,
              this.cy + Math.cos(a) * r * 1.24,
            ],
          ],
          i % 3 ? GOLD : PAPER,
          Math.max(1, 5 - t * 4),
        );
      }
    }
    if (t > 0.3 && t < 3.7) {
      const opacity = clamp((3.7 - t) / 3.4) * 0.7;
      ctx.globalAlpha = opacity;
      for (let i = 0; i < 28; i++) {
        const a = hash(i + 140) * TAU;
        const r = (hash(i + 10) + t * 0.15) * this.radius * 1.8;
        ctx.fillStyle = i % 2 ? GOLD : RED;
        ctx.fillRect(
          Math.round(this.cx + Math.sin(a) * r),
          Math.round(this.cy + Math.cos(a) * r - t * 5),
          (i % 3) + 1,
          (i % 2) + 2,
        );
      }
      ctx.globalAlpha = 1;
    }
  }

  drawIntro(progress) {
    if (this.reduced) return;
    const ctx = this.ctx;
    if (progress > 0.85) return;
    const strength = Math.sin(clamp(progress / 0.85) * Math.PI);
    for (let i = 0; i < 27; i++) {
      const a = (i / 27) * TAU + hash(i) * 0.06;
      const start = this.radius * (0.4 + hash(i + 50) * 0.6);
      const end = start + strength * (40 + hash(i + 100) * 100);
      line(
        ctx,
        [
          [this.cx + Math.sin(a) * start, this.cy - Math.cos(a) * start],
          [this.cx + Math.sin(a) * end, this.cy - Math.cos(a) * end],
        ],
        i % 3 ? BLUE : PAPER,
        i % 4 ? 1 : 2,
      );
    }
  }

  drawDamage(flash, hp) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    if (flash > 0) {
      ctx.globalAlpha = Math.min(0.42, flash * 1.25);
      ctx.fillStyle = RED;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      poly(
        ctx,
        [
          [0, 0],
          [w * 0.4, 0],
          [w * 0.23, 7],
          [w * 0.09, 3],
          [0, 22],
        ],
        RED,
      );
      poly(
        ctx,
        [
          [w, h],
          [w * 0.6, h],
          [w * 0.79, h - 10],
          [w * 0.94, h - 5],
          [w, h - 25],
        ],
        RED,
      );
    }
    if (hp < 30 && this.mode !== "gameover") {
      const alpha = this.reduced ? 0.65 : 0.55 + Math.sin(this.time * 6) * 0.2;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = RED;
      ctx.fillRect(0, 0, 3, h);
      ctx.fillRect(w - 3, 0, 3, h);
      ctx.globalAlpha = 1;
    }
  }

  drawFrame(game) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    ctx.fillStyle = INK;
    for (let i = 0; i < 8; i++) {
      ctx.fillRect(i * 6, h - 3, 3, 3);
      ctx.fillRect(w - i * 6 - 3, 0, 3, 3);
    }
    if (this.phaseReveal > 0 && !this.reduced) {
      const t = 1 - this.phaseReveal / 1.15;
      const sweep = t * (w + 80) - 40;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.18;
      poly(
        ctx,
        [
          [sweep, 0],
          [sweep + 30, 0],
          [sweep - 25, h],
          [sweep - 55, h],
        ],
        GOLD,
      );
      ctx.globalAlpha = 1;
    }
  }

  drawMenu() {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    // Shared tear geometry, held at eleven drawings per second like comic ink.
    // Keep one phase through the menu's departure, and never reseed the shape.
    const phase = (Math.floor(this.time * 11) / 11) * (TAU / 4.4);
    const motion = this.reduced ? 0 : 1;
    const dx = Math.min(6, w * 0.009) * motion;
    const dy = Math.min(6, h * 0.012) * motion;
    const edge = [
      [w * 0.49 + Math.sin(phase + 0.4) * dx * 0.4, 0],
      [
        w * 0.57 + Math.sin(phase * 1.5) * dx,
        h * 0.24 + Math.sin(phase + 0.8) * dy,
      ],
      [
        w * 0.48 + Math.sin(phase * 1.5 + 2.1) * dx,
        h * 0.5 + Math.sin(phase * 1.25 + 2.6) * dy,
      ],
      [w * 0.51 + Math.sin(phase + 3.2) * dx * 0.55, h],
    ];
    const outer = edge.map(([x, y], index) => [
      x +
        w * (index === 1 ? 0.03 : 0.04) +
        Math.sin(phase * 1.5 + index * 1.7) *
          Math.min(1.7, w * 0.0025) *
          motion,
      y - (index === 2 ? h * 0.02 : 0),
    ]);
    poly(ctx, [[0, 0], ...edge, [0, h]], INK);
    poly(
      ctx,
      // One pixel of shared coverage prevents antialiased background cracks.
      [...edge.map(([x, y]) => [x - 1, y]), ...outer.reverse()],
      RED,
    );
    if (!this.menuPortrait) return;
    const heroX = w * (this.portrait ? 0.83 : 0.77);
    const heroY = h * (this.portrait ? 0.56 : 0.57);
    const heroScale = Math.min(w / (this.portrait ? 78 : 110), h / 68);
    const bob = this.reduced ? 0 : Math.sin(this.time * 1.7) * 1.8;
    // The halo is yellow newsprint, broken by an angular cobalt silhouette.
    poly(
      ctx,
      polygonPoints(heroX, heroY - heroScale * 4, heroScale * 27, 12, 0.18),
      GOLD,
    );
    poly(
      ctx,
      [
        [heroX - heroScale * 26, heroY - heroScale * 20],
        [heroX + heroScale * 23, heroY - heroScale * 12],
        [heroX + heroScale * 16, heroY + heroScale * 25],
        [heroX - heroScale * 22, heroY + heroScale * 12],
      ],
      BLUE,
    );
    ctx.save();
    ctx.beginPath();
    const clip = polygonPoints(
      heroX,
      heroY - heroScale * 4,
      heroScale * 27,
      12,
      0.18,
    );
    clip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = INK;
    for (let y = heroY - heroScale * 30; y < heroY + heroScale * 23; y += 4) {
      for (let x = heroX - heroScale * 28; x < heroX + heroScale * 28; x += 4) {
        if (x < heroX - heroScale * 14 || x > heroX + heroScale * 16)
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
    ctx.restore();
    // Printed slash and offset drop silhouette ground the oversized portrait.
    poly(
      ctx,
      [
        [heroX - heroScale * 27, heroY + heroScale * 18],
        [w, heroY + heroScale * 8],
        [w, heroY + heroScale * 15],
        [heroX - heroScale * 24, heroY + heroScale * 24],
      ],
      RED,
    );
    ctx.save();
    ctx.translate(heroX, heroY + bob);
    ctx.rotate(-0.12);
    this.drawMage(0, 0, heroScale, this.time * 0.6, false, true);
    ctx.restore();
    // Foreground shrapnel shares the world's restricted printing palette.
    for (let i = 0; i < 17; i++) {
      const seed = i * 11;
      const x = heroX + (hash(seed) - 0.5) * heroScale * 63;
      const y = heroY + (hash(seed + 1) - 0.5) * heroScale * 59;
      const drift = this.reduced ? 0 : Math.sin(this.time * 0.6 + i) * 3;
      const r = 1 + hash(seed + 2) * 3;
      if (x < w * 0.51) continue;
      poly(
        ctx,
        [
          [x, y + drift - r * 2],
          [x + r, y + drift],
          [x - r, y + drift + r],
        ],
        i % 3 === 0 ? PAPER : i % 3 === 1 ? GOLD : RED,
      );
    }
    // Quiet ink texture is deterministic; it does not flicker between frames.
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = PAPER;
    for (let i = 0; i < 100; i++) {
      const x = hash(i * 5 + 301) * w * 0.46;
      const y = hash(i * 7 + 501) * h;
      ctx.fillRect(Math.round(x), Math.round(y), i % 5 === 0 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;
  }
}
