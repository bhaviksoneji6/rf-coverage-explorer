import { describe, expect, it } from 'vitest';
import { fitAoiToSites, makeAoi, siteNeedsNewAoi, AOI_EDGE_MARGIN } from '../src/geo/aoi.js';
import { toUtm } from '../src/geo/utm.js';
import { makeSite, nextSiteName, siteColor, siteLabel, SITE_COLORS } from '../src/store/sites.js';
import type { Site } from '../src/store/types.js';

describe('site naming', () => {
  it('labels A..Z then AA', () => {
    expect(siteLabel(0)).toBe('A');
    expect(siteLabel(1)).toBe('B');
    expect(siteLabel(25)).toBe('Z');
    expect(siteLabel(26)).toBe('AA');
    expect(siteLabel(27)).toBe('AB');
  });

  it('skips names already taken, so deleting the middle site does not collide', () => {
    const sites = [{ name: 'Site A' }, { name: 'Site C' }] as Site[];
    expect(nextSiteName(sites)).toBe('Site B');
    expect(nextSiteName([...sites, { name: 'Site B' } as Site])).toBe('Site D');
  });
});

describe('site colours', () => {
  it('assigns slots in fixed order', () => {
    expect(siteColor(0)).toBe(SITE_COLORS[0]);
    expect(siteColor(2)).toBe(SITE_COLORS[2]);
  });

  it('cycles past the end of the palette rather than generating hues', () => {
    expect(siteColor(SITE_COLORS.length)).toBe(SITE_COLORS[0]);
  });

  it('keeps every palette slot distinct', () => {
    expect(new Set(SITE_COLORS).size).toBe(SITE_COLORS.length);
  });
});

describe('makeSite', () => {
  const template: Site = {
    id: 'a',
    name: 'Site A',
    lon: -122,
    lat: 47,
    enabled: true,
    freqMHz: 2412,
    eirpDbm: 43.5,
    txHeightM: 62,
  };

  it('inherits the radio configuration of the selected site', () => {
    const s = makeSite(-122.5, 47.5, [template], template);
    expect(s.freqMHz).toBe(2412);
    expect(s.eirpDbm).toBe(43.5);
    expect(s.txHeightM).toBe(62);
    expect(s.lon).toBe(-122.5);
    expect(s.enabled).toBe(true);
  });

  it('falls back to defaults when there is nothing to copy', () => {
    const s = makeSite(-122.5, 47.5, [], null);
    expect(s.freqMHz).toBe(3700);
    expect(s.eirpDbm).toBe(55);
    expect(s.txHeightM).toBe(30);
  });

  it('gives every site a distinct id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeSite(0, 0, [], null).id));
    expect(ids.size).toBe(50);
  });
});

describe('fitAoiToSites', () => {
  const A = { lon: -122.33, lat: 47.61 };

  it('returns null with no sites', () => {
    expect(fitAoiToSites([])).toBeNull();
  });

  it('centres on a single site with zero span', () => {
    const fit = fitAoiToSites([A]);
    expect(fit?.spanM).toBeCloseTo(0, 3);
    expect(fit?.center.lon).toBeCloseTo(A.lon, 6);
    expect(fit?.center.lat).toBeCloseTo(A.lat, 6);
  });

  it('centres between two sites and reports their span', () => {
    const B = { lon: -122.33, lat: 47.79 }; // ~20 km north
    const fit = fitAoiToSites([A, B]);
    expect(fit?.spanM).toBeGreaterThan(19000);
    expect(fit?.spanM).toBeLessThan(21000);
    expect(fit?.center.lat).toBeCloseTo((A.lat + B.lat) / 2, 4);
  });

  it('requires a side bigger than the span, because of the edge margin', () => {
    const B = { lon: -122.33, lat: 47.79 };
    const fit = fitAoiToSites([A, B]);
    expect(fit?.requiredSideM).toBeGreaterThan(fit?.spanM as number);
    // span / (1 - 2*margin)
    expect(fit?.requiredSideM).toBeCloseTo(
      (fit?.spanM as number) / (1 - 2 * AOI_EDGE_MARGIN),
      3,
    );
  });

  it('produces a size that actually fits every site inside the margin', () => {
    const sites = [A, { lon: -122.1, lat: 47.7 }, { lon: -122.5, lat: 47.5 }];
    const fit = fitAoiToSites(sites);
    const aoi = makeAoi(fit?.center as { lon: number; lat: number }, (fit?.requiredSideM as number) + 1);
    for (const site of sites) {
      const p = toUtm(site, aoi.zone);
      expect(siteNeedsNewAoi(aoi, p.e, p.n)).toBe(false);
    }
  });

  it('does not fit them at the current size when they are too spread out', () => {
    const sites = [A, { lon: -121.6, lat: 47.61 }]; // ~55 km apart
    const fit = fitAoiToSites(sites);
    expect(fit?.requiredSideM).toBeGreaterThan(30000);

    // The rule is to warn, not to grow: at 30 km the outer sites genuinely fall outside.
    const aoi = makeAoi(fit?.center as { lon: number; lat: number }, 30000);
    const outside = sites.filter((site) => {
      const p = toUtm(site, aoi.zone);
      return siteNeedsNewAoi(aoi, p.e, p.n);
    });
    expect(outside.length).toBeGreaterThan(0);
  });
});
