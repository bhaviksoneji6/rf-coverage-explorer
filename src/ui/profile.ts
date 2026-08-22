import type { Profile } from '../engine/profile.js';
import { CLUTTER_COLORS, CLUTTER_NAMES } from '../providers/types.js';

/**
 * Terrain cross-section along the transmitter-to-cursor path.
 *
 * This is the feature that makes propagation legible rather than merely colourful: a
 * coverage map shows you that signal dies behind a ridge, and this shows you the ridge. It
 * draws the earth-flattened datum, the bare-earth silhouette, the land-cover band, the
 * direct ray, the first Fresnel ellipse, and the controlling knife edge when there is one.
 *
 * Chart chrome deliberately stays in muted ink so the data marks carry the attention.
 */

interface Ink {
  surface: string;
  text: string;
  muted: string;
  grid: string;
  terrain: string;
  ray: string;
  fresnel: string;
  edge: string;
  blocked: string;
}

function inkFor(dark: boolean): Ink {
  return dark
    ? {
        surface: '#1a1a19',
        text: '#ffffff',
        muted: '#898781',
        grid: '#2c2c2a',
        terrain: '#4a4842',
        ray: '#3987e5',
        fresnel: 'rgba(57,135,229,0.28)',
        edge: '#e66767',
        blocked: 'rgba(230,103,103,0.16)',
      }
    : {
        surface: '#fcfcfb',
        text: '#0b0b0b',
        muted: '#898781',
        grid: '#e1e0d9',
        terrain: '#c3c2b7',
        ray: '#2a78d6',
        fresnel: 'rgba(42,120,214,0.22)',
        edge: '#d03b3b',
        blocked: 'rgba(208,59,59,0.12)',
      };
}

export interface ProfileChart {
  draw(p: Profile | null, opts: { freqMHz: number; eirpDbm: number; clutterLossDb: number }): void;
  destroy(): void;
}

export function createProfileChart(canvas: HTMLCanvasElement, readout: HTMLElement): ProfileChart {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('profile: no 2D context');
  // Re-bind after the guard: TypeScript drops the narrowing inside the nested draw closure.
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let last: { p: Profile | null; o: Parameters<ProfileChart['draw']>[1] } | null = null;

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    if (last) draw(last.p, last.o);
  };
  media.addEventListener('change', onScheme);

  function draw(p: Profile | null, o: Parameters<ProfileChart['draw']>[1]): void {
    last = { p, o };

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 150;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const dark = media.matches && !document.documentElement.dataset['theme'];
    const ink = inkFor(dark || document.documentElement.dataset['theme'] === 'dark');

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = ink.surface;
    ctx.fillRect(0, 0, cssW, cssH);

    if (!p || p.totalM < 1) {
      ctx.fillStyle = ink.muted;
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Move the cursor over the map to see the path profile', cssW / 2, cssH / 2);
      readout.textContent = '';
      return;
    }

    const padL = 40;
    const padR = 10;
    const padT = 10;
    const padB = 20;
    const clutterBandH = 6;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB - clutterBandH;

    // Vertical extent: everything that must be visible, including the Fresnel envelope.
    let zMin = Infinity;
    let zMax = -Infinity;
    const n = p.d.length;
    for (let i = 0; i < n; i++) {
      const gz = (p.ground[i] as number) - (p.drop[i] as number);
      const rayZ = p.txZ + ((p.rxZ - p.txZ) * (p.d[i] as number)) / p.totalM;
      const f = p.fresnel[i] as number;
      if (gz < zMin) zMin = gz;
      if (gz > zMax) zMax = gz;
      if (rayZ - f < zMin) zMin = rayZ - f;
      if (rayZ + f > zMax) zMax = rayZ + f;
    }
    zMin = Math.min(zMin, p.txZ, p.rxZ);
    zMax = Math.max(zMax, p.txZ, p.rxZ);
    const span = Math.max(20, zMax - zMin);
    zMin -= span * 0.08;
    zMax += span * 0.08;

    const X = (d: number) => padL + (d / p.totalM) * plotW;
    const Y = (z: number) => padT + plotH - ((z - zMin) / (zMax - zMin)) * plotH;

    // --- grid + axis labels (recessive) ---
    ctx.strokeStyle = ink.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = ink.muted;
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 2; k++) {
      const z = zMin + ((zMax - zMin) * k) / 2;
      const y = Math.round(Y(z)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(z)} m`, padL - 5, y);
    }

    // --- shaded band where the ray is blocked ---
    if (!p.los && p.obstacleIndex >= 0) {
      ctx.fillStyle = ink.blocked;
      ctx.fillRect(X(p.d[p.obstacleIndex] as number), padT, plotW - (X(p.d[p.obstacleIndex] as number) - padL), plotH);
    }

    // --- first Fresnel ellipse ---
    ctx.fillStyle = ink.fresnel;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const di = p.d[i] as number;
      const rayZ = p.txZ + ((p.rxZ - p.txZ) * di) / p.totalM;
      const y = Y(rayZ + (p.fresnel[i] as number));
      i === 0 ? ctx.moveTo(X(di), y) : ctx.lineTo(X(di), y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const di = p.d[i] as number;
      const rayZ = p.txZ + ((p.rxZ - p.txZ) * di) / p.totalM;
      ctx.lineTo(X(di), Y(rayZ - (p.fresnel[i] as number)));
    }
    ctx.closePath();
    ctx.fill();

    // --- terrain silhouette ---
    ctx.fillStyle = ink.terrain;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(zMin));
    for (let i = 0; i < n; i++) {
      ctx.lineTo(X(p.d[i] as number), Y((p.ground[i] as number) - (p.drop[i] as number)));
    }
    ctx.lineTo(X(p.totalM), Y(zMin));
    ctx.closePath();
    ctx.fill();

    // --- land-cover band under the axis ---
    if (p.clutter) {
      const bandY = padT + plotH + 2;
      for (let i = 0; i < n - 1; i++) {
        const rgb = CLUTTER_COLORS[p.clutter[i] as number];
        if (!rgb) continue;
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        const x0 = X(p.d[i] as number);
        ctx.fillRect(x0, bandY, Math.max(1, X(p.d[i + 1] as number) - x0 + 0.5), clutterBandH);
      }
    }

    // --- direct ray ---
    ctx.strokeStyle = ink.ray;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(p.txZ));
    ctx.lineTo(X(p.totalM), Y(p.rxZ));
    ctx.stroke();

    // --- masts ---
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink.text;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(p.txGround));
    ctx.lineTo(X(0), Y(p.txZ));
    ctx.moveTo(X(p.totalM), Y(p.rxGround - (p.drop[n - 1] as number)));
    ctx.lineTo(X(p.totalM), Y(p.rxZ));
    ctx.stroke();

    // --- controlling knife edge ---
    if (p.obstacleIndex >= 0) {
      const x = X(p.d[p.obstacleIndex] as number);
      const y = Y((p.ground[p.obstacleIndex] as number) - (p.drop[p.obstacleIndex] as number));
      ctx.strokeStyle = ink.edge;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, padT);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = ink.edge;
      ctx.fill();
    }

    // --- distance axis ---
    ctx.fillStyle = ink.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    ctx.fillText('TX', padL, cssH - padB + 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${(p.totalM / 1000).toFixed(2)} km`, padL + plotW, cssH - padB + 4);

    // --- numeric readout, so identity never rests on colour alone ---
    const total = p.fsplDb + p.diffractionDb + o.clutterLossDb;
    const rsl = o.eirpDbm - total;
    const cls = p.clutter ? (p.clutter[n - 1] as number) : 0;
    readout.replaceChildren();
    const add = (label: string, value: string, tone?: string) => {
      const wrap = document.createElement('span');
      wrap.className = 'pf-stat';
      const l = document.createElement('span');
      l.className = 'pf-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'pf-value';
      if (tone) v.style.color = tone;
      v.textContent = value;
      wrap.append(l, v);
      readout.append(wrap);
    };
    add('Distance', `${(p.totalM / 1000).toFixed(2)} km`);
    add('Path', p.los ? 'Line of sight' : 'Obstructed', p.los ? undefined : ink.edge);
    add('Clearance', `${p.worstClearance >= 10 ? '>10' : p.worstClearance.toFixed(2)} F1`);
    add('FSPL', `${p.fsplDb.toFixed(1)} dB`);
    add('Diffraction', `${p.diffractionDb.toFixed(1)} dB`, p.diffractionDb > 0 ? ink.edge : undefined);
    add('Clutter', `${o.clutterLossDb.toFixed(1)} dB`);
    add('Total loss', `${total.toFixed(1)} dB`);
    add('RSL', `${rsl.toFixed(1)} dBm`);
    if (p.clutter) add('Ground', CLUTTER_NAMES[cls] ?? '—');
  }

  return {
    draw,
    destroy: () => media.removeEventListener('change', onScheme),
  };
}
