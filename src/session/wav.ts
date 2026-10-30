// wav.ts
// Reads and writes WAV audio files by hand, so no library is needed.
//   - Layers (stems) are saved as 32-bit float: exactly what is in memory, nothing lost.
//   - The mixdown is saved as 16-bit: plays everywhere.

function writeText(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Mono, 32-bit float WAV. Every DAW and Audacity can open it. */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 4;
  const bytes = new Uint8Array(58 + dataBytes);
  const v = new DataView(bytes.buffer);
  writeText(v, 0, "RIFF");
  v.setUint32(4, 50 + dataBytes, true);
  writeText(v, 8, "WAVE");
  writeText(v, 12, "fmt ");
  v.setUint32(16, 18, true); // format chunk size
  v.setUint16(20, 3, true); // 3 = IEEE float
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true); // bytes per second
  v.setUint16(32, 4, true); // bytes per frame
  v.setUint16(34, 32, true); // bits per sample
  v.setUint16(36, 0, true); // no extra format data
  writeText(v, 38, "fact");
  v.setUint32(42, 4, true);
  v.setUint32(46, samples.length, true);
  writeText(v, 50, "data");
  v.setUint32(54, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setFloat32(58 + i * 4, samples[i], true);
  return bytes;
}

/** Mono, 16-bit WAV (CD style). Values beyond full scale are clipped. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const v = new DataView(bytes.buffer);
  writeText(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeText(v, 8, "WAVE");
  writeText(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // 1 = PCM
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeText(v, 36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767), true);
  }
  return bytes;
}

export interface DecodedWav {
  sampleRate: number;
  /** All channels mixed down to one. */
  samples: Float32Array;
}

/** Reads 16/24/32-bit integer and 32-bit float WAV files (any number of channels). */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(v.getUint8(offset), v.getUint8(offset + 1), v.getUint8(offset + 2), v.getUint8(offset + 3));
  if (bytes.length < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("Not a WAV file");

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = text(pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true); // "extensible": real format inside
    } else if (id === "data") {
      dataStart = body;
      dataLength = Math.min(size, bytes.length - body);
      break;
    }
    pos = body + size + (size % 2); // chunks are padded to an even length
  }
  if (dataStart < 0 || channels < 1 || sampleRate < 1) throw new Error("Damaged WAV file");

  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPerSample;
      let value: number;
      if (format === 3 && bits === 32) value = v.getFloat32(at, true);
      else if (format === 1 && bits === 16) value = v.getInt16(at, true) / 32768;
      else if (format === 1 && bits === 24) value = ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) / 8388608);
      else if (format === 1 && bits === 32) value = v.getInt32(at, true) / 2147483648;
      else throw new Error(`Unsupported WAV format (${format}, ${bits} bit)`);
      sum += value;
    }
    samples[i] = sum / channels;
  }
  return { sampleRate, samples };
}
