// Draws the pixel-crab app icon at every size the app, installers and tray need.
// Pixel art is painted cell by cell at integer scales (no resampling blur), and
// written with a tiny built-in PNG / ICO encoder — no image libraries needed.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const PAL = {
  o: [0xd9, 0x77, 0x57], // crab
  h: [0xec, 0x9a, 0x7a], // highlight
  s: [0xb3, 0x5a, 0x3c], // shade
  e: [0x2a, 0x1a, 0x14], // eyes
  p: [0xf4, 0xa3, 0xa3], // blush
  w: [0xff, 0xff, 0xff],
  B: [0x24, 0x1c, 0x30], // background
  T: [0x31, 0x27, 0x42], // background top light
  R: [0x3c, 0x30, 0x52], // rim
};

// ── the crab from the app (src/ui/components/Mascots.tsx), 24 × 18 ───────────
const CLAW_L = ['hh.hh...', 'oo.oo...', 'ooooo...', 'sooos...', '.sss....', '..o.....', '..oo....', '...oo...'];
const CLAW_R = CLAW_L.map((r) => r.split('').reverse().join(''));
const BIG_CRAB = (() => {
  const rows = Array.from({ length: 18 }, () => '.'.repeat(24).split(''));
  const put = (lines, x0, y0) => lines.forEach((l, y) => [...l].forEach((c, x) => c !== '.' && (rows[y0 + y][x0 + x] = c)));
  put(CLAW_L, 0, 0);
  put(CLAW_R, 16, 0);
  put(['hhhhhhhhhhhh', 'oooooooooooooo', 'oooooooooooooo', 'oooooooooooooo', 'oooooooooooooo', 'oooooooooooooo', 'ssssssssssssss', 'ssssssssssss'].map((l, i) => (i === 0 || i === 7 ? '.' + l : l)), 5, 7);
  put(['....e....e....', '....e....e....', '..p........p..', '......kk......'.replace(/k/g, 'e')], 5, 9);
  put(['.s.s......s.s', '.s.s......s.s', 's..s......s..s'], 5, 15);
  return rows.map((r) => r.join(''));
})();

// ── a 16 × 16 crab for tray and tiny icons (one cell = one pixel at 16 px) ───
const TINY_CRAB = [
  '................',
  '.hh.hh....hh.hh.',
  '.ooooo....ooooo.',
  '.sooos....sooos.',
  '..sss......sss..',
  '...o........o...',
  '...oo......oo...',
  '...hhhhhhhhhh...',
  '..oooooooooooo..',
  '..oooeooooeooo..',
  '..oooeooooeooo..',
  '..opoooeeooopo..',
  '..ssssssssssss..',
  '...s.s....s.s...',
  '..s..s....s..s..',
  '................',
];

/** An RGBA canvas painted in grid cells of `scale` px. */
function canvas(size) {
  const px = Buffer.alloc(size * size * 4);
  return {
    size,
    px,
    cell(x, y, c, scale, alpha = 255) {
      const rgb = PAL[c];
      if (!rgb) return;
      for (let j = 0; j < scale; j++)
        for (let i = 0; i < scale; i++) {
          const X = x * scale + i;
          const Y = y * scale + j;
          if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
          const k = (Y * size + X) * 4;
          px[k] = rgb[0];
          px[k + 1] = rgb[1];
          px[k + 2] = rgb[2];
          px[k + 3] = alpha;
        }
    },
  };
}

/** Rounded square on an n × n grid, corners stepped in pixels. */
function background(cv, n, scale, radius) {
  const inside = (x, y) => {
    const cx = x < radius ? radius : x > n - 1 - radius ? n - 1 - radius : x;
    const cy = y < radius ? radius : y > n - 1 - radius ? n - 1 - radius : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius + radius * 0.6;
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      cv.cell(x, y, edge ? 'R' : y < n * 0.42 ? 'T' : 'B', scale);
    }
}

function sprite(cv, rows, x0, y0, scale) {
  rows.forEach((r, y) => [...r].forEach((c, x) => c !== '.' && cv.cell(x0 + x, y0 + y, c, scale)));
}

/** App icon: big crab on a 32-cell rounded square (sizes that are multiples of 32). */
function bigIcon(size) {
  const scale = size / 32;
  const cv = canvas(size);
  background(cv, 32, scale, 7);
  sprite(cv, BIG_CRAB, 4, 8, scale);
  return cv;
}

/** Small app icon: the tiny crab on a 16-cell rounded square. */
function smallIcon(size) {
  const scale = size / 16;
  const cv = canvas(size);
  background(cv, 16, scale, 3);
  sprite(cv, TINY_CRAB, 0, 0, scale);
  return cv;
}

/** 24 px: the tiny crab at 1:1, centred on a 24-cell square — crisp, unlike a 1.5× scale. */
function icon24() {
  const cv = canvas(24);
  background(cv, 24, 1, 4);
  sprite(cv, TINY_CRAB, 4, 4, 1);
  return cv;
}

/** Tray: the tiny crab alone on transparent (reads on light and dark panels). */
function trayIcon(size) {
  const cv = canvas(size);
  sprite(cv, TINY_CRAB, 0, 0, size / 16);
  return cv;
}

// ── encoders ────────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(cv) {
  const { size, px } = cv;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** ICO with PNG-compressed entries (Windows Vista+). */
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  const bodies = images.map(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
    return data;
  });
  return Buffer.concat([head, ...bodies]);
}
/** The big design as crisp SVG rects (web favicon / manifest). */
function svg() {
  const rects = [];
  const n = 32;
  const cv = { cell: (x, y, c) => PAL[c] && rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="#${PAL[c].map((v) => v.toString(16).padStart(2, '0')).join('')}"/>`) };
  background(cv, n, 1, 7);
  sprite(cv, BIG_CRAB, 4, 8, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

// ── write everything ────────────────────────────────────────────────────────
const appIcon = (s) => (s % 32 === 0 && s >= 64 ? bigIcon(s) : s === 24 ? icon24() : smallIcon(s));
const out = (rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  console.log('wrote', rel);
};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) out(`assets/icons/${s}x${s}.png`, png(appIcon(s)));
out('assets/icon.png', png(bigIcon(512)));
out('src/ui/public/icon.png', png(bigIcon(512)));
out('src/ui/public/icon.svg', svg());
out('assets/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: png(appIcon(s)) }))));
out('assets/tray.png', png(trayIcon(32)));
out('assets/tray@2x.png', png(trayIcon(64)));
const tray24 = () => {
  const cv = canvas(24);
  sprite(cv, TINY_CRAB, 4, 4, 1);
  return cv;
};
out('assets/tray.ico', ico([16, 24, 32, 48].map((s) => ({ size: s, data: png(s === 24 ? tray24() : trayIcon(s)) }))));
