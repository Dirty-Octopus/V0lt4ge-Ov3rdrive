import { depthAtScale, TUNNEL_DITHER } from "./tunnel.js";

export const FOG_COLOR = [17, 17, 27];
export const FOG_NEAR = 0.04;
export const FOG_DENSITY = 1.9;

// Exponential-squared extinction in world depth, independent of time/FOV.
export function depthFog(z, emission = 0) {
  const distance = Math.max(0, z - FOG_NEAR);
  return (1 - Math.exp(-((distance * FOG_DENSITY) ** 2))) * (1 - emission);
}

const tintCache = new Map();
export function fogTint(color, z, emission = 0) {
  const amount = Math.round(depthFog(z, emission) * 255);
  if (!amount) return color;
  const key = `${color}:${amount}`;
  if (!tintCache.has(key)) {
    const rgb = Number.parseInt(color.slice(1), 16);
    const channels = [rgb >> 16, (rgb >> 8) & 255, rgb & 255];
    const tinted = channels.map((channel, i) =>
      Math.round(channel + (FOG_COLOR[i] - channel) * amount / 255));
    tintCache.set(key, `rgb(${tinted.join(",")})`);
  }
  return tintCache.get(key);
}

/** Reconstruct the depth of the twelve-sided wall at a normalized pixel. */
export function wallDepth(x, y) {
  const angle = Math.atan2(x, -y);
  const facetAngle = angle - Math.round(angle / (Math.PI / 6)) * Math.PI / 6;
  const scale = Math.hypot(x, y) * Math.cos(facetAngle) / Math.cos(Math.PI / 12);
  return depthAtScale(Math.max(0.0001, scale));
}

export function fogMaskPixels(size) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fog = depthFog(wallDepth((x + 0.5) * 2 / size - 1,
        (y + 0.5) * 2 / size - 1));
      // Stable print grain softens the final palette filter's color thresholds.
      // It never introduces moving noise or fog on the near play surface.
      const grain = (TUNNEL_DITHER[(y % 8) * 8 + x % 8] - 0.5) *
        fog * (1 - fog) * 0.3;
      const index = (y * size + x) * 4;
      pixels.set(FOG_COLOR, index);
      pixels[index + 3] = Math.round((fog + grain) * 255);
    }
  }
  return pixels;
}

export function createFogMask(document) {
  const mask = document.createElement("canvas");
  mask.width = mask.height = 256;
  const ctx = mask.getContext("2d");
  const image = ctx.createImageData(mask.width, mask.height);
  image.data.set(fogMaskPixels(mask.width));
  ctx.putImageData(image, 0, 0);
  return mask;
}
