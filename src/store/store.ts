/**
 * A reactive store whose subscriptions are organised by *cost*, not by key.
 *
 * The pipeline has four stages of wildly different price:
 *
 *   data (0.5-3s)  ->  propagation (25-110ms)  ->  linkBudget (5-20ms)  ->  render (~0ms)
 *
 * Every piece of state declares the earliest stage its change invalidates. Changing the
 * colour ramp re-enters at `render`; changing EIRP at `linkBudget`; changing frequency at
 * `propagation`; resizing the AOI at `data`. The pipeline then runs from that stage to the
 * end -- so a cheap change never pays for an expensive one.
 *
 * This is the whole reason the tool can feel interactive, and it is not something a
 * general-purpose UI framework can express: React has no idea that `opacity` is free and
 * `freqMHz` costs 80ms.
 */
export const STAGES = ['data', 'propagation', 'linkBudget', 'render'] as const;
export type Stage = (typeof STAGES)[number];

type Handler<S> = (state: S) => void | Promise<void>;

export interface Store<S extends object> {
  get(): Readonly<S>;
  /**
   * `stage` overrides the declared cost for this particular change.
   *
   * Needed because some state is a collection: `sites` is one key, but moving a site
   * invalidates propagation while changing its EIRP only invalidates the link budget.
   * Without the override the whole array would be pinned to its most expensive field and
   * every EIRP nudge would pay for a radial walk.
   */
  set(patch: Partial<S>, stage?: Stage): void;
  on(stage: Stage, fn: Handler<S>): void;
  /** Force the pipeline to run from `stage` without changing any state. */
  invalidate(stage: Stage): void;
}

const nextFrame: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (fn) => void requestAnimationFrame(() => fn())
    : (fn) => void setTimeout(fn, 0);

export function createStore<S extends object>(
  initial: S,
  stageFor: Partial<Record<keyof S & string, Stage>>,
  defaultStage: Stage = 'render',
): Store<S> {
  const state = { ...initial };
  const handlers: Record<Stage, Handler<S>[]> = {
    data: [],
    propagation: [],
    linkBudget: [],
    render: [],
  };

  let pending: number | null = null;
  let scheduled = false;
  let running = false;

  function schedule(stageIdx: number): void {
    pending = pending === null ? stageIdx : Math.min(pending, stageIdx);
    if (scheduled || running) return;
    scheduled = true;
    nextFrame(flush);
  }

  async function flush(): Promise<void> {
    scheduled = false;
    if (pending === null) return;
    const from = pending;
    pending = null;
    running = true;
    try {
      for (let i = from; i < STAGES.length; i++) {
        const stage = STAGES[i] as Stage;
        for (const fn of handlers[stage]) await fn(state);
      }
    } catch (err) {
      console.error('[store] pipeline stage failed:', err);
    } finally {
      running = false;
      // A change that arrived mid-run is picked up here rather than being dropped.
      if (pending !== null) {
        scheduled = true;
        nextFrame(flush);
      }
    }
  }

  return {
    get: () => state,

    set(patch: Partial<S>, stage?: Stage): void {
      let earliest: number | null = null;
      for (const key of Object.keys(patch) as (keyof S & string)[]) {
        if (Object.is(state[key], patch[key])) continue;
        (state as S)[key] = patch[key] as S[keyof S & string];
        const idx = STAGES.indexOf(stage ?? stageFor[key] ?? defaultStage);
        earliest = earliest === null ? idx : Math.min(earliest, idx);
      }
      if (earliest !== null) schedule(earliest);
    },

    on(stage: Stage, fn: Handler<S>): void {
      handlers[stage].push(fn);
    },

    invalidate(stage: Stage): void {
      schedule(STAGES.indexOf(stage));
    },
  };
}
