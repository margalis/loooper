// audioEngine.ts
// Owns the browser's audio plumbing: the microphone, the recorder worklet, the
// master volume and the metronome click. It knows nothing about loops or gestures;
// looper.ts decides WHAT to do and WHEN, this file does it.

import { MASTER_GAIN } from "./mix";

export interface EngineOptions {
  /** For tests: use this node as the input instead of the microphone. */
  source?: AudioNode;
}

interface WorkletMessage {
  type: "done" | "level" | "peek";
  id?: number;
  data?: Float32Array;
  peak?: number;
}

export class AudioEngine {
  /** Everything audible except the click goes through here. */
  readonly master: GainNode;
  private clickBus: GainNode;
  private recorder!: AudioWorkletNode;

  /** Latest mic loudness (0 to 1), updated about 30 times per second. */
  micPeak = 0;
  /** Name of the microphone in use, for display. */
  micLabel = "";
  /** Input latency reported by the browser, in seconds (0 when unknown). */
  private micLatencySec = 0;

  /** Called when a recording finishes, with the exact samples captured. */
  onRecorded: ((id: number, data: Float32Array) => void) | null = null;

  /** Called with a partial copy of a recording in progress (see peekRecording). */
  onPeek: ((id: number, data: Float32Array) => void) | null = null;

  private constructor(readonly ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(ctx.destination);

    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.35;
    this.clickBus.connect(ctx.destination);
  }

  static async create(ctx: AudioContext, options: EngineOptions = {}): Promise<AudioEngine> {
    const engine = new AudioEngine(ctx);

    // The recorder lives in its own file (public/recorder-worklet.js).
    await ctx.audioWorklet.addModule("recorder-worklet.js");
    const node = new AudioWorkletNode(ctx, "recorder-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => engine.onWorkletMessage(event.data);

    // The recorder makes no sound, but it is wired to the output through a muted
    // gain so the browser keeps it running.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    engine.recorder = node;

    if (options.source) {
      options.source.connect(node);
    } else {
      await engine.openMic();
    }
    return engine;
  }

  private async openMic(): Promise<void> {
    // Raw sound: the browser's voice-call processing would squash and gate singing.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const track = stream.getAudioTracks()[0];
    this.micLabel = track?.label ?? "";
    // Chrome reports the input latency; it is not in TypeScript's built-in type, so we say so here.
    const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { latency?: number };
    this.micLatencySec = settings.latency ?? 0;

    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(this.recorder);
  }

  private onWorkletMessage(message: WorkletMessage): void {
    if (message.type === "level") {
      this.micPeak = message.peak ?? 0;
    } else if (message.type === "done" && message.id !== undefined && message.data) {
      this.onRecorded?.(message.id, message.data);
    } else if (message.type === "peek" && message.id !== undefined && message.data) {
      this.onPeek?.(message.id, message.data);
    }
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** The audio clock, as a whole frame number. */
  nowFrame(): number {
    return Math.round(this.ctx.currentTime * this.ctx.sampleRate);
  }

  /** Estimated delay between "sound made" and "sound captured" plus "sound played", in seconds. */
  latencySec(): number {
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + this.micLatencySec;
  }

  // ---- recording (talks to the worklet) ----

  startRecording(id: number, startFrame: number, endFrame: number): void {
    this.recorder.port.postMessage({ type: "record", id, startFrame, endFrame });
  }

  /** Asks the recorder for a copy of everything captured so far. The answer arrives in onPeek. */
  peekRecording(id: number): void {
    this.recorder.port.postMessage({ type: "peek", id });
  }

  trimRecording(id: number, endFrame: number): void {
    this.recorder.port.postMessage({ type: "trim", id, endFrame });
  }

  cancelRecording(id: number): void {
    this.recorder.port.postMessage({ type: "cancel", id });
  }

  // ---- metronome ----

  /** Schedules one click at an exact frame. `accent` makes it higher (first beat of a bar). */
  scheduleClick(frame: number, accent: boolean): void {
    const when = frame / this.ctx.sampleRate;
    if (when < this.ctx.currentTime) return; // too late to play, skip it

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = accent ? 1600 : 1000;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(env);
    env.connect(this.clickBus);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}
