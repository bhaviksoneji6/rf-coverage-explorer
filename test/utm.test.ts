import { describe, expect, it } from 'vitest';
import { toLonLat, toUtm, zoneFor } from '../src/geo/utm.js';

describe('UTM zone selection', () => {
  it('puts Seattle in zone 10N / EPSG:32610', () => {
    const z = zoneFor({ lon: -122.33, lat: 47.61 });
    expect(z.zone).toBe(10);
    expect(z.north).toBe(true);
    expect(z.epsg).toBe(32610);
    expect(z.lambda0).toBe(-123);
  });

  it('handles southern hemisphere EPSG codes', () => {
    const z = zoneFor({ lon: 151.2, lat: -33.87 });
    expect(z.zone).toBe(56);
    expect(z.epsg).toBe(32756);
  });

  it('clamps to valid zone numbers at the antimeridian', () => {
    expect(zoneFor({ lon: 180, lat: 0 }).zone).toBeLessThanOrEqual(60);
    expect(zoneFor({ lon: -180, lat: 0 }).zone).toBeGreaterThanOrEqual(1);
  });
});

describe('UTM round trip', () => {
  const cases = [
    { lon: -122.33, lat: 47.61, label: 'Seattle' },
    { lon: -104.99, lat: 39.74, label: 'Denver' },
    { lon: -80.19, lat: 25.76, label: 'Miami' },
    { lon: -149.9, lat: 61.22, label: 'Anchorage' },
    { lon: 151.2, lat: -33.87, label: 'Sydney' },
  ];

  for (const c of cases) {
    it(`round-trips ${c.label} to sub-centimetre`, () => {
      const zone = zoneFor(c);
      const back = toLonLat(toUtm(c, zone), zone);
      // 1e-7 degrees is ~1.1 cm of latitude.
      expect(back.lon).toBeCloseTo(c.lon, 7);
      expect(back.lat).toBeCloseTo(c.lat, 7);
    });
  }

  it('places a point on the central meridian at the false easting', () => {
    const zone = zoneFor({ lon: -123, lat: 47.61 });
    const p = toUtm({ lon: -123, lat: 47.61 }, zone);
    expect(p.e).toBeCloseTo(500000, 3);
  });
});

/**
 * Longitude degrees spanning `metres` along a parallel on the WGS84 ellipsoid.
 *
 * The familiar 111320*cos(lat) shortcut uses a spherical radius and is ~0.18% short at this
 * latitude -- enough to make a "1 km" test step actually 1001.8 m and produce a spurious
 * failure. A degree of longitude subtends the prime-vertical radius, not the mean radius.
 */
function lonDegreesFor(metres: number, latDeg: number): number {
  const a = 6378137.0;
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const phi = (latDeg * Math.PI) / 180;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return (metres / (nu * Math.cos(phi))) * (180 / Math.PI);
}

describe('UTM as a true metre grid', () => {
  it('maps 1 km of ground distance to 1 km of grid distance', () => {
    const lon = -122.33;
    const lat = 47.61;
    const zone = zoneFor({ lon, lat });
    const a = toUtm({ lon, lat }, zone);
    const b = toUtm({ lon: lon + lonDegreesFor(1000, lat), lat }, zone);

    // Residual is UTM's 0.9996 central-meridian scale factor, growing back toward 1 with
    // distance from the meridian: a few tenths of a metre per kilometre here.
    const gridDistance = Math.hypot(b.e - a.e, b.n - a.n);
    expect(gridDistance).toBeGreaterThan(999);
    expect(gridDistance).toBeLessThan(1001);
  });

  it('exhibits grid convergence: a parallel is not a horizontal grid line', () => {
    const lon = -122.33;
    const lat = 47.61;
    const zone = zoneFor({ lon, lat });
    const a = toUtm({ lon, lat }, zone);
    const b = toUtm({ lon: lon + lonDegreesFor(1000, lat), lat }, zone);

    // Convergence gamma ~ (lon - lon0)*sin(lat), so moving 1 km along a parallel shifts
    // northing by ~1000*sin(gamma) -- about 8.7 m here. This is real geometry, not error,
    // and it is one reason the engine works in projected metres rather than in lon/lat.
    const gamma =
      (((lon - zone.lambda0) * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180);
    expect(b.n - a.n).toBeCloseTo(1000 * Math.sin(gamma), 0);
    expect(Math.abs(b.n - a.n)).toBeGreaterThan(5);
  });
});
