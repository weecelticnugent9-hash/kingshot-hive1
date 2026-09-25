'use strict';

/**
 * kingshot-hive/overlay.js
 * Draws the stored hive map on top of a screenshot, so you can see at a glance
 * whether data/map.json matches the real map.
 *
 * It never reads the screenshot. It only draws, which is why it cannot
 * misread anything - the image is context, the boxes are your data.
 *
 * Reading images: PNG is decoded natively below. JPEG is detected but needs a
 * decoder that is not available in this runtime, so the caller should tell the
 * user to send a PNG.
 */

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// PNG decode
// ---------------------------------------------------------------------------
function decodePNG(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('Not a PNG file.');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colourType = 0;
  const idat = [];

  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`Only 8-bit PNGs are supported (this one is ${bitDepth}-bit).`);
  if (colourType !== 2 && colourType !== 6 && colourType !== 0) {
    throw new Error('Unsupported PNG colour type. Re-save as a standard RGB or RGBA PNG.');
  }

  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prior = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    raw.copy(line, 0, src, src + stride);
    src += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prior[i];
      const c = i >= channels ? prior[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prior);

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
      else { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = channels === 4 ? line[s + 3] : 255; }
    }
  }

  return { width, height, px: out };
}

/** True when the bytes look like a JPEG rather than a PNG. */
function isJPEG(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

// ---------------------------------------------------------------------------
// Overlay drawing
// ---------------------------------------------------------------------------
const STYLE = {
  bear:   { line: [207, 131, 27], fill: [255, 229, 189, 70] },
  object: { line: [37, 99, 235], fill: [219, 234, 254, 70] },
  blocked:{ line: [220, 38, 38], fill: [254, 226, 226, 70] },
  player: { line: [22, 131, 75], fill: [204, 241, 221, 70] },
  both:   { line: [137, 80, 199], fill: [234, 221, 251, 70] },
};

// Thin 5x7 digits + letters, reusing the same shapes as render.js.
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
  '#': [0b01010,0b11111,0b01010,0b01010,0b11111,0b01010,0b01010],
  '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
};

function drawBox(img, x, y, w, h, style, scale) {
  const { px, width, height } = img;
  const put = (xx, yy, colour, alpha) => {
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) return;
    const i = (yy * width + xx) * 4;
    const a = alpha / 255;
    px[i] = Math.round(px[i] * (1 - a) + colour[0] * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + colour[1] * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + colour[2] * a);
  };

  // translucent fill
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, style.fill, style.fill[3]);
  // border, thicker on small tiles so it stays visible
  const t = Math.max(2, Math.round(scale * 0.08));
  for (let i = 0; i < t; i++) {
    for (let xx = x; xx < x + w; xx++) { put(xx, y + i, style.line, 235); put(xx, y + h - 1 - i, style.line, 235); }
    for (let yy = y; yy < y + h; yy++) { put(x + i, yy, style.line, 235); put(x + w - 1 - i, yy, style.line, 235); }
  }
}

function drawText(img, text, x, y, colour, scale) {
  const { px, width, height } = img;
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const glyph = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(glyph[row] & (1 << (4 - col)))) continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const xx = cx + col * scale + sx, yy = y + row * scale + sy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const i = (yy * width + xx) * 4;
          px[i] = colour[0]; px[i + 1] = colour[1]; px[i + 2] = colour[2];
        }
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

function textWidth(text, scale) { return String(text).length * 6 * scale - scale; }

/** Solid label plate so text stays readable over busy map art. */
function drawPlate(img, text, x, y, colour, scale) {
  const w = textWidth(text, scale) + 8, h = 7 * scale + 8;
  const { px, width, height } = img;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
    const i = (yy * width + xx) * 4;
    px[i] = colour[0]; px[i + 1] = colour[1]; px[i + 2] = colour[2];
    px[i + 3] = 255;
  }
  drawText(img, text, x + 4, y + 4, [255, 255, 255], scale);
}

// ---------------------------------------------------------------------------
// Encode back to PNG
// ---------------------------------------------------------------------------
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
    raw[y * (width * 4 + 1)] = 0;
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
// The overlay
// ---------------------------------------------------------------------------
/**
 * Draw the stored map over a screenshot.
 *
 * @param {Buffer} imageBytes  PNG bytes of the screenshot
 * @param {Object} map         from mapStore.get()
 * @param {Object} anchor      { x, y, px, py, tilePx }
 *        x,y     - the tile coordinate that sits under (px, py) on the image
 *        px,py   - pixel position of that tile's LOWEST-LEFT corner
 *        tilePx  - how many pixels one tile spans
 * @param {Object} opts        { players: [{name, x, y, group}] }
 */
function renderOverlay(imageBytes, map, anchor, opts = {}) {
  if (isJPEG(imageBytes)) {
    throw new Error('That image is a JPEG. Discord converts screenshots to JPEG on upload, so send a PNG file instead (Screenshot then share as file, or re-save as PNG).');
  }

  const img = decodePNG(imageBytes);
  const { tilePx } = anchor;
  if (!tilePx || tilePx < 4) throw new Error('tilePx is too small to draw a usable grid.');

  // Tile -> pixel. The anchor tile's low-left corner is at (px, py).
  const tileToPx = (tx, ty) => ({
    x: anchor.px + (tx - anchor.x) * tilePx,
    y: anchor.py - (ty - anchor.y) * tilePx,
  });

  const drawTileRect = (entry, style, label) => {
    const topLeft = tileToPx(entry.x, entry.y + (entry.h || 2) - 1);
    const w = (entry.w || 2) * tilePx, h = (entry.h || 2) * tilePx;
    drawBox(img, Math.round(topLeft.x), Math.round(topLeft.y), Math.round(w), Math.round(h), style, tilePx);
    if (label) {
      const scale = tilePx >= 22 ? 2 : 1;
      drawPlate(img, label, Math.round(topLeft.x) + 2, Math.round(topLeft.y) + 2, style.line, scale);
    }
  };

  // Players first, so map items draw over them.
  for (const p of opts.players || []) {
    const style = p.group === 'both' ? STYLE.both : STYLE.player;
    drawTileRect({ x: p.x, y: p.y, w: 2, h: 2 }, style, p.name);
  }
  for (const o of map.fixedObjects || []) drawTileRect(o, STYLE.object, o.name);
  for (const b of map.blocked || []) drawTileRect(b, STYLE.blocked, o2(b));
  for (const b of map.bears || []) drawTileRect(b, STYLE.bear, b.name);

  function o2(e) { return e.name; }

  // Legend strip along the top.
  const scale = 2;
  const items = [
    ['BEAR', STYLE.bear], ['OBJECT', STYLE.object], ['BLOCKED', STYLE.blocked],
    ['B1 PLAYER', STYLE.player], ['BOTH', STYLE.both],
  ];
  let lx = 8, ly = 8;
  for (const [label, style] of items) {
    const w = textWidth(label, 1) + 8;
    drawPlate(img, label, lx, ly, style.line, 1);
    lx += w + 6;
  }

  // Anchor marker, so you can confirm where the calibration landed.
  const a = tileToPx(anchor.x, anchor.y);
  drawBox(img, Math.round(a.x), Math.round(a.y - tilePx), Math.round(tilePx), Math.round(tilePx), STYLE.blocked, tilePx / 2);
  drawPlate(img, `ANCHOR ${anchor.x},${anchor.y}`, Math.round(a.x) + tilePx + 4, Math.round(a.y - tilePx), STYLE.blocked.line, 1);

  return {
    png: encodePNG(img.width, img.height, img.px),
    drawn: {
      bears: (map.bears || []).length,
      objects: (map.fixedObjects || []).length,
      blocked: (map.blocked || []).length,
      players: (opts.players || []).length,
    },
    imageSize: { width: img.width, height: img.height },
  };
}

module.exports = { renderOverlay, decodePNG, encodePNG, isJPEG, STYLE };
