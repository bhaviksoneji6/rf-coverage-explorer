/**
 * Generates the app icons.
 *
 *   npm run icons
 *
 * Kept as a script rather than committing only the PNGs so the artwork is reproducible and
 * editable -- the icon is drawn from the same blue ramp the coverage map uses, so if that
 * palette ever changes the icon can follow it.
 *
 * Draws analytically with per-pixel coverage rather than supersampling: every shape here is
 * a distance field (rings, a mast, a terrain curve), so exact edge coverage is cheaper and
 * cleaner than 4x downsampling would be.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

type RGB = [number, number, number];

// The coverage ramp, so the icon and the map are visibly the same product.
const BG: RGB = [0x0d, 0x36, 0x6b]; // blue 700
const TERRAIN: RGB = [0x18, 0x4f, 0x95]; // blue 600
const ARC_NEAR: RGB = [0xcd, 0xe2, 0xfb]; // blue 100 -- strongest signal, lightest
const ARC_MID: RGB = [0x86, 0xb6, 0xef]; // blue 250
const ARC_FAR: RGB = [0x39, 0x87, 0xe5]; // blue 400
const MAST: RGB = [0xff, 0xff, 0xff];

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Coverage of a pixel by a shape whose signed distance is `sd` (negative = inside). */
function cover(sd: number, aa: number): number {
  return Math.max(0, Math.min(1, 0.5 - sd / aa));
}

/**
 * @param size    output edge length in pixels
 * @param inset   fraction of the canvas kept clear on every side; Android maskable icons
 *                crop to a circle, so their content has to live inside a safe zone.
 */
function render(size: number, inset = 0): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const aa = 1.5; // edge softness in pixels

  // Composition is defined in unit space, then mapped through the inset.
  const scale = 1 - 2 * inset;
  const U = (u: number) => (inset + u * scale) * size;
  const L = (u: number) => u * scale * size; // a length, not a position

  const apexX = U(0.5);
  const apexY = U(0.46);
  // Spacing is set by legibility at 60 px, not by how it looks at 512: the gap between
  // rings has to survive being ~2.7 px on an iPhone home screen.
  const ringT = L(0.03); // ring half-thickness
  const rings: { r: number; c: RGB }[] = [
    { r: L(0.13), c: ARC_NEAR },
    { r: L(0.235), c: ARC_MID },
    { r: L(0.34), c: ARC_FAR },
  ];

  // Terrain ridge: two cosines so it reads as landscape rather than a wave.
  const terrainY = (x: number): number => {
    const u = (x / size - inset) / scale;
    const h = 0.13 * Math.cos(u * 5.2 - 1.1) + 0.055 * Math.cos(u * 11.3 + 2.2);
    return U(0.725 - h);
  };

  const mastHalf = L(0.014);
  const mastTop = apexY;
  const mastBot = U(0.725);
  const dotR = L(0.036);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let c: RGB = BG;

      const dx = cx - apexX;
      const dy = cy - apexY;
      const r = Math.hypot(dx, dy);
      const groundY = terrainY(cx);

      // Rings, drawn only above the ridge and only in the upper fan, so they read as
      // radiating from the mast rather than as concentric decoration.
      if (cy < groundY) {
        // Fade the fan out near the horizontal so the rings do not end in hard stubs.
        const fan = Math.max(0, Math.min(1, (0.62 - dy / (r || 1)) / 0.3));
        for (const ring of rings) {
          const a = cover(Math.abs(r - ring.r) - ringT, aa) * fan;
          if (a > 0) c = mix(c, ring.c, a);
        }
      }

      // Terrain silhouette.
      c = mix(c, TERRAIN, cover(groundY - cy, aa));

      // Mast, then the source dot on top of it.
      const mastA =
        cover(Math.abs(cx - apexX) - mastHalf, aa) *
        cover(mastTop - cy, aa) *
        cover(cy - mastBot, aa);
      c = mix(c, MAST, mastA);
      c = mix(c, MAST, cover(r - dotR, aa));

      const o = (y * size + x) * 4;
      px[o] = Math.round(c[0]);
      px[o + 1] = Math.round(c[1]);
      px[o + 2] = Math.round(c[2]);
      px[o + 3] = 255;
    }
  }
  return px;
}

// --- minimal PNG encoder (RGBA, filter 0) ------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = ((CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(px: Uint8Array, size: number): Uint8Array {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- outputs -----------------------------------------------------------------------------

mkdirSync('public', { recursive: true });

const targets: { file: string; size: number; inset: number }[] = [
  // iOS home screen. Safari applies its own rounding, so this is drawn full-bleed.
  { file: 'public/apple-touch-icon.png', size: 180, inset: 0 },
  { file: 'public/icon-192.png', size: 192, inset: 0 },
  { file: 'public/icon-512.png', size: 512, inset: 0 },
  // Android maskable icons get cropped to a circle, so content needs a safe zone.
  { file: 'public/icon-maskable-512.png', size: 512, inset: 0.1 },
  { file: 'public/favicon-64.png', size: 64, inset: 0 },
];

for (const t of targets) {
  const png = encodePng(render(t.size, t.inset), t.size);
  writeFileSync(t.file, png);
  console.log(`  ${t.file.padEnd(34)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} kB`);
}
console.log('\nIcons written.');
