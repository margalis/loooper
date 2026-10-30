// session.ts
// Turns a looper session into a zip file and back.
//
// The zip holds:
//   session.json    tempo, loop length, and each layer's name, volume and mute state
//   layer-1.wav ... one lossless file per layer (open them in Audacity, a DAW, anything)
//   mixdown.wav     everything together, as you heard it (muted layers left out)
//   README.txt      a short explanation
//
// Solo, the click settings and latency trim are not saved: they belong to the moment, not the music.

import { MASTER_GAIN, MAX_VOLUME, volumeToGain } from "../audio/mix";
import { decodeWav, encodeWav16, encodeWavFloat32 } from "./wav";
import { buildZip, readZip } from "./zip";

export interface SessionLayer {
  name: string;
  volume: number;
  muted: boolean;
  samples: Float32Array;
}

export interface SessionData {
  sampleRate: number;
  bpm: number;
  bars: number;
  layers: SessionLayer[];
}

const FORMAT = "gesture-looper-session";

interface SessionJson {
  format: string;
  version: number;
  savedAt: string;
  sampleRate: number;
  bpm: number;
  bars: number;
  layers: { name: string; volume: number; muted: boolean; file: string }[];
}

/** All unmuted layers added together at their volumes, scaled down only if it would clip. */
export function mixdown(data: SessionData): Float32Array {
  const length = data.layers.reduce((max, l) => Math.max(max, l.samples.length), 0);
  const out = new Float32Array(length);
  for (const layer of data.layers) {
    if (layer.muted) continue;
    const g = volumeToGain(layer.volume) * MASTER_GAIN;
    for (let i = 0; i < layer.samples.length; i++) out[i] += layer.samples[i] * g;
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.99) {
    const scale = 0.99 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

export function buildSessionZip(data: SessionData, when: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [];

  const meta: SessionJson = {
    format: FORMAT,
    version: 1,
    savedAt: when.toISOString(),
    sampleRate: data.sampleRate,
    bpm: data.bpm,
    bars: data.bars,
    layers: data.layers.map((l, i) => ({ name: l.name, volume: l.volume, muted: l.muted, file: `layer-${i + 1}.wav` })),
  };
  files.push({ name: "session.json", data: encoder.encode(JSON.stringify(meta, null, 2)) });
  data.layers.forEach((l, i) => files.push({ name: `layer-${i + 1}.wav`, data: encodeWavFloat32(l.samples, data.sampleRate) }));
  files.push({ name: "mixdown.wav", data: encodeWav16(mixdown(data), data.sampleRate) });
  files.push({
    name: "README.txt",
    data: encoder.encode(
      [
        "Gesture Looper session",
        "",
        "Open this zip file with the Load button in Gesture Looper to continue where you left off.",
        "",
        "layer-N.wav   each layer on its own (32-bit float, mono). Volume and mute are NOT applied.",
        "mixdown.wav   all unmuted layers together at their volumes (16-bit, mono).",
        "session.json  tempo, loop length and layer settings. Edit with care.",
        "",
        `Tempo: ${data.bpm} BPM, ${data.bars} bar${data.bars === 1 ? "" : "s"}, ${data.layers.length} layer${data.layers.length === 1 ? "" : "s"}.`,
        "",
      ].join("\n"),
    ),
  });
  return buildZip(files, when);
}

/** Reads a zip made by buildSessionZip. Throws a readable Error if it is not one. */
export async function parseSessionZip(bytes: Uint8Array): Promise<SessionData> {
  const files = await readZip(bytes);
  const metaBytes = files.get("session.json");
  if (!metaBytes) throw new Error("This zip has no session.json. Is it a Gesture Looper session?");

  let meta: SessionJson;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SessionJson;
  } catch {
    throw new Error("session.json could not be read");
  }
  if (meta.format !== FORMAT) throw new Error("This zip is not a Gesture Looper session");
  if (!Array.isArray(meta.layers) || meta.layers.length === 0) throw new Error("This session has no layers");

  const layers: SessionLayer[] = [];
  let sampleRate = Number(meta.sampleRate);
  for (const entry of meta.layers) {
    const wav = files.get(entry.file);
    if (!wav) throw new Error(`Missing ${entry.file} in the zip`);
    const decoded = decodeWav(wav);
    sampleRate = decoded.sampleRate; // trust the audio file over the json
    layers.push({
      name: String(entry.name ?? entry.file),
      volume: Math.min(MAX_VOLUME, Math.max(0, Number(entry.volume ?? 1))),
      muted: Boolean(entry.muted),
      samples: decoded.samples,
    });
  }
  const bpm = Number(meta.bpm);
  const bars = Number(meta.bars);
  if (!Number.isFinite(bpm) || !Number.isFinite(bars) || bars < 1) throw new Error("session.json has invalid tempo or length");
  return { sampleRate, bpm, bars, layers };
}
