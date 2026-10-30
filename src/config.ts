// config.ts
// The "mapping" layer from our plan. This is the ONLY file you need to edit to
// change which gesture does what, how long you hold it, or which hand it uses.
// The recognition code (handTracker.ts) never has to change.

export type HandName = "Left" | "Right";

/** What the app is being asked to do. Later phases will listen for these. */
export type Intent = "RECORD_TOGGLE" | "STOP" | "UNDO" | "CLEAR_ALL";

export interface Binding {
  /** Which hand must make the gesture. */
  hand: HandName;
  /** MediaPipe gesture name: Victory, Closed_Fist, Open_Palm, Thumb_Up,
   *  Thumb_Down, Pointing_Up or ILoveYou. */
  gesture: string;
  /** The action requested once the gesture has been held long enough. */
  intent: Intent;
  /** Human-readable name shown on screen. */
  label: string;
  /** How long (milliseconds) the gesture must be held to count. */
  holdMs: number;
}

// Your left hand controls the loops (you are left-handed).
export const BINDINGS: Binding[] = [
  { hand: "Left", gesture: "Victory", intent: "RECORD_TOGGLE", label: "Record / close loop", holdMs: 300 },
  { hand: "Left", gesture: "Closed_Fist", intent: "STOP", label: "Stop / resume", holdMs: 500 },
  { hand: "Left", gesture: "Thumb_Down", intent: "UNDO", label: "Undo last layer", holdMs: 500 },
  // Unusual pose + longer hold on purpose: wiping everything should be hard to do by accident.
  { hand: "Left", gesture: "ILoveYou", intent: "CLEAR_ALL", label: "Clear all", holdMs: 1200 },
];

// Safety tuning. Change these if gestures feel too twitchy or too sluggish.
export const TIMING = {
  /** Look at this many milliseconds of recent frames when judging a gesture. */
  windowMs: 300,
  /** A gesture counts only if it fills at least this share of that window (0 to 1).
   *  This lets one or two misread frames pass without breaking a hold. */
  minShare: 0.6,
  /** Ignore the model's guess if it is less sure than this (0 to 1). */
  minConfidence: 0.6,
  /** After an action fires, ignore that hand for at least this long. */
  cooldownMs: 800,
  /** After an action fires, the gesture must be dropped for this long before it can fire again. */
  releaseMs: 250,
};
