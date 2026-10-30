// zip.ts
// A minimal zip writer and reader, so saving a session needs no library.
// Writing stores files uncompressed (audio barely compresses anyway). Reading also
// understands normal compressed zips, in case you re-zip a session with another tool.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The checksum zip files use to detect damage. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

export function buildZip(files: ZipFile[], when: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const dosDate = ((((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff) >>> 0;

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    // Local header + file data.
    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);

    // Central directory entry (the table of contents at the end of the file).
    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x0800, true);
    ev.setUint16(10, 0, true);
    ev.setUint16(12, dosTime, true);
    ev.setUint16(14, dosDate, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, size, true);
    ev.setUint32(24, size, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local);
    central.push(entry);
    offset += local.length;
  }

  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns every file in the zip, by name. Throws a readable error if the zip is damaged. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the "end of central directory" record by scanning backwards for its signature.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This is not a zip file");

  const count = v.getUint16(end + 10, true);
  let pos = v.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();

  for (let n = 0; n < count; n++) {
    if (v.getUint32(pos, true) !== 0x02014b50) throw new Error("The zip file is damaged");
    const method = v.getUint16(pos + 10, true);
    const crc = v.getUint32(pos + 16, true);
    const compressedSize = v.getUint32(pos + 20, true);
    const nameLength = v.getUint16(pos + 28, true);
    const extraLength = v.getUint16(pos + 30, true);
    const commentLength = v.getUint16(pos + 32, true);
    const localOffset = v.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;

    if (v.getUint32(localOffset, true) !== 0x04034b50) throw new Error("The zip file is damaged");
    const dataStart = localOffset + 30 + v.getUint16(localOffset + 26, true) + v.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`Unsupported zip compression (${method})`);

    if (crc32(data) !== crc) throw new Error(`"${name}" is damaged (checksum mismatch)`);
    files.set(name, data);
  }
  return files;
}
