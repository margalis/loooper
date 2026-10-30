// looper.ts
// The brain of the looper. It listens for commands (record, stop, undo, clear),
// keeps track of the recorded layers, and schedules everything on the audio clock so
// that loops start and end exactly on bar lines.
//
// Vocabulary:
//   layer   one recorded voice take. Every layer has the same length.
//   loop    the repeating cycle all layers play in (1, 2, 4 or 8 bars).
//   origin  the frame where the loop cycle starts. Everything lines up to this.
//   take    a recording in progress (count-in first, then the actual capture).

import type { Intent } from "../config";
import type { AudioEngine } from "./audioEngine";
import { BEATS_PER_BAR, effectiveBpm, makeGrid, mod, nextBoundary, type TempoGrid } from "./grid";
import { MAX_VOLUME, computePeaks, effectiveGain } from "./mix";
import type { SessionData } from "../session/session";

export type LooperState = "idle" | "countIn" | "recording" | "playing" | "stopped";
export type BarsSetting = number | "auto";

/** In "auto" mode a recording stops by itself after this many bars. */
export const MAX_AUTO_BARS = 16;

const TICK_MS = 25; // how often the scheduler wakes up
const LOOKAHEAD_SEC = 0.12; // how far ahead it schedules sounds
const START_LEAD_SEC = 0.15; // pause between "record" and the first count-in click
const START_MARGIN_SEC = 0.03; // safety gap when starting a loop player
const TRIM_MARGIN_SEC = 0.05; // safety gap when closing a recording early
const PEEK_LEAD_SEC = 0.3; // how long before a take ends we grab a preview of it (see onPeek)
const MIN_EARLY_LOOP_SEC = 1; // shorter loops skip the preview trick

interface Layer {
  id: number;
  name: string;
  buffer: AudioBuffer;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  /** Slider value, 0 to MAX_VOLUME (1 = normal). */
  volume: number;
  muted: boolean;
  solo: boolean;
  /** Rough outline of the recording, for drawing. */
  peaks: Float32Array;
}

/** What the screen needs to know about one layer. */
export interface LayerInfo {
  id: number;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  peaks: Float32Array;
}

const GAIN_SMOOTHING_SEC = 0.015; // volume/mute changes glide, so they never click

interface Take {
  id: number;
  isFirst: boolean;
  /** First count-in click. */
  countInStart: number;
  /** Where the recorded cycle begins (a loop boundary). Recording is captured from here. */
  startFrame: number;
  /** Where it ends (can move earlier when closed early). */
  endFrame: number;
  /** The latest it could end. */
  maxEndFrame: number;
  /** Latency compensation in frames, fixed when the take is armed. */
  comp: number;
  /** True once we asked the recorder for a preview of the take. */
  peeked: boolean;
  /** A preview player that starts the new layer right on the loop boundary (see onPeek). */
  early: { gain: GainNode; source: AudioBufferSourceNode } | null;
}

export interface LooperSnapshot {
  state: LooperState;
  layers: number;
  /** The tempo actually in use (the beat is rounded to a whole number of frames). */
  bpm: number;
  barsSetting: BarsSetting;
  /** Loop length in bars once known (null while an "auto" first take is still open). */
  loopBars: number | null;
  /** 0 to 1 position of the playhead, or null when there is no loop yet. */
  playhead: number | null;
  /** During count-in: beats left until recording begins. */
  beatsToStart: number | null;
  /** During recording: the bar we are in (1 based). */
  recBar: number | null;
  /** True while tempo and loop length cannot be changed. */
  locked: boolean;
  latencyMs: number;
  micLevel: number;
  /** Goes up whenever a layer is added, removed, muted, soloed or its volume changes. */
  layersVersion: number;
}

export class Looper {
  private layers: Layer[] = [];
  private take: Take | null = null;
  private playing = false;
  private nextId = 1;
  private nameCounter = 1;
  private version = 0;

  /** Called whenever the layers (or their settings) change. Used for autosave. */
  onChange: (() => void) | null = null;

  private bpm = 100;
  private barsSetting: BarsSetting = 2;
  private tempo: TempoGrid;
  private originFrame: number | null = null;
  private loopFrames: number | null = null;

  private nextBeatIndex = 0;
  private pendingResumeFrame: number | null = null;
  private metronomeOn = true;
  private metronomeAlways = false;
  private trimMs = 0;
  private timer: number | undefined;

  constructor(private audio: AudioEngine) {
    this.tempo = makeGrid(this.bpm, audio.sampleRate);
    audio.onRecorded = (id, data) => this.onRecorded(id, data);
    audio.onPeek = (id, data) => this.onPeek(id, data);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.audio.onRecorded = null;
    this.audio.onPeek = null;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private get locked(): boolean {
    return this.layers.length > 0 || this.take !== null;
  }

  /** Returns false when it cannot be changed right now. */
  setBpm(bpm: number): boolean {
    if (this.locked || !Number.isFinite(bpm)) return false;
    this.bpm = Math.min(200, Math.max(40, bpm));
    this.tempo = makeGrid(this.bpm, this.audio.sampleRate);
    return true;
  }

  setBars(bars: BarsSetting): boolean {
    if (this.locked) return false;
    this.barsSetting = bars;
    return true;
  }

  /** Master switch for the click. Off = completely silent, but the timing grid keeps running. */
  setMetronome(on: boolean): void {
    this.metronomeOn = on;
  }

  /** When on, the click also continues while the loop plays (not just during count-in and recording). */
  setMetronomeAlways(on: boolean): void {
    this.metronomeAlways = on;
  }

  /** Extra manual correction for latency, in milliseconds (positive = sound arrives later). */
  setTrimMs(ms: number): void {
    this.trimMs = ms;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** Entry point for gesture commands. Returns a short message to show the user. */
  handleIntent(intent: Intent): string {
    switch (intent) {
      case "RECORD_TOGGLE":
        return this.recordToggle();
      case "STOP":
        return this.stopToggle();
      case "UNDO":
        return this.undo();
      case "CLEAR_ALL":
        return this.clearAll();
    }
  }

  recordToggle(): string {
    if (this.take) {
      const phase = this.audio.nowFrame() < this.take.startFrame ? "countIn" : "recording";
      if (phase === "countIn") {
        this.cancelTake();
        return "Cancelled";
      }
      return this.closeTake();
    }
    return this.armTake();
  }

  stopToggle(): string {
    if (this.take) {
      this.cancelTake();
      this.stopAll();
      return "Stopped";
    }
    if (this.layers.length === 0) return "Nothing to stop yet";
    if (this.playing || this.pendingResumeFrame !== null) {
      this.pendingResumeFrame = null;
      this.stopAll();
      return "Stopped";
    }
    // Resume: all layers restart together at the next loop start.
    const earliest = this.audio.nowFrame() + this.frames(START_LEAD_SEC);
    this.pendingResumeFrame = nextBoundary(earliest, this.originFrame!, this.loopFrames!);
    return "Resuming at the loop start";
  }

  undo(): string {
    if (this.take) {
      this.cancelTake();
      return "Take discarded";
    }
    const layer = this.layers.pop();
    if (!layer) return "Nothing to undo";
    this.disposeLayer(layer);
    if (this.layers.length === 0) this.resetGrid();
    this.changed();
    return "Removed the last layer";
  }

  clearAll(): string {
    this.cancelTake();
    for (const layer of this.layers) this.disposeLayer(layer);
    this.layers = [];
    this.resetGrid();
    this.changed();
    return "Cleared everything";
  }

  // ---------------------------------------------------------------------------
  // Managing single layers
  // ---------------------------------------------------------------------------

  getLayerInfos(): LayerInfo[] {
    return this.layers.map((l) => ({ id: l.id, name: l.name, volume: l.volume, muted: l.muted, solo: l.solo, peaks: l.peaks }));
  }

  private find(id: number): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  setLayerVolume(id: number, volume: number): void {
    const layer = this.find(id);
    if (!layer || !Number.isFinite(volume)) return;
    layer.volume = Math.min(MAX_VOLUME, Math.max(0, volume));
    this.applyGains();
    this.changed();
  }

  toggleMute(id: number): string {
    const layer = this.find(id);
    if (!layer) return "No such layer";
    layer.muted = !layer.muted;
    this.applyGains();
    this.changed();
    return layer.muted ? `${layer.name} muted` : `${layer.name} unmuted`;
  }

  toggleSolo(id: number): string {
    const layer = this.find(id);
    if (!layer) return "No such layer";
    layer.solo = !layer.solo;
    this.applyGains();
    this.changed();
    return layer.solo ? `${layer.name} solo` : "Solo off";
  }

  /** Same as toggleMute / toggleSolo, but by position (1 = first layer). Used by number keys. */
  toggleMuteAt(position: number): string {
    const layer = this.layers[position - 1];
    return layer ? this.toggleMute(layer.id) : `No layer ${position}`;
  }

  toggleSoloAt(position: number): string {
    const layer = this.layers[position - 1];
    return layer ? this.toggleSolo(layer.id) : `No layer ${position}`;
  }

  removeLayer(id: number): string {
    const layer = this.find(id);
    if (!layer) return "No such layer";
    // If this is the last layer, a recording in progress has nothing left to line up with.
    if (this.layers.length === 1) this.cancelTake();
    this.layers = this.layers.filter((l) => l !== layer);
    this.disposeLayer(layer);
    if (this.layers.length === 0) this.resetGrid();
    this.applyGains();
    this.changed();
    return `${layer.name} deleted`;
  }

  /** Sets every layer's loudness from its volume, mute and solo. */
  private applyGains(): void {
    const anySolo = this.layers.some((l) => l.solo);
    const now = this.audio.ctx.currentTime;
    for (const l of this.layers) {
      const g = effectiveGain(l.volume, l.muted, l.solo, anySolo);
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setTargetAtTime(g, now, GAIN_SMOOTHING_SEC);
    }
  }

  private changed(): void {
    this.version++;
    this.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Saving and loading a whole session
  // ---------------------------------------------------------------------------

  /** Everything needed to rebuild the session, or null when there is nothing to save. */
  exportState(): SessionData | null {
    if (this.layers.length === 0 || this.loopFrames === null) return null;
    return {
      sampleRate: this.audio.sampleRate,
      bpm: this.bpm,
      bars: this.loopFrames / this.tempo.barFrames,
      layers: this.layers.map((l) => ({
        name: l.name,
        volume: l.volume,
        muted: l.muted,
        samples: new Float32Array(l.buffer.getChannelData(0)),
      })),
    };
  }

  /** Replaces the current session. Layers start playing together at a fresh loop start. */
  async importState(data: SessionData): Promise<{ bpm: number; barsSetting: BarsSetting }> {
    const sr = this.audio.sampleRate;
    const bpm = Math.min(200, Math.max(40, data.bpm));
    const tempo = makeGrid(bpm, sr);
    const bars = Math.max(1, Math.round(data.bars));
    const loopFrames = bars * tempo.barFrames;

    // Do the slow part (resampling) before touching the running session.
    const prepared: { src: SessionData["layers"][number]; samples: Float32Array }[] = [];
    for (const src of data.layers) {
      let samples = data.sampleRate === sr ? src.samples : await this.resample(src.samples, data.sampleRate);
      if (samples.length !== loopFrames) {
        const fixed = new Float32Array(loopFrames);
        fixed.set(samples.subarray(0, Math.min(loopFrames, samples.length)));
        samples = fixed;
      }
      prepared.push({ src, samples });
    }

    this.cancelTake();
    for (const layer of this.layers) this.disposeLayer(layer);
    this.layers = [];
    this.resetGrid();

    this.bpm = bpm;
    this.tempo = tempo;
    this.barsSetting = [1, 2, 4, 8].includes(bars) ? bars : "auto";
    this.loopFrames = loopFrames;
    this.originFrame = this.audio.nowFrame() + this.frames(START_LEAD_SEC);
    this.nextBeatIndex = Math.ceil((this.audio.nowFrame() - this.originFrame) / tempo.beatFrames);

    for (const { src, samples } of prepared) {
      const buffer = this.audio.ctx.createBuffer(1, loopFrames, sr);
      const plain = new Float32Array(loopFrames);
      plain.set(samples);
      buffer.copyToChannel(plain, 0);
      const gain = this.audio.ctx.createGain();
      gain.connect(this.audio.master);
      this.layers.push({
        id: this.nextId++,
        name: src.name,
        buffer,
        gain,
        source: null,
        volume: Math.min(MAX_VOLUME, Math.max(0, src.volume)),
        muted: src.muted,
        solo: false,
        peaks: computePeaks(samples),
      });
    }
    this.nameCounter = Math.max(this.nameCounter, this.layers.length + 1);
    this.applyGainsNow();
    this.playing = true;
    for (const layer of this.layers) this.startLayer(layer, this.originFrame);
    this.changed();
    return { bpm, barsSetting: this.barsSetting };
  }

  private async resample(samples: Float32Array, fromRate: number): Promise<Float32Array> {
    const toRate = this.audio.sampleRate;
    const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
    const offline = new OfflineAudioContext(1, length, toRate);
    const buffer = offline.createBuffer(1, samples.length, fromRate);
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    buffer.copyToChannel(copy, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  }

  /** Like applyGains, but jumps straight to the value (used for brand new layers). */
  private applyGainsNow(): void {
    const anySolo = this.layers.some((l) => l.solo);
    for (const l of this.layers) {
      l.gain.gain.value = effectiveGain(l.volume, l.muted, l.solo, anySolo);
    }
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  private armTake(): string {
    const a = this.audio;
    const now = a.nowFrame();
    const lead = this.frames(START_LEAD_SEC);
    const id = this.nextId++;
    const comp = Math.round((a.latencySec() + this.trimMs / 1000) * a.sampleRate);
    let take: Take;

    if (this.layers.length === 0) {
      // First layer: build a fresh grid. One bar of count-in comes before the loop starts.
      this.tempo = makeGrid(this.bpm, a.sampleRate);
      const barF = this.tempo.barFrames;
      const bars = this.barsSetting === "auto" ? null : this.barsSetting;
      this.originFrame = now + lead + barF;
      this.loopFrames = bars === null ? null : bars * barF;
      this.nextBeatIndex = Math.ceil((now - this.originFrame) / this.tempo.beatFrames);
      take = {
        id,
        isFirst: true,
        countInStart: this.originFrame - barF,
        startFrame: this.originFrame,
        endFrame: this.originFrame + (bars ?? MAX_AUTO_BARS) * barF,
        maxEndFrame: this.originFrame + (bars ?? MAX_AUTO_BARS) * barF,
        comp,
        peeked: false,
        early: null,
      };
    } else {
      // Another layer: record the next full pass of the loop. The click counts you in
      // for whatever part of the last bar is left before it starts.
      const startFrame = nextBoundary(now + lead, this.originFrame!, this.loopFrames!);
      take = {
        id,
        isFirst: false,
        countInStart: Math.max(now, startFrame - this.tempo.barFrames),
        startFrame,
        endFrame: startFrame + this.loopFrames!,
        maxEndFrame: startFrame + this.loopFrames!,
        comp,
        peeked: false,
        early: null,
      };
      if (!this.playing) this.pendingResumeFrame = startFrame;
    }

    this.take = take;
    a.startRecording(take.id, take.startFrame + comp, take.maxEndFrame + comp);
    return take.isFirst ? "Count-in..." : "Recording starts at the loop start";
  }

  /** Called while recording: stops at the next bar line instead of the planned end. */
  private closeTake(): string {
    const take = this.take!;
    const barF = this.tempo.barFrames;
    const earliest = this.audio.nowFrame() + this.frames(TRIM_MARGIN_SEC);
    const bars = Math.max(1, Math.ceil((earliest - take.startFrame) / barF));
    const end = take.startFrame + bars * barF;

    if (end >= take.endFrame) {
      return `Already ending at bar ${bars}`;
    }
    take.endFrame = end;
    if (take.isFirst && this.loopFrames === null) this.loopFrames = bars * barF;
    this.audio.trimRecording(take.id, end + take.comp);
    return `Closing at the end of bar ${bars}`;
  }

  private cancelTake(): void {
    const take = this.take;
    if (!take) return;
    this.audio.cancelRecording(take.id);
    this.dropEarly(take);
    this.take = null;
    this.pendingResumeFrame = null;
    if (take.isFirst && this.layers.length === 0) this.resetGrid();
  }

  /**
   * Why this exists: the recorder only hands over the finished take AFTER the loop boundary
   * (the latency compensation shifts its window later), so the new layer used to miss the first
   * ~0.1 s of its first replay. Fix: shortly before the take ends we ask for a preview of what
   * is captured so far, and start a player on the boundary from that. When the finished take
   * arrives, it replaces the preview at an exact frame with the same position, so nobody hears the swap.
   */
  private onPeek(id: number, data: Float32Array): void {
    const take = this.take;
    if (!take || take.id !== id || take.early || this.loopFrames === null) return;
    const when = take.endFrame;
    if (when < this.audio.nowFrame() + this.frames(START_MARGIN_SEC)) return; // too late, the normal path handles it

    const length = this.loopFrames;
    const samples = new Float32Array(length);
    samples.set(data.subarray(0, Math.min(length, data.length)));
    const buffer = this.audio.ctx.createBuffer(1, length, this.audio.sampleRate);
    buffer.copyToChannel(samples, 0);

    const gain = this.audio.ctx.createGain();
    gain.gain.value = 1; // a new layer starts at normal volume
    gain.connect(this.audio.master);
    const source = this.audio.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start(when / this.audio.sampleRate, 0); // the boundary is where the loop starts: offset 0
    take.early = { gain, source };
  }

  private dropEarly(take: Take): void {
    const early = take.early;
    if (!early) return;
    try {
      early.source.stop();
    } catch {
      // already stopped
    }
    early.source.disconnect();
    early.gain.disconnect();
    take.early = null;
  }

  /** The recorder hands back the captured samples. */
  private onRecorded(id: number, data: Float32Array): void {
    const take = this.take;
    if (!take || take.id !== id) return; // cancelled in the meantime

    if (this.loopFrames === null) this.loopFrames = take.maxEndFrame - take.startFrame;
    const length = this.loopFrames;

    const samples = new Float32Array(length);
    samples.set(data.subarray(0, Math.min(length, data.length)));
    const buffer = this.audio.ctx.createBuffer(1, length, this.audio.sampleRate);
    buffer.copyToChannel(samples, 0);

    // Reuse the preview's volume control if there is one, so the swap is seamless.
    const early = take.early;
    const gain = early ? early.gain : this.audio.ctx.createGain();
    if (!early) gain.connect(this.audio.master);
    const layer: Layer = {
      id,
      name: `Layer ${this.nameCounter++}`,
      buffer,
      gain,
      source: null,
      volume: 1,
      muted: false,
      solo: false,
      peaks: computePeaks(samples),
    };
    for (const l of this.layers) l.solo = false; // a new layer should be heard: clear any solo
    this.layers.push(layer);
    this.applyGains();
    this.applyGainsNow();

    this.take = null;
    this.playing = true;
    const when = this.startLayer(layer);
    if (early) {
      // Stop the preview on exactly the frame the real player takes over.
      try {
        if (when >= take.endFrame) early.source.stop(when / this.audio.sampleRate);
        else early.source.stop(); // the boundary has not even happened yet: the preview never plays
      } catch {
        // already stopped
      }
      const old = early.source;
      old.onended = () => old.disconnect();
    }
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  /**
   * Starts a layer so that it is in step with the loop, wherever in the cycle we are.
   * `notBefore` lets a caller ask for a later start (e.g. the next loop boundary).
   */
  private startLayer(layer: Layer, notBefore = 0): number {
    this.stopLayerSource(layer);
    const sr = this.audio.sampleRate;
    const when = Math.max(notBefore, this.audio.nowFrame() + this.frames(START_MARGIN_SEC));
    const offset = mod(when - this.originFrame!, this.loopFrames!);

    const source = this.audio.ctx.createBufferSource();
    source.buffer = layer.buffer;
    source.loop = true;
    source.connect(layer.gain);
    source.start(when / sr, offset / sr);
    layer.source = source;
    return when;
  }

  private stopLayerSource(layer: Layer): void {
    if (layer.source) {
      try {
        layer.source.stop();
      } catch {
        // already stopped
      }
      layer.source.disconnect();
      layer.source = null;
    }
  }

  private stopAll(): void {
    for (const layer of this.layers) this.stopLayerSource(layer);
    this.playing = false;
  }

  private disposeLayer(layer: Layer): void {
    this.stopLayerSource(layer);
    layer.gain.disconnect();
  }

  private resetGrid(): void {
    this.originFrame = null;
    this.loopFrames = null;
    this.playing = false;
    this.pendingResumeFrame = null;
  }

  // ---------------------------------------------------------------------------
  // Scheduler: runs every 25 ms and schedules what is coming up in the next 120 ms.
  // ---------------------------------------------------------------------------

  private tick(): void {
    const now = this.audio.nowFrame();
    const horizon = now + this.frames(LOOKAHEAD_SEC);

    // Metronome clicks.
    if (this.originFrame !== null) {
      const beatF = this.tempo.beatFrames;
      for (;;) {
        const frame = this.originFrame + this.nextBeatIndex * beatF;
        if (frame >= horizon) break;
        if (this.clickWanted(frame)) {
          this.audio.scheduleClick(frame, mod(this.nextBeatIndex, BEATS_PER_BAR) === 0);
        }
        this.nextBeatIndex++;
      }
    }

    // Shortly before a full-length take ends, ask the recorder for a preview (see onPeek).
    const take = this.take;
    if (
      take &&
      !take.peeked &&
      this.loopFrames !== null &&
      this.loopFrames > this.frames(MIN_EARLY_LOOP_SEC) &&
      take.endFrame - take.startFrame === this.loopFrames &&
      now >= take.startFrame &&
      take.endFrame - now <= this.frames(PEEK_LEAD_SEC)
    ) {
      take.peeked = true;
      this.audio.peekRecording(take.id);
    }

    // Restart stopped layers together at a loop boundary.
    if (this.pendingResumeFrame !== null && this.pendingResumeFrame <= horizon) {
      const at = this.pendingResumeFrame;
      this.pendingResumeFrame = null;
      for (const layer of this.layers) this.startLayer(layer, at);
      this.playing = true;
    }
  }

  private clickWanted(frame: number): boolean {
    if (!this.metronomeOn) return false;
    const take = this.take;
    if (take && frame >= take.countInStart && frame < take.endFrame) return true;
    return this.metronomeAlways && this.layers.length > 0;
  }

  // ---------------------------------------------------------------------------
  // What the screen needs to show
  // ---------------------------------------------------------------------------

  snapshot(): LooperSnapshot {
    const a = this.audio;
    const now = a.nowFrame();
    const take = this.take;
    const barF = this.tempo.barFrames;

    let state: LooperState;
    if (take) state = now < take.startFrame ? "countIn" : "recording";
    else if (this.layers.length === 0) state = "idle";
    else state = this.playing ? "playing" : "stopped";

    let playhead: number | null = null;
    if (this.originFrame !== null) {
      if (this.loopFrames !== null) {
        playhead = state === "countIn" && this.layers.length === 0 ? 0 : mod(now - this.originFrame, this.loopFrames) / this.loopFrames;
      } else if (take) {
        // An open "auto" take: show progress through the current bar.
        playhead = state === "recording" ? mod(now - take.startFrame, barF) / barF : 0;
      }
    }

    return {
      state,
      layers: this.layers.length,
      bpm: effectiveBpm(this.tempo),
      barsSetting: this.barsSetting,
      loopBars: this.loopFrames === null ? null : this.loopFrames / barF,
      playhead,
      beatsToStart: take && state === "countIn" ? Math.max(1, Math.ceil((take.startFrame - now) / this.tempo.beatFrames)) : null,
      recBar: take && state === "recording" ? Math.floor((now - take.startFrame) / barF) + 1 : null,
      locked: this.locked,
      latencyMs: (a.latencySec() + this.trimMs / 1000) * 1000,
      micLevel: a.micPeak,
      layersVersion: this.version,
    };
  }

  private frames(seconds: number): number {
    return Math.round(seconds * this.audio.sampleRate);
  }
}
