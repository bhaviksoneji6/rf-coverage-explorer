import { describe, expect, it } from 'vitest';
import { aoiKey, makeAoi, siteNeedsNewAoi } from '../src/geo/aoi.js';
import { toUtm } from '../src/geo/utm.js';

const CENTER = { lon: -122.33, lat: 47.61 };

function utm(lon: number, lat: number, aoi: ReturnType<typeof makeAoi>) {
  return toUtm({ lon, lat }, aoi.zone);
}

describe('when a site move requires reloading the AOI', () => {
  const aoi = makeAoi(CENTER, 30000);

  it('does not reload for a site sitting at the centre', () => {
    expect(siteNeedsNewAoi(aoi, aoi.center.e, aoi.center.n)).toBe(false);
  });

  it('does not reload for small moves -- the regression this replaces', () => {
    // The original check asked whether a full-size AOI centred on the new position fitted
    // inside the current one. That is false for ANY movement, so every drag refetched.
    for (const d of [1, 10, 100, 1000, 5000]) {
      expect(siteNeedsNewAoi(aoi, aoi.center.e + d, aoi.center.n)).toBe(false);
      expect(siteNeedsNewAoi(aoi, aoi.center.e, aoi.center.n - d)).toBe(false);
      expect(siteNeedsNewAoi(aoi, aoi.center.e + d, aoi.center.n + d)).toBe(false);
    }
  });

  it('does not reload anywhere inside the margin, including diagonals', () => {
    const safe = aoi.sideM / 2 - aoi.sideM * 0.1 - 1;
    expect(siteNeedsNewAoi(aoi, aoi.center.e + safe, aoi.center.n)).toBe(false);
    expect(siteNeedsNewAoi(aoi, aoi.center.e - safe, aoi.center.n + safe)).toBe(false);
  });

  it('reloads once the site crosses the edge margin', () => {
    const past = aoi.sideM / 2 - aoi.sideM * 0.1 + 1;
    expect(siteNeedsNewAoi(aoi, aoi.center.e + past, aoi.center.n)).toBe(true);
    expect(siteNeedsNewAoi(aoi, aoi.center.e, aoi.center.n - past)).toBe(true);
  });

  it('reloads for a site outside the box entirely', () => {
    const p = utm(-121.5, 47.61, aoi);
    expect(siteNeedsNewAoi(aoi, p.e, p.n)).toBe(true);
  });

  it('honours a custom margin', () => {
    const e = aoi.center.e + aoi.sideM / 2 - 100;
    expect(siteNeedsNewAoi(aoi, e, aoi.center.n, 0)).toBe(false);
    expect(siteNeedsNewAoi(aoi, e, aoi.center.n, 0.2)).toBe(true);
  });
});

describe('aoiKey', () => {
  it('is stable for the same area', () => {
    expect(aoiKey(makeAoi(CENTER, 30000))).toBe(aoiKey(makeAoi(CENTER, 30000)));
  });

  it('changes when the area size changes', () => {
    expect(aoiKey(makeAoi(CENTER, 30000))).not.toBe(aoiKey(makeAoi(CENTER, 20000)));
  });

  it('changes when the area moves', () => {
    expect(aoiKey(makeAoi(CENTER, 30000))).not.toBe(
      aoiKey(makeAoi({ lon: -122.0, lat: 47.61 }, 30000)),
    );
  });

  it('is insensitive to sub-metre jitter, so a redrag cannot force a refetch', () => {
    // 1e-7 degrees is about 1 cm.
    const a = aoiKey(makeAoi(CENTER, 30000));
    const b = aoiKey(makeAoi({ lon: CENTER.lon + 1e-7, lat: CENTER.lat }, 30000));
    expect(a).toBe(b);
  });
});
