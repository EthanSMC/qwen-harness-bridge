import { Buffer } from "node:buffer";

const BLOCK = 512;

const writeOctal = (value, length) => {
  const text = value.toString(8);
  return `${text.padStart(length - 1, "0")}\0`;
};

const writeString = (value, length) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("tar field too long");
  const field = Buffer.alloc(length);
  bytes.copy(field);
  return field;
};

/** Create a deterministic (mtime 0, uid/gid 0, sorted) ustar archive. */
export function createTar(entries) {
  const ordered = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const blocks = [];
  for (const entry of ordered) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const header = Buffer.alloc(BLOCK);
    writeString(entry.name, 100).copy(header, 0);
    writeString(writeOctal(0o644, 8), 8).copy(header, 100);
    writeString(writeOctal(0, 8), 8).copy(header, 108);
    writeString(writeOctal(0, 8), 8).copy(header, 116);
    writeString(writeOctal(data.length, 12), 12).copy(header, 124);
    writeString(writeOctal(0, 12), 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeString("ustar\0", 6).copy(header, 257);
    writeString("00", 2).copy(header, 263);
    writeString("root", 32).copy(header, 265);
    writeString("root", 32).copy(header, 297);
    writeString(writeOctal(0, 8), 8).copy(header, 329);
    writeString(writeOctal(0, 8), 8).copy(header, 337);
    let sum = 0;
    for (const byte of header) sum += byte;
    writeString(writeOctal(sum, 8), 8).copy(header, 148);
    blocks.push(header, data);
    const remainder = data.length % BLOCK;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK - remainder));
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(blocks);
}

/** Read a ustar archive into [{ name, data }]. */
export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/u, "").trim(),
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("invalid tar entry size");
    const start = offset + BLOCK;
    const data = buffer.subarray(start, start + size);
    entries.push({ name, data: Buffer.from(data) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
