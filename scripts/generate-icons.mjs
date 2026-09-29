#!/usr/bin/env node
// Renders the extension icons (rounded tile, light disc, black censor bar) as PNG files
// without any image dependencies. Run with `npm run icons`.
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Each layer is a colour plus a hit-test in normalised [0, 1] icon coordinates.
function layers() {
  const inRoundedTile = (x, y) => {
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const inDisc = (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.31 ** 2;
  const inBar = (x, y) => Math.abs(y - 0.5) <= 0.09 && Math.abs(x - 0.5) <= 0.36;
  return [
    { color: [31, 41, 55], hit: inRoundedTile },
    { color: [229, 231, 235], hit: inDisc },
    { color: [0, 0, 0], hit: inBar },
  ];
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const shapes = layers();
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          let color = null;
          for (const shape of shapes) if (shape.hit(x, y)) color = shape.color;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const offset = (py * size + px) * 4;
      const covered = a / 255;
      // Store straight (non-premultiplied) colour averaged over the covered samples only.
      rgba[offset] = covered ? Math.round(r / covered) : 0;
      rgba[offset + 1] = covered ? Math.round(g / covered) : 0;
      rgba[offset + 2] = covered ? Math.round(b / covered) : 0;
      rgba[offset + 3] = Math.round(a / samples);
    }
  }
  return encodePng(size, rgba);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  await writeFile(path.join(outDir, `icon-${size}.png`), render(size));
}
console.log(`[icons] Wrote ${SIZES.map((s) => `icon-${s}.png`).join(", ")} to ${outDir}`);
