// Renders assets/icon.png (and the extension icons): a white download arrow on
// a blue rounded square. Pure Node.js PNG encoder, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in a 0..1 coordinate space.
function insideRoundedSquare(x: number, y: number): boolean {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideArrow(x: number, y: number): boolean {
  const shaft = x >= 0.43 && x <= 0.57 && y >= 0.17 && y <= 0.55;
  // Head: triangle with apex at (0.5, 0.72) and base from 0.25 to 0.75 at y = 0.45.
  const head = y >= 0.45 && y <= 0.72 && Math.abs(x - 0.5) <= (0.72 - y) * (0.25 / 0.27);
  const tray = x >= 0.22 && x <= 0.78 && y >= 0.78 && y <= 0.86;
  return shaft || head || tray;
}

function render(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideRoundedSquare(x, y)) {
            bg++;
            if (insideArrow(x, y)) fg++;
          }
        }
      }
      const n = samples * samples;
      const alpha = bg / n;
      const white = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      // Blend white over the blue (#2563eb) fill.
      rgba[i] = Math.round(0x25 + (255 - 0x25) * white);
      rgba[i + 1] = Math.round(0x63 + (255 - 0x63) * white);
      rgba[i + 2] = Math.round(0xeb + (255 - 0xeb) * white);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

// Compiled to dist/scripts; the icons live at the project root.
const root = path.join(__dirname, '..', '..');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), render(256));
fs.mkdirSync(path.join(root, 'extension', 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(root, 'extension', 'icons', `icon${size}.png`), render(size));
}
console.log('Ícones gerados em assets/ e extension/icons/');
