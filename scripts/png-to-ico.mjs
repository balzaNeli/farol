import { readFileSync, writeFileSync } from "node:fs";

const png = readFileSync("flaticon.png");

// ICO header (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = 1 (icon)
header.writeUInt16LE(1, 4);      // count = 1 image

// Icon directory entry (16 bytes)
const entry = Buffer.alloc(16);
entry[0] = 0;                    // width (0 = 256)
entry[1] = 0;                    // height (0 = 256)
entry[2] = 0;                    // color count
entry[3] = 0;                    // reserved
entry.writeUInt16LE(0, 4);       // color planes
entry.writeUInt16LE(32, 6);      // bits per pixel
entry.writeUInt32LE(png.length, 8); // size of image data
entry.writeUInt32LE(22, 12);     // offset of image data (6 + 16)

const ico = Buffer.concat([header, entry, png]);
writeFileSync("build/icon.ico", ico);
console.log("build/icon.ico created", ico.length, "bytes");
