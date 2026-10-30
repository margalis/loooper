// grid.ts
// Pure maths for the musical grid. Everything is counted in audio FRAMES (whole
// samples, e.g. 48000 per second) instead of seconds, so beats, bars and loops are
// exact whole numbers and can never drift apart from each other.

export const BEATS_PER_BAR = 4;

export interface TempoGrid {
  sampleRate: number;
  /** Frames in one beat (rounded to a whole number). */
  beatFrames: number;
  /** Frames in one bar (4 beats). */
  barFrames: number;
}

export function makeGrid(bpm: number, sampleRate: number): TempoGrid {
  const beatFrames = Math.max(1, Math.round((60 / bpm) * sampleRate));
  return { sampleRate, beatFrames, barFrames: beatFrames * BEATS_PER_BAR };
}

/** The tempo you actually get after rounding the beat to a whole number of frames. */
export function effectiveBpm(grid: TempoGrid): number {
  return (60 * grid.sampleRate) / grid.beatFrames;
}

/** Modulo that also works for negative numbers (JavaScript's % does not). */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** First loop boundary (origin + k * loopFrames) at or after `frame`. */
export function nextBoundary(frame: number, originFrame: number, loopFrames: number): number {
  return originFrame + Math.ceil((frame - originFrame) / loopFrames) * loopFrames;
}
