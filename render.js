'use strict';

/**
 * kingshot-hive/render.js
 * Renders the hive as a PNG with zero npm dependencies.
 * Uses a tiny built-in bitmap font (5x7) so it works on any host, including
 * ones where node-canvas will not compile.
 *
 * If you would rather use @napi-rs/canvas or sharp for prettier text, replace
 * renderPNG() and leave everything else alone - the rest of the bot never
 * touches pixels.
 */

const W = 5, H = 7; // glyph cell size

// Only the characters that appear in player tags and labels. Extend freely.
const GLYPHS = {
  '0': [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
  '1': [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
  '2': [0b01110,0b10001,0b00001,0b00110,0b01000,0b10000,0b11111],
  '3': [0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
  '4': [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
  '5': [0b11111,0b10000,0b11110,0b00001,0b00001,0b10001,0b01110],
  '6': [0b00110,0b01000,0b10000,0b11110,0b10001,0b10001,0b01110],
  '7': [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
  '8': [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
  '9': [0b01110,0b10001,0b10001,0b01111,0b00001,0b00010,0b01100],
  'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C': [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
  'D': [0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
  'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
  'G': [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
  'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I': [0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
  'J': [0b00111,0b00010,0b00010,0b00010,0b00010,0b10010,0b01100],
  'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M': [0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
  'N': [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
  'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V': [0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
  'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
  'X': [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
  'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
  ' ': [0,0,0,0,0,0,0],
  '-': [0,0,0,0b11111,0,0,0],
  ',': [0,0,0,0,0,0b00100,0b01000],
  '.': [0,0,0,0,0,0b00110,0b00110],
  ':': [0,0b00110,0b00110,0,0b00110,0b00110,0],
  '&': [0b01100,0b10010,0b10100,0b01000,0b10101,0b10010,0b01101],
  '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
};

// ---------------------------------------------------------------------------
// A very small PNG encoder: RGBA scanlines -> zlib store blocks -> PNG.
// ---------------------------------------------------------------------------
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
function createCanvas(width, height, bg = [255, 255, 255, 255]) {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = bg[3];
  }
  return {
    width, height, px,
    set(x, y, [r, g, b, a = 255]) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      if (a === 255) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; return; }
      const af = a / 255;
      px[i] = Math.round(px[i] * (1 - af) + r * af);
      px[i + 1] = Math.round(px[i + 1] * (1 - af) + g * af);
      px[i + 2] = Math.round(px[i + 2] * (1 - af) + b * af);
      px[i + 3] = 255;
    },
    rect(x, y, w, h, colour) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, colour);
    },
    stroke(x, y, w, h, colour, t = 2) {
      this.rect(x, y, w, t, colour);
      this.rect(x, y + h - t, w, t, colour);
      this.rect(x, y, t, h, colour);
      this.rect(x + w - t, y, t, h, colour);
    },
    text(str, x, y, colour, scale = 1) {
      let cx = x;
      for (const ch of String(str).toUpperCase()) {
        const glyph = GLYPHS[ch] || GLYPHS[' '];
        for (let row = 0; row < H; row++) {
          for (let col = 0; col < W; col++) {
            if (glyph[row] & (1 << (W - 1 - col))) {
              for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.set(cx + col * scale + sx, y + row * scale + sy, colour);
            }
          }
        }
        cx += (W + 1) * scale;
      }
      return cx;
    },
    toPNG() { return encodePNG(width, height, px); },
  };
}

// ---------------------------------------------------------------------------
// Hive renderer
// ---------------------------------------------------------------------------
const PALETTE = {
  '1': { fill: [219, 234, 254], stroke: [37, 99, 235], text: [23, 36, 58] },
  '2': { fill: [204, 241, 221], stroke: [22, 131, 75], text: [23, 36, 58] },
  both: { fill: [234, 221, 251], stroke: [137, 80, 199], text: [23, 36, 58] },
  bear: { fill: [255, 229, 189], stroke: [207, 131, 27], text: [92, 51, 6] },
  fixed: { fill: [226, 232, 240], stroke: [100, 116, 139], text: [51, 65, 85] },
};

function renderPNG(result, opts = {}) {
  const tile = opts.tile || 56;
  const pad = opts.pad || 48;
  const { map, assignments } = result;

  const items = [
    ...assignments.map((a) => ({ x: a.spot.x, y: a.spot.y, w: 2, h: 2 })),
    ...map.bears.map((b) => ({ x: b.anchorX, y: b.anchorY, w: b.w || 3, h: b.h || 3 })),
    ...map.fixedObjects.map((o) => ({ x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
  ];
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.h));

  const cols = maxX - minX + 2;
  const rows = maxY - minY + 2;
  const width = pad * 2 + cols * tile;
  const height = pad * 2 + rows * tile + 40;

  const c = createCanvas(width, height);
  const px = (x) => pad + (x - minX + 1) * tile;
  const py = (y) => pad + (maxY + 1 - y) * tile;

  // Grid
  for (let x = minX - 1; x <= maxX + 1; x++) for (let y = minY - 1; y <= maxY + 1; y++) {
    c.stroke(px(x), py(y), tile, tile, [241, 245, 249], 1);
  }

  const drawBox = (x, y, w, h, pal, lines) => {
    const left = px(x), top = py(y + h), bw = w * tile, bh = h * tile;
    c.rect(left + 1, top + 1, bw - 2, bh - 2, [...pal.fill, 255]);
    c.stroke(left, top, bw, bh, [...pal.stroke, 255], 2);
    lines.forEach((line, i) => {
      const text = String(line).toUpperCase();
      const tw = text.length * 6 - 1;
      c.text(text, Math.round(left + (bw - tw) / 2), top + 14 + i * 16, [...pal.text, 255], 1);
    });
  };

  for (const a of assignments) {
    const key = require('./hive').isDual(a.player) ? 'both' : String(a.player.group || '1');
    const pal = PALETTE[key] || PALETTE['1'];
    const score = a.player.score >= 1000 ? `${(a.player.score / 1000).toFixed(a.player.score % 1000 ? 1 : 0)}B` : `${a.player.score}M`;
    drawBox(a.spot.x, a.spot.y, 2, 2, pal, [a.player.name, score, `${a.spot.x},${a.spot.y}`]);
  }
  for (const b of map.bears) drawBox(b.anchorX, b.anchorY, b.w || 3, b.h || 3, PALETTE.bear, [b.name]);
  for (const o of map.fixedObjects) drawBox(o.x, o.y, o.w || 2, o.h || 2, PALETTE.fixed, []);

  // Title + legend
  c.text(opts.title || 'Kingshot hive plan', pad, 16, [23, 36, 58, 255], 2);
  const ly = height - 28;
  const legend = [['BEAR 1', '1'], ['BEAR 2', '2'], ['BOTH', 'both'], ['OBJECT', 'fixed']];
  let lx = pad;
  for (const [label, key] of legend) {
    c.rect(lx, ly, 14, 14, [...PALETTE[key].stroke, 255]);
    lx = c.text(label, lx + 20, ly + 4, [23, 36, 58, 255], 1) + 24;
  }
  return c.toPNG();
}

/** Plain-text table, for a Discord code block. */
function renderText(result) {
  const require_hive = require('./hive');
  const rows = result.assignments.map((a) => [
    a.player.name,
    String(a.player.score >= 1000 ? `${(a.player.score / 1000).toFixed(1)}b` : `${a.player.score}m`),
    require_hive.isDual(a.player) ? 'both' : String(a.player.group || '1'),
    `${a.spot.x},${a.spot.y}`,
    a.travel.toFixed(1),
  ]);
  const head = ['PLAYER', 'SCORE', 'BEAR', 'SPOT', 'TILES'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [`\`\`\``, line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line), '```'].join('\n');
}

module.exports = { renderPNG, renderText, createCanvas, encodePNG, PALETTE };
