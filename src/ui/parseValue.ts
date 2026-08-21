export interface ParseFieldOptions {
  min: number;
  max: number;
  /** Display units -> model units, e.g. km -> metres, percent -> 0..1. */
  fromDisplay?: (v: number) => number;
}

/**
 * Parse what someone typed into a numeric control.
 *
 * Returns `null` when the text has no number in it, so the caller can restore the previous
 * value instead of committing a NaN into the pipeline.
 *
 * Tolerant on input because people paste values back in with their units attached
 * ("3700 MHz", "-95 dBm") and type thousands separators. Deliberately NOT snapped to the
 * slider's step: the step exists to make dragging comfortable, and forcing typed input onto
 * that grid would make the field unable to reach 2412 MHz when the step is 10.
 */
export function parseFieldValue(text: string, opts: ParseFieldOptions): number | null {
  const cleaned = text.replace(/,/g, '').replace(/[^0-9eE+.-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;

  const model = (opts.fromDisplay ?? ((v: number) => v))(parsed);
  if (!Number.isFinite(model)) return null;

  return model < opts.min ? opts.min : model > opts.max ? opts.max : model;
}
