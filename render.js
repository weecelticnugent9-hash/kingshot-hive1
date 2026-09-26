'use strict';

/**
 * kingshot-hive/render.js
 * Renders the hive as a PNG with zero npm dependencies.
 *
 * Style: one filled square per placed city, showing a slot number on the first
 * line and an optional second line (score / time / bear tag). Colours are
 * assigned per bear group, and the hue varies between neighbours so adjacent
 * squares never look like one block.
 *
 * The grid also draws the obstacles (traps and unmovable objects) so the map
 * reads the way the in-game plan does.
 */

const W = 5, H = 7; // glyph cell size

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
  '!': [0b00100,0b00100,0b00100,0b00100,0b00100,0,0b00100],
  '?': [0b01110,0b10001,0b00001,0b00110,0b00100,0,0b00100],
  '&': [0b01100,0b10010,0b10100,0b01000,0b10101,0b10010,0b01101],
  '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
  '(': [0b00010,0b00100,0b01000,0b01000,0b01000,0b00100,0b00010],
  ')': [0b01000,0b00100,0b00010,0b00010,0b00010,0b00100,0b01000],
  "'": [0b00100,0b00100,0,0,0,0,0],
  '+': [0,0b00100,0b00100,0b11111,0b00100,0b00100,0],
};

// ---------------------------------------------------------------------------
// PNG encoder
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
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
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    },
    rect(x, y, w, h, colour) {
      const [r, g, b] = colour;
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(width, x + w), y1 = Math.min(height, y + h);
      if (x1 <= x0 || y1 <= y0) return;
      // Build one scanline, then copy it per row. Writing pixel by pixel is
      // ~50x slower and at a 64px tile a city box is 128x128 = 16k pixels.
      const row = Buffer.alloc((x1 - x0) * 4);
      for (let i = 0; i < x1 - x0; i++) {
        row[i * 4] = r; row[i * 4 + 1] = g; row[i * 4 + 2] = b; row[i * 4 + 3] = 255;
      }
      for (let yy = y0; yy < y1; yy++) row.copy(px, (yy * width + x0) * 4);
    },
    stroke(x, y, w, h, colour, t = 2) {
      this.rect(x, y, w, t, colour);
      this.rect(x, y + h - t, w, t, colour);
      this.rect(x, y, t, h, colour);
      this.rect(x + w - t, y, t, h, colour);
    },
    /** Draw text as filled glyph blocks, centred on (cx, cy). */
    textCentred(str, cx, cy, colour, scale = 1) {
      const s = String(str).toUpperCase();
      // Each glyph occupies W*scale px, then a gap of `scale` px, so the
      // advance is (W+1)*scale. The trailing gap is not drawn, hence the -scale.
      let total = 0;
      for (const ch of s) total += (W + 1) * scale;
      total -= scale;
      let x = Math.round(cx - total / 2);
      const y = Math.round(cy - (H * scale) / 2);
      for (const ch of s) {
        const glyph = GLYPHS[ch] || GLYPHS[' '];
        for (let row = 0; row < H; row++) {
          const bits = glyph[row];
          let col = 0;
          while (col < W) {
            if (bits & (1 << (W - 1 - col))) {
              let run = 1;
              while (col + run < W && (bits & (1 << (W - 1 - (col + run))))) run++;
              this.rect(x + col * scale, y + row * scale, run * scale, scale, colour);
              col += run;
            } else col++;
          }
        }
        x += (W + 1) * scale;
      }
      return total;
    },
    /** Width in pixels that textCentred() would draw for this string. */
    textWidth(str, scale = 1) {
      const n = String(str).length;
      return n === 0 ? 0 : n * (W + 1) * scale - scale;
    },
    text(str, x, y, colour, scale = 1) {
      let cx = x;
      for (const ch of String(str).toUpperCase()) {
        const glyph = GLYPHS[ch] || GLYPHS[' '];
        for (let row = 0; row < H; row++) {
          const bits = glyph[row];
          let col = 0;
          while (col < W) {
            if (bits & (1 << (W - 1 - col))) {
              let run = 1;
              while (col + run < W && (bits & (1 << (W - 1 - (col + run))))) run++;
              this.rect(cx + col * scale, y + row * scale, run * scale, scale, colour);
              col += run;
            } else col++;
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
// Palette: a hue per bear group, cycled so neighbours differ
// ---------------------------------------------------------------------------
const GROUP_FILLS = {
  // Bear 1 - blues and greens
  '1': [[198, 227, 244], [196, 230, 201], [186, 213, 240], [214, 232, 197], [203, 220, 245], [188, 226, 214]],
  // Bear 2 - greens and yellows
  '2': [[203, 233, 197], [246, 238, 190], [196, 228, 214], [238, 232, 187], [209, 236, 206], [243, 230, 196]],
  // Both bears - pinks and purples, the "special" slot
  both: [[240, 205, 230], [206, 200, 240], [225, 198, 240], [196, 212, 242], [238, 199, 222], [211, 205, 238]],
};
const BEAR_FILL = [232, 226, 214];
const OBJECT_FILL = [214, 214, 214];
const EMPTY_FILL = [255, 255, 255];
const GRID_LINE = [222, 226, 232];
const TEXT = [40, 40, 40];

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
function renderPNG(result, opts = {}) {
  const tile = opts.tile || 64;
  const pad = opts.pad || 24;
  const { map, assignments } = result;

  const items = [
    ...assignments.map((a) => ({ x: a.spot.x, y: a.spot.y, w: 2, h: 2 })),
    ...map.bears.map((b) => ({ x: b.x, y: b.y, w: b.w || 3, h: b.h || 3 })),
    ...map.fixedObjects.map((o) => ({ x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
  ];
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.h));

  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const width = pad * 2 + cols * tile;
  const height = pad * 2 + rows * tile + 30;

  const c = createCanvas(width, height);
  const px = (x) => pad + (x - minX) * tile;
  // Screen Y grows downward while tile Y grows upward, so flip.
  const py = (y) => pad + (maxY - y) * tile;

  // Grid lines
  for (let i = 0; i <= cols; i++) c.rect(pad + i * tile, pad, 1, rows * tile, GRID_LINE);
  for (let j = 0; j <= rows; j++) c.rect(pad, pad + j * tile, cols * tile, 1, GRID_LINE);

  /** One filled square, drawn as a full cell minus a 2px gutter. */
  const cell = (x, y, fill) => {
    c.rect(px(x) + 2, py(y) + 2, tile - 4, tile - 4, fill);
  };

  /** Slot number on line one, detail line below. */
  const cellText = (x, y, l1, l2, scale) => {
    const cx = px(x) + tile / 2;
    if (l2) {
      c.textCentred(l1, cx, py(y) + tile * 0.38, TEXT, scale);
      c.textCentred(l2, cx, py(y) + tile * 0.68, TEXT, 1);
    } else {
      c.textCentred(l1, cx, py(y) + tile / 2, TEXT, scale);
    }
  };

  // --- obstacles first, so players drawn later sit on top if anything overlaps
  for (const b of map.bears) {
    for (let dx = 0; dx < (b.w || 3); dx++) {
      for (let dy = 0; dy < (b.h || 3); dy++) cell(b.x + dx, b.y + dy, BEAR_FILL);
    }
    c.textCentred(
      (b.name || 'BEAR').replace(/^bear\s*/i, 'BT'),
      px(b.x) + ((b.w || 3) * tile) / 2,
      py(b.y) + ((b.h || 3) * tile) / 2,
      TEXT, 2
    );
  }
  for (const o of map.fixedObjects) {
    for (let dx = 0; dx < (o.w || 2); dx++) {
      for (let dy = 0; dy < (o.h || 2); dy++) cell(o.x + dx, o.y + dy, OBJECT_FILL);
    }
  }

  // --- players: one clean square each, just the name on it
  assignments.forEach((a) => {
    const key = require('./hive').isDual(a.player) ? 'both' : String(a.player.group || '1');
    const fills = GROUP_FILLS[key] || GROUP_FILLS['1'];
    // Vary the hue by position so adjacent squares never merge visually.
    const fill = fills[(a.spot.x + a.spot.y) % fills.length];

    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) cell(a.spot.x + dx, a.spot.y + dy, fill);
    }

    // Name only, centred in the 2x2 block. Short names get full-size glyphs;
    // anything longer is split over two lines so it still fits inside.
    const name = shorten(a.player.name, 16);
    const words = name.split(' ').filter(Boolean);
    const cx = px(a.spot.x) + tile;
    const cy = py(a.spot.y) + tile;
    if (name.length <= 7) {
      c.textCentred(name, cx, cy, TEXT, 2);
    } else if (words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      c.textCentred(words.slice(0, mid).join(' '), cx, cy - 8, TEXT, 1);
      c.textCentred(words.slice(mid).join(' '), cx, cy + 8, TEXT, 1);
    } else {
      c.textCentred(name, cx, cy, TEXT, 1);
    }
  });

  // --- title + legend
  c.text(opts.title || 'Kingshot hive plan', pad, 8, TEXT, 1);
  const ly = height - 20;
  const legend = [['BEAR 1', '1'], ['BEAR 2', '2'], ['BOTH', 'both']];
  let lx = pad;
  for (const [label, key] of legend) {
    c.rect(lx, ly, 12, 12, (GROUP_FILLS[key] || GROUP_FILLS['1'])[0]);
    lx = c.text(label, lx + 18, ly + 3, TEXT, 1) + 20;
  }
  c.rect(lx, ly, 12, 12, OBJECT_FILL);
  lx = c.text('OBJECT', lx + 18, ly + 3, TEXT, 1) + 20;
  c.rect(lx, ly, 12, 12, BEAR_FILL);
  c.text('BEAR TRAP', lx + 18, ly + 3, TEXT, 1);

  const png = c.toPNG();

  // Slot number -> player, so the Discord table can reference the image.
  const slots = assignments.map((a, i) => ({
    slot: i + 1,
    name: a.player.name,
    score: a.player.score,
    group: require('./hive').isDual(a.player) ? 'both' : String(a.player.group || '1'),
    x: a.spot.x,
    y: a.spot.y,
    tiles: Number(a.travel.toFixed(1)),
  }));

  return png;
}

/** Trim a name to fit a cell, keeping the start of it. */
function shorten(name, max) {
  const s = String(name || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '.';
}

/** Plain-text table, for a Discord code block. */
function renderText(result) {
  const require_hive = require('./hive');
  const rows = result.assignments.map((a, i) => [
    String(i + 1),
    a.player.name,
    String(a.player.score >= 1000 ? `${(a.player.score / 1000).toFixed(1)}b` : `${a.player.score}m`),
    require_hive.isDual(a.player) ? 'both' : String(a.player.group || '1'),
    `${a.spot.x},${a.spot.y}`,
    a.travel.toFixed(1),
  ]);
  const head = ['#', 'PLAYER', 'SCORE', 'BEAR', 'SPOT', 'TILES'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join(' ');
  return [`\`\`\``, line(head), widths.map((w) => '-'.repeat(w)).join(' '), ...rows.map(line), '```'].join('\n');
}

module.exports = { renderPNG, renderText, createCanvas, encodePNG, shorten, GROUP_FILLS };
