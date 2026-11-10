import fs from "node:fs";
import zlib from "node:zlib";

// ---------- CRC-32 ----------
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- gerar PNG ----------
function makePng(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d < r) {
        raw[pxOffset] = 0xff; raw[pxOffset + 1] = 0xff; raw[pxOffset + 2] = 0xff; raw[pxOffset + 3] = 0xff;
      } else {
        raw[pxOffset] = 0xff; raw[pxOffset + 1] = 0x8a; raw[pxOffset + 2] = 0x15; raw[pxOffset + 3] = 0xff;
      }
    }
  }
  const compressed = zlib.deflateRawSync(raw);
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const size = 256;
fs.writeFileSync("build/farol-256.png", makePng(size));
console.log("build/farol-256.png saved");
