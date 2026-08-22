import { siteColor } from '../store/sites.js';
import type { Store } from '../store/store.js';
import type { AppState, Site } from '../store/types.js';

export interface SiteListHandle {
  render(): void;
}

/**
 * The site list.
 *
 * Placement is modal by choice: a stray click on the map should never create a site, since
 * inspecting the map is a constant activity and creating one is not. The button arms the
 * map, the next click places, and the mode ends immediately.
 *
 * Every row carries the site name next to its colour swatch, and the same name appears on
 * the map marker and in the hover readout. That redundancy is deliberate -- a serving-site
 * map is categorical, and past three sites colour alone cannot be relied on to tell
 * neighbours apart.
 */
export function createSiteList(
  root: HTMLElement,
  store: Store<AppState>,
  actions: {
    onSelect(id: string): void;
    onRemove(id: string): void;
    onToggle(id: string, enabled: boolean): void;
    onRename(id: string, name: string): void;
    onStartPlacing(): void;
  },
): SiteListHandle {
  function render(): void {
    const s = store.get();
    root.replaceChildren();

    const list = document.createElement('div');
    list.className = 'site-list';

    s.sites.forEach((site: Site, i: number) => {
      const row = document.createElement('div');
      row.className = `site-row${site.id === s.selectedSiteId ? ' selected' : ''}`;

      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = site.enabled;
      on.title = 'Include in the network';
      on.setAttribute('aria-label', `${site.name} enabled`);
      on.addEventListener('change', () => actions.onToggle(site.id, on.checked));

      const sw = document.createElement('span');
      sw.className = 'site-swatch';
      sw.style.background = siteColor(i);
      if (!site.enabled) sw.style.opacity = '0.3';

      const name = document.createElement('input');
      name.className = 'site-name';
      name.type = 'text';
      name.value = site.name;
      name.setAttribute('aria-label', `${site.name} name`);
      name.addEventListener('change', () => actions.onRename(site.id, name.value.trim() || site.name));
      name.addEventListener('focus', () => actions.onSelect(site.id));

      const meta = document.createElement('span');
      meta.className = 'site-meta';
      meta.textContent = `${site.freqMHz} MHz`;

      const del = document.createElement('button');
      del.className = 'site-del';
      del.type = 'button';
      del.textContent = '✕';
      del.title = `Remove ${site.name}`;
      del.setAttribute('aria-label', `Remove ${site.name}`);
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        actions.onRemove(site.id);
      });

      row.addEventListener('click', () => actions.onSelect(site.id));
      row.append(on, sw, name, meta, del);
      list.append(row);
    });

    root.append(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = `add-site${s.placing ? ' arming' : ''}`;
    add.textContent = s.placing ? 'Click the map to place… (Esc to cancel)' : '+ Add site';
    add.addEventListener('click', actions.onStartPlacing);
    root.append(add);

    if (s.sites.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'sub';
      hint.style.margin = '8px 0 0';
      hint.textContent = 'No sites yet. Add one to compute coverage.';
      root.append(hint);
    }
  }

  render();
  return { render };
}
