// handTracker.ts
// Wraps MediaPipe's GestureRecognizer so the rest of the app never has to
// know about MediaPipe. This is the "recognition" layer from our plan: it only
// reports WHAT the hands are doing. Deciding what that MEANS (record, stop...)
// comes later, in a separate mapping layer.

import {
  FilesetResolver,
  GestureRecognizer,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// The WASM files MediaPipe needs. Version must match package.json.
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";

// Google's pre-trained gesture model (about 8 MB, downloaded once by the browser).
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

export type HandSide = "Left" | "Right";

export interface HandReading {
  /** Which of YOUR hands this is (already corrected for the mirror, see main.ts). */
  side: HandSide;
  /** Raw gesture name from MediaPipe, e.g. "Victory", "Closed_Fist", "None". */
  gesture: string;
  /** How sure the model is about the gesture, 0 to 1. */
  confidence: number;
  /** 21 points on the hand, each with x and y from 0 to 1 across the picture. */
  landmarks: NormalizedLandmark[];
}

export class HandTracker {
  private constructor(private recognizer: GestureRecognizer) {}

  static async create(): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

    const options = {
      runningMode: "VIDEO" as const,
      numHands: 2,
    };

    // The GPU is much faster, but not every computer supports it,
    // so we fall back to the CPU if it fails.
    try {
      const recognizer = await GestureRecognizer.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
      return new HandTracker(recognizer);
    } catch (err) {
      console.warn("GPU delegate failed, falling back to CPU", err);
      const recognizer = await GestureRecognizer.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      });
      return new HandTracker(recognizer);
    }
  }

  /**
   * Looks at the current video frame and returns every hand it can see.
   * `swapHandedness` fixes the left/right mix-up caused by mirroring.
   */
  detect(video: HTMLVideoElement, nowMs: number, swapHandedness: boolean): HandReading[] {
    const result = this.recognizer.recognizeForVideo(video, nowMs);
    const readings: HandReading[] = [];

    for (let i = 0; i < result.landmarks.length; i++) {
      const label = result.handedness[i]?.[0]?.categoryName ?? "Right";
      const top = result.gestures[i]?.[0];

      let side: HandSide = label === "Left" ? "Left" : "Right";
      if (swapHandedness) side = side === "Left" ? "Right" : "Left";

      readings.push({
        side,
        gesture: top?.categoryName ?? "None",
        confidence: top?.score ?? 0,
        landmarks: result.landmarks[i],
      });
    }
    return readings;
  }

  /** The line segments that connect the 21 points into a hand skeleton. */
  static readonly CONNECTIONS = GestureRecognizer.HAND_CONNECTIONS;
}
