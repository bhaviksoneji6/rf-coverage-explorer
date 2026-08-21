import { beforeEach, describe, expect, it } from 'vitest';
import { createStore, type Stage } from '../src/store/store.js';

interface S {
  area: number;
  freq: number;
  eirp: number;
  opacity: number;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function build() {
  const calls: Stage[] = [];
  const store = createStore<S>(
    { area: 30000, freq: 3700, eirp: 55, opacity: 0.8 },
    { area: 'data', freq: 'propagation', eirp: 'linkBudget', opacity: 'render' },
  );
  for (const stage of ['data', 'propagation', 'linkBudget', 'render'] as Stage[]) {
    store.on(stage, () => void calls.push(stage));
  }
  return { store, calls };
}

describe('latency-class pipeline', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('runs only the render stage for a Class 0 change', async () => {
    ctx.store.set({ opacity: 0.5 });
    await tick();
    expect(ctx.calls).toEqual(['render']);
  });

  it('runs link budget onward for a Class 1 change', async () => {
    ctx.store.set({ eirp: 40 });
    await tick();
    expect(ctx.calls).toEqual(['linkBudget', 'render']);
  });

  it('runs propagation onward for a Class 2 change', async () => {
    ctx.store.set({ freq: 700 });
    await tick();
    expect(ctx.calls).toEqual(['propagation', 'linkBudget', 'render']);
  });

  it('runs the whole pipeline for a Class 3 change', async () => {
    ctx.store.set({ area: 10000 });
    await tick();
    expect(ctx.calls).toEqual(['data', 'propagation', 'linkBudget', 'render']);
  });

  it('enters at the cheapest stage that covers every change in one batch', async () => {
    ctx.store.set({ opacity: 0.1, freq: 900 });
    await tick();
    expect(ctx.calls).toEqual(['propagation', 'linkBudget', 'render']);
  });

  it('coalesces rapid changes into a single run, as a dragged slider produces', async () => {
    for (let i = 0; i < 25; i++) ctx.store.set({ opacity: i / 25 });
    await tick();
    expect(ctx.calls).toEqual(['render']);
    expect(ctx.store.get().opacity).toBeCloseTo(24 / 25);
  });

  it('ignores writes that do not change the value', async () => {
    ctx.store.set({ opacity: 0.8 });
    await tick();
    expect(ctx.calls).toEqual([]);
  });

  it('honours an explicit stage override for collection-valued state', async () => {
    // The real case: `sites` is one key, but EIRP within it is far cheaper than position.
    ctx.store.set({ freq: 1800 }, 'linkBudget');
    await tick();
    expect(ctx.calls).toEqual(['linkBudget', 'render']);
    expect(ctx.store.get().freq).toBe(1800);
  });

  it('does not drop a change that arrives while the pipeline is running', async () => {
    const store = createStore<S>(
      { area: 1, freq: 1, eirp: 1, opacity: 1 },
      { area: 'data', freq: 'propagation', eirp: 'linkBudget', opacity: 'render' },
    );
    const seen: number[] = [];
    let fired = false;
    store.on('data', async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (!fired) {
        fired = true;
        store.set({ area: 99 });
      }
    });
    store.on('render', (s) => void seen.push(s.area));

    store.set({ area: 2 });
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toContain(99);
  });
});
