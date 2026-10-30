// mix.ts
// Small shared rules about loudness, used by the live looper and by the exported mixdown
// so that "what you hear" and "what you save" always agree.

/** Overall output level. The microphone loops are summed, so we leave a little headroom. */
export const MASTER_GAIN = 0.9;

/** Highest value of a layer's volume slider (1 = normal, above 1 boosts quiet recordings). */
export const MAX_VOLUME = 1.5;

/** Slider position to real gain. A squared curve feels more natural than a straight line. */
export function volumeToGain(volume: number): number {
  return volume * volume;
}

/** The gain a layer actually plays at, taking mute and solo into account. */
export function effectiveGain(volume: number, muted: boolean, solo: boolean, anySolo: boolean): number {
  if (muted) return 0;
  if (anySolo && !solo) return 0;
  return volumeToGain(volume);
}

/** A rough outline of a recording for drawing: the loudest value in each of `bins` slices. */
export function computePeaks(samples: Float32Array, bins = 240): Float32Array {
  const peaks = new Float32Array(bins);
  const size = samples.length / bins;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * size);
    const to = Math.max(from + 1, Math.floor((b + 1) * size));
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}
