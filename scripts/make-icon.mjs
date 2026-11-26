// Draws the application icon as a multi-size ICO without any image library: a rounded
// square with the three dots the panel uses for "agents", written as raw BGRA bitmaps
// with an AND mask (ICO's classic format, which every Windows shell reads).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'desktop', 'app.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function render(size) {
  const px = Array.from({ length: size }, () => new Uint8Array(size * 4));
  const put = (x, y, colour, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const row = px[y];
    const i = x * 4;
    const before = row[i + 3] / 255;
    const after = alpha / 255;
    const out = after + before * (1 - after);
    for (let c = 0; c < 3; c++) row[i + c] = out === 0 ? 0 : Math.round((colour[c] * after + row[i + c] * before * (1 - after)) / out);
    row[i + 3] = Math.round(out * 255);
  };
  const radius = size * 0.22;
  const inside = (x, y, inset) => {
    const l = inset, r = size - inset, t = inset, b = size - inset, rad = Math.max(0, radius - inset * 0.4);
    const cx = x + 0.5, cy = y + 0.5;
    const dx = Math.max(l + rad - cx, cx - (r - rad), 0);
    const dy = Math.max(t + rad - cy, cy - (b - rad), 0);
    return dx * dx + dy * dy <= rad * rad;
  };
  const bg = [26, 42, 58];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) if (inside(x + ox, y + oy, 0)) a += 64;
    if (a) put(x, y, bg, a);
  }
  const dot = (cx, cy, r, colour) => {
    for (let y = Math.floor(cy - r) - 1; y <= cy + r + 1; y++) for (let x = Math.floor(cx - r) - 1; x <= cx + r + 1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.max(0, Math.min(1, r - d + 0.5));
      if (cover > 0) put(x, y, colour, Math.round(cover * 255));
    }
  };
  const c = size / 2;
  const r = size * 0.13;
  dot(c, c - size * 0.2, r, [236, 110, 70]);
  dot(c - size * 0.21, c + size * 0.13, r, [90, 170, 235]);
  dot(c + size * 0.21, c + size * 0.13, r, [120, 200, 140]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const cover = Math.max(0, Math.min(1, size * 0.035 - d + 0.5));
    if (cover > 0) put(x, y, [26, 42, 58], Math.round(cover * 255));
  }
  return px;
}

const images = sizes.map(size => {
  const px = render(size);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) xor.set(px[size - 1 - y], y * size * 4);
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size, 0xff);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const alpha = px[size - 1 - y][x * 4 + 3];
    if (alpha > 0) mask[y * maskRow + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(0x2003, 20);
  return { size, data: Buffer.concat([header, xor, mask]) };
});
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((image, i) => {
  const at = 6 + i * 16;
  header.writeUInt8(image.size === 256 ? 0 : image.size, at);
  header.writeUInt8(image.size === 256 ? 0 : image.size, at + 1);
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(image.data.length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, ...images.map(i => i.data)]));
console.log('Wrote ' + output + ' (' + sizes.join(', ') + ')');
