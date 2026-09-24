'use strict';

/**
 * kingshot-hive/mapstore.js
 * Editable map storage. The map lives in data/map.json, so Discord commands
 * can add, move and remove objects without touching code or redeploying.
 *
 * On first run it seeds itself from map.js (the hand-written defaults), then
 * never reads map.js again - the JSON file is the source of truth.
 *
 * Shape of data/map.json:
 * {
 *   "bears": [
 *     { "name": "Bear 1", "x": 481, "y": 586, "w": 3, "h": 3, "centreX": 482, "centreY": 587 }
 *   ],
 *   "fixedObjects": [
 *     { "name": "Object 1", "x": 479, "y": 582, "w": 2, "h": 2 }
 *   ],
 *   "blocked": [],
 *   "search": { "minX": 466, "maxX": 492, "minY": 577, "maxY": 600 },
 *   "updatedAt": "..."
 * }
 *
 * IMPORTANT: x/y is always the LOWEST-X, LOWEST-Y tile of the footprint.
 *           w/h is the size in tiles (2x2 for cities and objects, 3x3 for bears).
 */

const fs = require('fs');
const path = require('path');
const { MAP: DEFAULT_MAP, lintMap, blockers, freeSpotCount, describeMap, tilesOf } = require('./map');

// A nickname for every category, so /add object and /add blockage both work.
const CATEGORY_ALIASES = {
  object: 'fixedObjects',
  objects: 'fixedObjects',
  unmovable: 'fixedObjects',
  fixed: 'fixedObjects',
  blockage: 'blocked',
  blocked: 'blocked',
  obstacle: 'blocked',
  keepclear: 'blocked',
  bear: 'bears',
  bears: 'bears',
};

const SINGULAR = { fixedObjects: 'object', blocked: 'blockage', bears: 'bear' };

function categoryKey(input) {
  const key = CATEGORY_ALIASES[String(input || '').toLowerCase().replace(/[\s_-]+/g, '')];
  return key || null;
}

/** Parse "400,400", "X400 Y400", "400 400" or "x=400 y=400" into {x,y}. */
function parseCoordinate(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[xX]\s*=?/g, ' ').replace(/[yY]\s*=?/g, ' ').replace(/[,:]/g, ' ');
  const nums = cleaned.match(/-?\d+/g);
  if (!nums || nums.length < 2) return null;
  return { x: Number(nums[0]), y: Number(nums[1]) };
}

/** Parse "2x2", "3x3", "2 x 2" into {w,h}. */
function parseSize(text, fallback = { w: 2, h: 2 }) {
  if (!text) return fallback;
  const m = String(text).match(/(\d+)\s*[xX*]\s*(\d+)/);
  if (!m) return fallback;
  return { w: Math.max(1, Number(m[1])), h: Math.max(1, Number(m[2])) };
}

function createMapStore(filePath) {
  const file = path.resolve(filePath);
  let data;

  function seed() {
    // Deep copy of the hand-written defaults in map.js.
    return JSON.parse(JSON.stringify({
      bears: DEFAULT_MAP.bears,
      fixedObjects: DEFAULT_MAP.fixedObjects,
      blocked: DEFAULT_MAP.blocked || [],
      search: DEFAULT_MAP.search,
      updatedAt: new Date().toISOString(),
    }));
  }

  function load() {
    if (!fs.existsSync(file)) {
      data = seed();
      save();
      return data;
    }
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`mapstore: ${file} is not valid JSON (${err.message}). Delete it to reseed from map.js.`);
    }
    data.bears = data.bears || [];
    data.fixedObjects = data.fixedObjects || [];
    data.blocked = data.blocked || [];
    data.search = data.search || DEFAULT_MAP.search;
    return data;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    data.updatedAt = new Date().toISOString();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  /** The map object in the shape hive.js expects. Bears are normalised to x/y. */
  function get() {
    return {
      bears: data.bears.map((b) => ({
        name: b.name,
        x: b.x != null ? b.x : b.anchorX - (b.w || 3) + 1,
        y: b.y != null ? b.y : b.anchorY - (b.h || 3) + 1,
        w: b.w || 3,
        h: b.h || 3,
        centreX: b.centreX != null ? b.centreX : b.x + 1,
        centreY: b.centreY != null ? b.centreY : b.y + 1,
      })),
      fixedObjects: data.fixedObjects.map((o) => ({ ...o, w: o.w || 2, h: o.h || 2 })),
      blocked: data.blocked.map((o) => ({ ...o, w: o.w || 2, h: o.h || 2 })),
      search: { ...data.search },
    };
  }

  /** Next free auto-name in a category: "Object 5", "Blockage 2". */
  function nextName(category) {
    const taken = new Set((data[category] || []).map((e) => String(e.name).toLowerCase()));
    let n = 1;
    while (taken.has(`${SINGULAR[category]} ${n}`.toLowerCase())) n++;
    return `${SINGULAR[category].charAt(0).toUpperCase()}${SINGULAR[category].slice(1)} ${n}`;
  }

  /** Save a hand-written map.js edit into the JSON store. */
  function reseedFromDefaults() {
    data = seed();
    save();
    return data;
  }

  /**
   * Add or overwrite an entry.
   * opts: { category, name?, x, y, w?, h?, size?, overwrite?, centreX?, centreY? }
   * Matching is by name (case-insensitive) inside the category.
   */
  function put(opts) {
    const category = categoryKey(opts.category);
    if (!category) throw new Error(`Unknown category "${opts.category}". Use object, blockage or bear.`);
    if (category === 'bears' && !opts.overwrite) {
      // Bears are few and load-bearing; require the name to already exist.
      const exists = data.bears.some((b) => String(b.name).toLowerCase() === String(opts.name).toLowerCase());
      if (!exists) throw new Error(`Bear "${opts.name}" does not exist. Add it in map.js, or pass overwrite to create it.`);
    }

    const coord = typeof opts.x === 'number' ? { x: opts.x, y: opts.y } : parseCoordinate(opts.x);
    if (!coord) throw new Error(`Could not read coordinates from "${opts.x}". Try "X400 Y400".`);

    const size = opts.size ? parseSize(opts.size) : { w: opts.w || 2, h: opts.h || 2 };
    const defaultSize = category === 'bears' ? { w: 3, h: 3 } : { w: 2, h: 2 };
    const finalSize = opts.size ? size : (opts.w || opts.h ? size : defaultSize);

    const name = (opts.name && String(opts.name).trim()) || nextName(category);
    const key = name.toLowerCase();
    const entry = { name, x: coord.x, y: coord.y, w: finalSize.w, h: finalSize.h };
    if (category === 'bears') {
      entry.centreX = opts.centreX != null ? opts.centreX : coord.x + Math.floor(finalSize.w / 2);
      entry.centreY = opts.centreY != null ? opts.centreY : coord.y + Math.floor(finalSize.h / 2);
    }

    const list = data[category];
    const idx = list.findIndex((e) => String(e.name).toLowerCase() === key);
    if (idx >= 0 && !opts.overwrite && !opts.allowUpdate) {
      throw new Error(`**${list[idx].name}** already exists at ${list[idx].x},${list[idx].y}. Pass overwrite to move it.`);
    }
    if (idx >= 0) list[idx] = entry; else list.push(entry);

    save();
    return { action: idx >= 0 ? 'updated' : 'added', category, entry, map: get() };
  }

  /** Remove by name across a category, or by coordinates if no name given. */
  function remove(opts) {
    const category = categoryKey(opts.category);
    if (!category) throw new Error(`Unknown category "${opts.category}". Use object, blockage or bear.`);
    const list = data[category];

    let idx = -1;
    if (opts.name) {
      const key = String(opts.name).trim().toLowerCase();
      idx = list.findIndex((e) => String(e.name).toLowerCase() === key);
    } else if (opts.x != null) {
      const coord = typeof opts.x === 'number' ? { x: opts.x, y: opts.y } : parseCoordinate(opts.x);
      if (!coord) throw new Error(`Could not read coordinates from "${opts.x}".`);
      idx = list.findIndex((e) => e.x === coord.x && e.y === coord.y);
    } else {
      throw new Error('Give a name or coordinates to remove.');
    }

    if (idx < 0) throw new Error('Nothing matched, so nothing was removed.');
    const [removed] = list.splice(idx, 1);
    save();
    return { removed, category, map: get() };
  }

  /** Set the search rectangle the planner may use. */
  function setSearch(corner1, corner2) {
    const a = typeof corner1 === 'object' ? corner1 : parseCoordinate(corner1);
    const b = typeof corner2 === 'object' ? corner2 : parseCoordinate(corner2);
    if (!a || !b) throw new Error('Give two corners, e.g. from:X466 Y577 to:X492 Y600');
    data.search = {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
    save();
    return data.search;
  }

  /** Lint the live map and report free 2x2 city slots. */
  function check() {
    const map = get();
    const lint = lintMap(map);
    return { ...lint, map, entries: blockers(map).length, freeSpotsDetailed: freeSpotCount(map) };
  }

  /** Human-readable listing for Discord. */
  function describe() {
    return describeMap(get());
  }

  /** Which tiles an entry covers, as a list - for a confirmation message. */
  function coverage(name) {
    const map = get();
    const entry = [...map.bears, ...map.fixedObjects, ...map.blocked]
      .find((e) => String(e.name).toLowerCase() === String(name).toLowerCase());
    return entry ? { entry, tiles: tilesOf(entry) } : null;
  }

  function list(category) {
    const key = category ? categoryKey(category) : null;
    const out = {};
    for (const c of ['bears', 'fixedObjects', 'blocked']) {
      if (key && key !== c) continue;
      out[c] = (data[c] || []).map((e) => ({ ...e }));
    }
    return out;
  }

  load();
  return {
    get, put, remove, setSearch, check, describe, coverage, list,
    reseedFromDefaults, nextName, save,
    get raw() { return data; },
  };
}

module.exports = { createMapStore, parseCoordinate, parseSize, categoryKey };
