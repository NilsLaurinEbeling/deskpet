// Generates the placeholder pet sprite and the app icons.
//
// The placeholder deliberately has an irregular outline (a notch between the
// ears, concave flanks, a gap under the tail) so the alpha hit mask from
// phase 1 can actually be tested: clicks in those holes must fall through to
// whatever window is underneath.
//
//   node scripts/gen-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIco, encodePng, raster } from './lib/png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ellipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const triangle = (x, y, a, b, c) => {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([x, y], a, b);
  const d2 = sign([x, y], b, c);
  const d3 = sign([x, y], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

// Distance to a quadratic bezier, sampled — precise enough at 3x supersampling.
const TAIL = [
  [196, 214],
  [252, 206],
  [236, 128],
];
const tail = (x, y) => {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i <= 48; i += 1) {
    const t = i / 48;
    const u = 1 - t;
    const px = u * u * TAIL[0][0] + 2 * u * t * TAIL[1][0] + t * t * TAIL[2][0];
    const py = u * u * TAIL[0][1] + 2 * u * t * TAIL[1][1] + t * t * TAIL[2][1];
    const d = Math.hypot(x - px, y - py);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  return best <= 11 - 5 * bestT;
};

/** The silhouette in a 256x256 box. */
const silhouette = (x, y) =>
  ellipse(x, y, 128, 188, 74, 62) || // body
  ellipse(x, y, 128, 100, 60, 54) || // head
  triangle(x, y, [84, 68], [62, 12], [120, 42]) || // left ear
  triangle(x, y, [172, 68], [194, 12], [136, 42]) || // right ear
  tail(x, y);

const mix = (a, b, t) => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});

const TOP = { r: 124, g: 138, b: 196 };
const BOTTOM = { r: 71, g: 84, b: 138 };
const BELLY = { r: 226, g: 231, b: 246 };
const INK = { r: 26, g: 32, b: 61 };

const petSample = (x, y) => {
  if (!silhouette(x, y)) return null;
  if (ellipse(x, y, 107, 98, 7.5, 9.5) || ellipse(x, y, 149, 98, 7.5, 9.5)) return INK;
  if (triangle(x, y, [122, 116], [134, 116], [128, 125])) return INK;
  if (ellipse(x, y, 128, 206, 40, 42)) return BELLY;
  return mix(TOP, BOTTOM, Math.min(1, Math.max(0, (y - 20) / 220)));
};

const write = (relPath, buf) => {
  const out = resolve(root, relPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log(`${relPath}  ${(buf.length / 1024).toFixed(1)} kB`);
};

// ---- placeholder sprite -----------------------------------------------------
const SPRITE = 256;
write(
  'public/pet-placeholder.png',
  encodePng({ width: SPRITE, height: SPRITE, rgba: raster(SPRITE, SPRITE, petSample) }),
);

// ---- app icon ---------------------------------------------------------------
const roundedRect = (x, y, size, radius) => {
  const inner = size - radius;
  const cx = Math.min(Math.max(x, radius), inner);
  const cy = Math.min(Math.max(y, radius), inner);
  return Math.hypot(x - cx, y - cy) <= radius;
};

const iconRgba = (size) => {
  const s = size / 256;
  return raster(size, size, (px, py) => {
    const x = px / s;
    const y = py / s;
    if (!roundedRect(px, py, size, size * 0.22)) return null;
    if (silhouette(x, y * 1.02 - 4)) {
      if (ellipse(x, y * 1.02 - 4, 107, 98, 7.5, 9.5) || ellipse(x, y * 1.02 - 4, 149, 98, 7.5, 9.5)) {
        return { r: 40, g: 48, b: 92 };
      }
      return { r: 244, g: 246, b: 252 };
    }
    return mix({ r: 88, g: 101, b: 168 }, { r: 47, g: 56, b: 104 }, py / size);
  });
};

const iconCache = new Map();
const icon = (size) => {
  if (!iconCache.has(size)) iconCache.set(size, { width: size, height: size, rgba: iconRgba(size) });
  return iconCache.get(size);
};

for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]) {
  write(`src-tauri/icons/${name}`, encodePng(icon(size)));
}
write('src-tauri/icons/icon.ico', encodeIco([icon(16), icon(32), icon(48), icon(256)]));
