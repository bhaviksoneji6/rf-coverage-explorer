import type { Site } from './types.js';

/**
 * Categorical slots in fixed order, from the validated palette.
 *
 * The order is the colour-vision-safety mechanism, not decoration, so sites take slots in
 * sequence and a slot never changes once assigned -- disabling site 2 must not repaint
 * sites 3 and 4.
 *
 * Honest limitation: a serving-site map is a categorical map, where any two colours can end
 * up adjacent. The palette clears the all-pairs accessibility gates for three slots; past
 * that, colour alone is not sufficient to tell neighbouring sites apart. That is why every
 * site carries a name on its marker, in the legend and in the hover readout -- identity is
 * never left resting on hue.
 */
export const SITE_COLORS: readonly string[] = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export function siteColor(index: number): string {
  return SITE_COLORS[index % SITE_COLORS.length] as string;
}

/** A, B, C ... Z, AA, AB ... */
export function siteLabel(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function nextSiteName(sites: readonly Site[]): string {
  const used = new Set(sites.map((s) => s.name));
  for (let i = 0; ; i++) {
    const name = `Site ${siteLabel(i)}`;
    if (!used.has(name)) return name;
  }
}

/**
 * A new site inherits the selected one's radio configuration.
 *
 * Building a network means placing several similar sites, so copying is almost always what
 * is wanted; changing one afterwards is a single edit, whereas re-entering four parameters
 * per site is not.
 */
export function makeSite(
  lon: number,
  lat: number,
  sites: readonly Site[],
  template: Site | null,
): Site {
  return {
    id: `site-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: nextSiteName(sites),
    lon,
    lat,
    enabled: true,
    freqMHz: template?.freqMHz ?? 3700,
    eirpDbm: template?.eirpDbm ?? 55,
    txHeightM: template?.txHeightM ?? 30,
  };
}
