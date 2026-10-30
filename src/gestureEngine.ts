// gestureEngine.ts
// Turns the raw, jittery stream of "this hand looks like X" into calm, deliberate
// commands. It sits between recognition (handTracker.ts) and the app.
//
// Safety layers, in order:
//   1. Confidence filter  - unsure guesses count as "no gesture".
//   2. Smoothing          - a short voting window, so one bad frame cannot break a hold.
//   3. Hold-to-confirm    - the gesture must be held for its full holdMs.
//   4. Release + cooldown - after firing, the pose must be dropped (and a pause must
//                           pass) before the same command can fire again.
//
// This file knows nothing about MediaPipe, audio or the page, so it is easy to test.

import { BINDINGS, TIMING, type Binding, type HandName, type Intent } from "./config";

/** The minimum we need from the tracker for each visible hand. */
export interface GestureSample {
  side: HandName;
  gesture: string;
  confidence: number;
}

export type EngineState =
  | "idle" // no command gesture is being shown
  | "charging" // a command gesture is being held, progress is filling up
  | "fired" // the command just triggered (true for exactly one update)
  | "waiting"; // fired already; drop the pose / wait out the cooldown

export interface HandStatus {
  state: EngineState;
  /** The smoothed gesture, or null when the recent frames disagree. */
  stableGesture: string | null;
  /** The command this gesture is mapped to, if any. */
  binding: Binding | null;
  /** 0 to 1: how far through the hold we are. */
  progress: number;
}

export interface IntentEvent {
  intent: Intent;
  hand: HandName;
  label: string;
  timeMs: number;
}

interface HandState {
  samples: { t: number; g: string }[];
  candidate: string | null;
  holdStart: number | null;
  waiting: boolean;
  firedGesture: string | null;
  releasedSince: number | null;
  cooldownUntil: number;
}

const SIDES: HandName[] = ["Left", "Right"];

function freshState(): HandState {
  return {
    samples: [],
    candidate: null,
    holdStart: null,
    waiting: false,
    firedGesture: null,
    releasedSince: null,
    cooldownUntil: 0,
  };
}

/** The gesture that fills at least `minShare` of the samples, or null. */
function majority(samples: { g: string }[]): string | null {
  if (samples.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s.g, (counts.get(s.g) ?? 0) + 1);

  let best: string | null = null;
  let bestCount = 0;
  for (const [gesture, count] of counts) {
    if (count > bestCount) {
      best = gesture;
      bestCount = count;
    }
  }
  return best !== null && bestCount / samples.length >= TIMING.minShare ? best : null;
}

export class GestureEngine {
  private hands: Record<HandName, HandState> = { Left: freshState(), Right: freshState() };

  constructor(
    private onIntent: (event: IntentEvent) => void,
    private bindings: Binding[] = BINDINGS,
  ) {}

  /**
   * Call once per camera frame with every hand currently visible.
   * Hands that are not in `samples` are treated as showing no gesture.
   */
  update(samples: GestureSample[], nowMs: number): Record<HandName, HandStatus> {
    const result = {} as Record<HandName, HandStatus>;
    for (const side of SIDES) {
      const sample = samples.find((s) => s.side === side);
      const label = sample && sample.confidence >= TIMING.minConfidence ? sample.gesture : "None";
      result[side] = this.step(side, label, nowMs);
    }
    return result;
  }

  private step(side: HandName, label: string, now: number): HandStatus {
    const st = this.hands[side];

    // 2. Smoothing: remember recent frames, forget old ones.
    st.samples.push({ t: now, g: label });
    while (st.samples.length > 0 && now - st.samples[0].t > TIMING.windowMs) st.samples.shift();
    const stable = majority(st.samples);

    // 4. After firing: wait for the pose to be dropped and the cooldown to pass.
    if (st.waiting) {
      if (stable === st.firedGesture) {
        st.releasedSince = null;
      } else if (st.releasedSince === null) {
        st.releasedSince = now;
      }
      const released = st.releasedSince !== null && now - st.releasedSince >= TIMING.releaseMs;
      if (released && now >= st.cooldownUntil) {
        st.waiting = false;
        st.firedGesture = null;
        st.releasedSince = null;
        st.candidate = null;
        st.holdStart = null;
      } else {
        const stillHolding = stable === st.firedGesture;
        return { state: "waiting", stableGesture: stable, binding: null, progress: stillHolding ? 1 : 0 };
      }
    }

    // Is the smoothed gesture one of our commands?
    const binding = stable === null ? undefined : this.bindings.find((b) => b.hand === side && b.gesture === stable);
    if (!binding || stable === null) {
      st.candidate = null;
      st.holdStart = null;
      return { state: "idle", stableGesture: stable, binding: null, progress: 0 };
    }

    // 3. Hold-to-confirm: restart the clock whenever the gesture changes.
    if (st.candidate !== stable || st.holdStart === null) {
      st.candidate = stable;
      st.holdStart = now;
    }
    const progress = Math.min(1, (now - st.holdStart) / binding.holdMs);

    if (progress >= 1) {
      st.waiting = true;
      st.firedGesture = stable;
      st.releasedSince = null;
      st.cooldownUntil = now + TIMING.cooldownMs;
      this.onIntent({ intent: binding.intent, hand: side, label: binding.label, timeMs: now });
      return { state: "fired", stableGesture: stable, binding, progress: 1 };
    }
    return { state: "charging", stableGesture: stable, binding, progress };
  }
}
