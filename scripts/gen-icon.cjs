const fs = require("node:fs");
const zlib = require("node:zlib");

// Implementação simples de CRC-32 (mesmo polinômio usado pelo PNG)
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

// ---------- gerar um PNG quadrado de qualquer tamanho ----------
function makePng(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;

  const rowBytes = 1 + size * 4; // 1 byte de filtro + 4 bytes por pixel
  const raw = Buffer.alloc(size * rowBytes);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0; // filtro "none"
    for (let x = 0; x < size; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
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
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type = RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Tamanhos para o ICO (Windows exige múltiplos tamanhos para ser válido)
const sizes = [16, 32, 48, 256];
const images = sizes.map((s) => ({ size: s, png: makePng(s) }));

// ---------- montar ICO ----------
let offset = 6 + sizes.length * 16; // cabeçalho + todas as entradas de diretório

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);     // reserved
header.writeUInt16LE(1, 2);     // type = 1 (icon)
header.writeUInt16LE(1, sizes.length); // count

const entries = [];
for (const { size, png } of images) {
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height (0 = 256)
  entry[2] = 0;                      // color count
  entry[3] = 0;                      // reserved
  entry.writeUInt16LE(0, 4);         // color planes
  entry.writeUInt16LE(32, 6);        // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of image data
  entry.writeUInt32LE(offset, 12);   // offset of image data
  entries.push(entry);
  offset += png.length;
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
fs.writeFileSync("build/farol.ico", ico);
console.log("build/farol.ico created", ico.length, "bytes", "sizes:", sizes.join(","));

// também salva o PNG maior para referência
fs.writeFileSync("build/farol-256.png", images.find((i) => i.size === 256).png);
console.log("build/farol-256.png saved");
