export type RampName = 'signal' | 'turbo';

/**
 * Sequential blue ramp, steps 100->700, light->dark.
 *
 * Signal strength is a magnitude, so it takes a single-hue sequential ramp rather than a
 * rainbow: a rainbow is not monotone in lightness and invents visual boundaries where the
 * data is smooth, which on a coverage map reads as contours that do not exist. The light
 * end means "near nothing" and is allowed to recede toward the basemap.
 */
const RAMP_SIGNAL: readonly [number, number, number][] = [
  [0xcd, 0xe2, 0xfb], // 100
  [0xb7, 0xd3, 0xf6], // 150
  [0x9e, 0xc5, 0xf4], // 200
  [0x86, 0xb6, 0xef], // 250
  [0x6d, 0xa7, 0xec], // 300
  [0x55, 0x98, 0xe7], // 350
  [0x39, 0x87, 0xe5], // 400
  [0x2a, 0x78, 0xd6], // 450
  [0x25, 0x6a, 0xbf], // 500
  [0x1c, 0x5c, 0xab], // 550
  [0x18, 0x4f, 0x95], // 600
  [0x10, 0x42, 0x81], // 650
  [0x0d, 0x36, 0x6b], // 700
];

/**
 * Turbo. Deliberately NOT the default.
 *
 * Offered only because every commercial RF planning tool renders coverage this way, and
 * being able to eyeball this tool's output against one of those is worth something. It is
 * perceptually non-uniform -- equal steps in dBm are not equal steps in apparent colour --
 * so read quantities off the legend, not the hue.
 */
const RAMP_TURBO: readonly [number, number, number][] = [
  [0x30, 0x12, 0x3b],
  [0x40, 0x45, 0xa2],
  [0x46, 0x75, 0xed],
  [0x39, 0xa2, 0xfc],
  [0x1b, 0xcf, 0xd4],
  [0x24, 0xec, 0xa6],
  [0x61, 0xfc, 0x6c],
  [0xa4, 0xfc, 0x3b],
  [0xd1, 0xe8, 0x34],
  [0xf3, 0xc5, 0x3a],
  [0xfe, 0x9b, 0x2d],
  [0xf3, 0x6d, 0x18],
  [0xd2, 0x3c, 0x05],
  [0xa1, 0x18, 0x01],
  [0x7a, 0x04, 0x03],
];

const RAMPS: Record<RampName, readonly [number, number, number][]> = {
  signal: RAMP_SIGNAL,
  turbo: RAMP_TURBO,
};

export const RAMP_LABELS: Record<RampName, string> = {
  signal: 'Signal (sequential)',
  turbo: 'Turbo (industry convention)',
};

/** Sample a ramp at t in [0,1]. */
export function sampleRamp(name: RampName, t: number): [number, number, number] {
  const ramp = RAMPS[name];
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const x = clamped * (ramp.length - 1);
  const i = Math.floor(x);
  const j = i + 1 < ramp.length ? i + 1 : i;
  const f = x - i;
  const a = ramp[i] as [number, number, number];
  const b = ramp[j] as [number, number, number];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export interface RasterizeOptions {
  min: number;
  max: number;
  ramp: RampName;
  /** 0..1 layer opacity. */
  opacity: number;
  /** Values below this are fully transparent, so the basemap reads through where there is no service. */
  threshold?: number;
}

/**
 * Turn a value grid into RGBA.
 *
 * Alpha carries exactly two things -- the global opacity and the below-threshold mask --
 * while colour carries magnitude. Keeping them separate is what makes the threshold slider
 * a pure re-render with no recomputation behind it.
 */
export function rasterize(
  values: Float32Array,
  out: Uint8ClampedArray<ArrayBuffer>,
  opts: RasterizeOptions,
): Uint8ClampedArray<ArrayBuffer> {
  const { min, max, ramp, opacity } = opts;
  const span = max - min || 1;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  const threshold = opts.threshold ?? Number.NEGATIVE_INFINITY;

  // Precompute the ramp so the per-pixel path is a lookup, not an interpolation.
  const LUT_N = 256;
  const lut = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const [r, g, b] = sampleRamp(ramp, i / (LUT_N - 1));
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }

  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    const o = i * 4;
    if (!Number.isFinite(v) || v < threshold) {
      out[o + 3] = 0;
      continue;
    }
    let t = (v - min) / span;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const li = ((t * (LUT_N - 1)) | 0) * 3;
    out[o] = lut[li] as number;
    out[o + 1] = lut[li + 1] as number;
    out[o + 2] = lut[li + 2] as number;
    out[o + 3] = alpha;
  }
  return out;
}
