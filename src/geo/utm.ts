/**
 * WGS84 <-> UTM conversion (Snyder series, sub-centimetre within a zone).
 *
 * Why UTM and not Web Mercator or plain lon/lat: the whole engine works in metres.
 * At 47degN an EPSG:4326 grid has pixels that are 1.47x taller than they are wide, and
 * Web Mercator's scale factor is 1/cos(lat). Either would silently corrupt every
 * distance in every path profile. UTM gives a true square-metre grid, and both the
 * 3DEP and NLCD endpoints will reproject into it server-side.
 */

const A = 6378137.0; // WGS84 semi-major axis, metres
const F = 1 / 298.257223563; // flattening
const K0 = 0.9996; // UTM scale factor on the central meridian
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

const E2 = F * (2 - F); // first eccentricity squared
const EP2 = E2 / (1 - E2); // second eccentricity squared

const DEG = Math.PI / 180;

export interface LonLat {
  lon: number;
  lat: number;
}

export interface UtmPoint {
  e: number;
  n: number;
}

export interface UtmZone {
  /** 1..60 */
  zone: number;
  north: boolean;
  /** EPSG code: 32600+zone (north) or 32700+zone (south) */
  epsg: number;
  /** Central meridian, degrees */
  lambda0: number;
}

/**
 * Standard 6-degree zone rule. The Norway/Svalbard exceptions are deliberately not
 * implemented -- this tool targets the US, and applying them would change the EPSG
 * code we hand to the data endpoints.
 */
export function zoneFor({ lon, lat }: LonLat): UtmZone {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const north = lat >= 0;
  return {
    zone,
    north,
    epsg: (north ? 32600 : 32700) + zone,
    lambda0: (zone - 1) * 6 - 180 + 3,
  };
}

/** Meridional arc length from the equator to `phi` (radians). */
function meridianArc(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * phi))
  );
}

export function toUtm(p: LonLat, zone: UtmZone): UtmPoint {
  const phi = p.lat * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const nu = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = EP2 * cosPhi * cosPhi;

  // Normalise the longitude difference into [-180, 180) so zones near the
  // antimeridian don't blow up the series.
  let dLon = p.lon - zone.lambda0;
  while (dLon > 180) dLon -= 360;
  while (dLon < -180) dLon += 360;
  const a = dLon * DEG * cosPhi;

  const a2 = a * a;
  const a3 = a2 * a;
  const a4 = a2 * a2;
  const a5 = a4 * a;
  const a6 = a4 * a2;

  const e =
    FALSE_EASTING +
    K0 *
      nu *
      (a +
        ((1 - t + c) * a3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a5) / 120);

  const m = meridianArc(phi);
  let n =
    K0 *
    (m +
      nu *
        tanPhi *
        (a2 / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a6) / 720));

  if (!zone.north) n += FALSE_NORTHING_SOUTH;

  return { e, n };
}

export function toLonLat(p: UtmPoint, zone: UtmZone): LonLat {
  const x = p.e - FALSE_EASTING;
  const y = zone.north ? p.n : p.n - FALSE_NORTHING_SOUTH;

  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const e1_2 = e1 * e1;
  const e1_3 = e1_2 * e1;
  const e1_4 = e1_2 * e1_2;

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1_3) / 32) * Math.sin(2 * mu) +
    ((21 * e1_2) / 16 - (55 * e1_4) / 32) * Math.sin(4 * mu) +
    ((151 * e1_3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1_4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const c1 = EP2 * cosPhi1 * cosPhi1;
  const t1 = tanPhi1 * tanPhi1;
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const d = x / (n1 * K0);

  const d2 = d * d;
  const d3 = d2 * d;
  const d4 = d2 * d2;
  const d5 = d4 * d;
  const d6 = d4 * d2;

  const phi =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      (d2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d6) / 720);

  const lam =
    (d -
      ((1 + 2 * t1 + c1) * d3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d5) / 120) /
    cosPhi1;

  return { lon: zone.lambda0 + lam / DEG, lat: phi / DEG };
}
