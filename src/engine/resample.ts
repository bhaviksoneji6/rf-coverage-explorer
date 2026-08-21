import type { GridSpec } from './types.js';

const TWO_PI = Math.PI * 2;

/**
 * Resample a radial field onto the output grid.
 *
 * Deliberately grid<-radial rather than scattering radial samples outward: iterating over
 * destination bins and pulling from the radial array makes unfilled bins structurally
 * impossible, which scattering cannot guarantee.
 *
 * Bins beyond maximum range are filled with `fill` (NaN) so the renderer can mask them.
 */
export function resampleRadialToGrid(
  field: Float32Array,
  nRadials: number,
  nSteps: number,
  stepM: number,
  txE: number,
  txN: number,
  grid: GridSpec,
  out: Float32Array,
  fill = NaN,
  /** Angular quantities must be interpolated on the unit circle, not linearly. */
  angular = false,
): Float32Array {
  const maxRange = nSteps * stepM;
  const { width, height, binM } = grid;

  for (let j = 0; j < height; j++) {
    const n = grid.maxN - (j + 0.5) * binM;
    const dy = n - txN;
    const rowBase = j * width;

    for (let i = 0; i < width; i++) {
      const e = grid.minE + (i + 0.5) * binM;
      const dx = e - txE;
      const r = Math.hypot(dx, dy);

      if (r > maxRange) {
        out[rowBase + i] = fill;
        continue;
      }

      let theta = Math.atan2(dx, dy);
      if (theta < 0) theta += TWO_PI;

      const fk = (theta / TWO_PI) * nRadials;
      const k0 = Math.floor(fk) % nRadials;
      const k1 = (k0 + 1) % nRadials;
      const tk = fk - Math.floor(fk);

      // Radial sample index s holds distance (s+1)*stepM.
      let fs = r / stepM - 1;
      if (fs < 0) fs = 0;
      else if (fs > nSteps - 1) fs = nSteps - 1;
      const s0 = Math.floor(fs);
      const s1 = s0 + 1 < nSteps ? s0 + 1 : s0;
      const ts = fs - s0;

      const a = field[k0 * nSteps + s0] as number;
      const b = field[k0 * nSteps + s1] as number;
      const c = field[k1 * nSteps + s0] as number;
      const d = field[k1 * nSteps + s1] as number;

      if (angular) {
        // Interpolate sin/cos so a wrap across +-pi does not produce a spurious sweep.
        const sn =
          (Math.sin(a) + (Math.sin(b) - Math.sin(a)) * ts) * (1 - tk) +
          (Math.sin(c) + (Math.sin(d) - Math.sin(c)) * ts) * tk;
        const cs =
          (Math.cos(a) + (Math.cos(b) - Math.cos(a)) * ts) * (1 - tk) +
          (Math.cos(c) + (Math.cos(d) - Math.cos(c)) * ts) * tk;
        out[rowBase + i] = Math.atan2(sn, cs);
      } else {
        const lo = a + (b - a) * ts;
        const hi = c + (d - c) * ts;
        out[rowBase + i] = lo + (hi - lo) * tk;
      }
    }
  }

  return out;
}
