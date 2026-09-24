'use strict';

/**
 * kingshot-hive/map.js
 * The hive map: bear traps, unmovable objects, the search area, and the
 * resolver that turns obstacle clues into tile coordinates.
 *
 * This file is the ONLY one you edit when the hive area changes.
 * hive.js reads from it, so nothing else needs touching.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE MODEL - read this once, it makes everything else obvious.
 * ---------------------------------------------------------------------------
 *
 *   A coordinate is an integer tile.
 *
 *   Player cities and unmovable objects are 2 x 2 squares.
 *   Bear traps are 3 x 3 squares.
 *
 *   Every object is stored by its LOWEST-X, LOWEST-Y tile ("x", "y").
 *   For a bear, that is the corner diagonally opposite its top-right corner,
 *   so a bear listed in-game as "X481 Y586 to X483 Y588" is written
 *   { x: 481, y: 586, w: 3, h: 3 }.
 *
 *   A 2 x 2 object at (479, 582) occupies:
 *     (479,583) (480,583)
 *     (479,582) (480,582)
 *
 * ---------------------------------------------------------------------------
 * BEAR CENTRES
 * ---------------------------------------------------------------------------
 *   Bear 1 centre: X482, Y587   -> footprint x=481 y=586 w=3 h=3
 *   Bear 2 centre: X473, Y589   -> footprint x=472 y=588 w=3 h=3
 *
 * ---------------------------------------------------------------------------
 * YOUR FOUR UNMOVABLE OBJECTS
 * ---------------------------------------------------------------------------
 *   Object 1: X479, Y582
 *   Object 2: X485, Y581
 *   Object 3: X472, Y586     <- the one under Bear 2
 *   Object 4: X476, Y594
 */

// ---------------------------------------------------------------------------
// 1. The map
// ---------------------------------------------------------------------------

const MAP = {
  // Bear traps. "centre" is for distance maths; x/y/w/h is the blocked area.
  bears: [
    { name: 'Bear 1', x: 481, y: 586, w: 3, h: 3, centreX: 482, centreY: 587 },
    { name: 'Bear 2', x: 472, y: 588, w: 3, h: 3, centreX: 473, centreY: 589 },
  ],

  // Unmovable objects. Add, remove or renumber freely - the planner never
  // assumes a count, it just walks this list.
  //
  // To ADD one:   append { name: 'Object 5', x: 470, y: 580, w: 2, h: 2 },
  // To MOVE one:  change its x and y.
  // To REMOVE one: delete its line.
  //
  // Use x = lowest-X tile, y = lowest-Y tile.
  fixedObjects: [
    { name: 'Object 1', x: 479, y: 582, w: 2, h: 2 },
    { name: 'Object 2', x: 485, y: 581, w: 2, h: 2 },
    { name: 'Object 3', x: 472, y: 586, w: 2, h: 2 },   // under Bear 2
    { name: 'Object 4', x: 476, y: 594, w: 2, h: 2 },
  ],

  // The rectangle the planner may search for free city spots.
  // Make it bigger than the hive you want; the solver only fills outward
  // as far as it needs to, so spare room here costs nothing.
  search: { minX: 466, maxX: 492, minY: 577, maxY: 600 },

  // Tiles that must never be used, even if geometrically free.
  // Use this for the alliance flag, resource tiles, a neighbour you cannot
  // evict, or a chunk of map you simply do not want players sitting in.
  //
  //   blocked: [
  //     { name: 'Alliance flag', x: 470, y: 580, w: 2, h: 2 },
  //     { name: 'Keep clear',    x: 486, y: 592, w: 3, h: 2 },
  //   ],
  blocked: [],

  // Hard exclusion: no player may be placed at a centre further than this
  // from their bear. null = no limit. Useful once you know real march times.
  maxDistanceTiles: null,
};

// ---------------------------------------------------------------------------
// 2. Obstacle resolver - the part you asked for
// ---------------------------------------------------------------------------
//
// The game shows you a bear as a ring of coordinates around it, and objects by
// a single displayed tile. This turns either clue into a real footprint, so you
// never have to sit there subtracting 1 in your head.
//
//   bearFromRing('Bear 1', 457, 571, 461, 575)
//     -> a 3 x 3 bear with its footprint centred inside that ring
//
//   objectFromCoordinate('Object 5', 470, 580)
//     -> a 2 x 2 object anchored at the lowest-X, lowest-Y tile
//
//   bearFromCentre('Bear 3', 500, 500)
//     -> a 3 x 3 bear centred exactly there
//
// The results are plain map entries - paste them into the lists above.

/** A 3 x 3 bear given the corners of the ring shown around it in-game. */
function bearFromRing(name, minX, minY, maxX, maxY) {
  const centreX = Math.round((minX + maxX) / 2);
  const centreY = Math.round((minY + maxY) / 2);
  return bearFromCentre(name, centreX, centreY);
}

/** A 3 x 3 bear given its centre coordinate. */
function bearFromCentre(name, centreX, centreY) {
  return { name, x: centreX - 1, y: centreY - 1, w: 3, h: 3, centreX, centreY };
}

/**
 * A 2 x 2 object given any single tile it sits on.
 * @param {string} name
 * @param {number} tileX   a tile the object covers
 * @param {number} tileY   a tile the object covers
 * @param {'low'|'high'} corner
 *        'low'  (default) -> the coordinate you gave is the lowest-X, lowest-Y tile
 *        'high'           -> the coordinate you gave is the highest-X, highest-Y tile
 *        If the game shows objects a different way, pass the matching corner.
 */
function objectFromCoordinate(name, tileX, tileY, corner = 'low') {
  const x = corner === 'high' ? tileX - 1 : tileX;
  const y = corner === 'high' ? tileY - 1 : tileY;
  return { name, x, y, w: 2, h: 2 };
}

/** Same as above but for the top-right corner the game shows for bears. */
function objectFromTopRight(name, topRightX, topRightY) {
  return objectFromCoordinate(name, topRightX, topRightY, 'high');
}

// ---------------------------------------------------------------------------
// 3. Helpers used by the planner
// ---------------------------------------------------------------------------

/** Every blocked rectangle on the map, in one flat list. */
function blockers(map = MAP) {
  return [
    ...map.bears.map((b) => ({ name: b.name, kind: 'bear', x: b.x, y: b.y, w: b.w || 3, h: b.h || 3 })),
    ...map.fixedObjects.map((o) => ({ name: o.name, kind: 'object', x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
    ...(map.blocked || []).map((o) => ({ name: o.name, kind: 'blocked', x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
  ];
}

/** Every tile covered by an entry, as "x,y" strings - handy for a quick check. */
function tilesOf(entry) {
  const out = [];
  for (let dx = 0; dx < (entry.w || 2); dx++) {
    for (let dy = 0; dy < (entry.h || 2); dy++) {
      out.push(`${entry.x + dx},${entry.y + dy}`);
    }
  }
  return out;
}

/** Lint the map: overlaps, out-of-bounds objects, duplicate names. */
function lintMap(map = MAP) {
  const problems = [];
  const list = blockers(map);

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        problems.push(`${a.name} overlaps ${b.name}`);
      }
    }
  }

  const seen = new Set();
  for (const entry of list) {
    if (seen.has(entry.name)) problems.push(`duplicate name: ${entry.name}`);
    seen.add(entry.name);
  }

  const { minX, maxX, minY, maxY } = map.search;
  for (const entry of list) {
    if (entry.x < minX || entry.x + entry.w - 1 > maxX || entry.y < minY || entry.y + entry.h - 1 > maxY) {
      problems.push(`${entry.name} sits outside the search area`);
    }
  }

  const freeTiles = freeSpotCount(map);
  if (freeTiles === 0) problems.push('no free city spot fits in the search area');
  return { ok: problems.length === 0, problems, freeSpots: freeTiles };
}

/** How many 2 x 2 city slots fit in the search area right now. */
function freeSpotCount(map = MAP) {
  const list = blockers(map);
  const { minX, maxX, minY, maxY } = map.search;
  let count = 0;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const spot = { x, y, w: 2, h: 2 };
      const clash = list.some((o) => spot.x < o.x + o.w && spot.x + spot.w > o.x && spot.y < o.y + o.h && spot.y + spot.h > o.y);
      if (!clash) count++;
    }
  }
  return count;
}

/** A human-readable dump of the map, for the /hive map command. */
function describeMap(map = MAP) {
  const lines = ['**Bear traps**'];
  for (const b of map.bears) {
    lines.push(`\`${b.name.padEnd(8)}\` centre ${b.centreX},${b.centreY}  covers ${b.x}-${b.x + b.w - 1} x ${b.y}-${b.y + b.h - 1}`);
  }
  lines.push('', '**Unmovable objects**');
  if (!map.fixedObjects.length) lines.push('none configured');
  for (const o of map.fixedObjects) {
    lines.push(`\`${o.name.padEnd(8)}\` ${o.x},${o.y}  covers ${o.x}-${o.x + o.w - 1} x ${o.y}-${o.y + o.h - 1}`);
  }
  if (map.blocked && map.blocked.length) {
    lines.push('', '**Blocked areas**');
    for (const o of map.blocked) lines.push(`\`${o.name.padEnd(8)}\` ${o.x},${o.y}`);
  }
  const lint = lintMap(map);
  lines.push('', `**Search area** ${map.search.minX}-${map.search.maxX} x ${map.search.minY}-${map.search.maxY}`, `**Free 2x2 city spots** ${lint.freeSpots}`);
  if (!lint.ok) {
    lines.push('', '**Problems**');
    lint.problems.forEach((p) => lines.push(`- ${p}`));
  }
  return lines.join('\n');
}

module.exports = {
  MAP,
  bearFromRing,
  bearFromCentre,
  objectFromCoordinate,
  objectFromTopRight,
  blockers,
  tilesOf,
  lintMap,
  freeSpotCount,
  describeMap,
};
