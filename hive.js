'use strict';

/**
 * kingshot-hive/hive.js
 *
 * Placement engine for a Kingshot alliance hive around two bear traps.
 * Pure logic, zero dependencies: no Discord, no filesystem, no network.
 * Drop this next to your bot and require() it.
 *
 * Coordinate conventions (CHANGE THESE IF YOUR GAME DIFFERS):
 *   - A coordinate is an integer tile.
 *   - A player city or unmovable object occupies a 2 x 2 square of tiles.
 *   - Every placed item is recorded by its lowest-X, lowest-Y tile.
 *   - A bear trap occupies a 3 x 3 square, recorded as its top-right corner:
 *     for Bear 1 centre (482, 587) the footprint is X481-483, Y586-588.
 *   - distance() uses tile distance. If you later have real march times,
 *     replace distance() with a lookup and everything else still works.
 */

// ---------------------------------------------------------------------------
// 1. MAP CONFIGURATION - edit this when your hive area changes
// ---------------------------------------------------------------------------

const MAP = {
  // "anchor" is the TOP-RIGHT corner of the 3 x 3 trap footprint.
  bears: [
    { name: 'Bear 1', anchorX: 481, anchorY: 586, w: 3, h: 3, centreX: 482, centreY: 587 },
    { name: 'Bear 2', anchorX: 472, anchorY: 588, w: 3, h: 3, centreX: 473, centreY: 589 },
  ],

  // Unmovable objects: lowest-X, lowest-Y tile, 2 x 2 each.
  fixedObjects: [
    { name: 'Object 1', x: 479, y: 582, w: 2, h: 2 },
    { name: 'Object 2', x: 485, y: 581, w: 2, h: 2 },
    { name: 'Object 3', x: 472, y: 586, w: 2, h: 2 },
    { name: 'Object 4', x: 476, y: 594, w: 2, h: 2 },
  ],

  // The rectangle the planner is allowed to search for free spots.
  // Keep it generously larger than the hive you actually want: the
  // solver fills outward from the bears only as far as it must.
  search: { minX: 467, maxX: 490, minY: 578, maxY: 599 },

  // Optional: spots that must never be used, even if geometrically free.
  blocked: [
    // { name: 'Alliance flag', x: 470, y: 580, w: 2, h: 2 },
  ],
};

// ---------------------------------------------------------------------------
// 2. PLACEMENT POLICY - the numbers that decide who gets the good spots
// ---------------------------------------------------------------------------

const POLICY = {
  // Priors used when a player has no history yet. Scale: 0..1.
  defaultActivity: 0.5,

  // Weight of score vs. attendance in a player's priority (must sum to 1).
  scoreWeight: 0.6,
  activityWeight: 0.4,

  // Score is ranked by percentile rather than raw value, so one 2b player
  // does not flatten everyone else to zero. Set false for raw normalisation.
  usePercentileForScore: true,

  // Score (in millions) that maps to a percentile of 1.0 when not using
  // percentiles. Ignored when usePercentileForScore is true.
  scoreCeiling: 2000,

  // How strongly priority pulls a player inward. 0 = ignore priority,
  // higher = high scorers dominate the inner rings. 4 is a good start.
  priorityInfluence: 4,

  // Cost of moving an existing occupant. Prevents a roster update from
  // reshuffling the entire hive for a 10m score change. In tile units.
  movePenaltyPerTile: 1.5,

  // A dual-bear player's cost = balance of distance to both bears, plus
  // a penalty on whichever bear is farther away. 0.5/0.5 favours true
  // midpoints; raise farthestWeight to favour "no bear is far".
  dualBalanceWeight: 0.5,
  dualFarthestWeight: 0.5,

  // Hard cap: never place a player further than this from their bear.
  // null disables the cap.
  maxDistanceTiles: null,

  // Keep the current occupant in place if the cost improvement is smaller
  // than this fraction - stops noisy churn. 0 disables.
  stickyThreshold: 0.02,
};

// ---------------------------------------------------------------------------
// 3. Geometry helpers
// ---------------------------------------------------------------------------

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectsTouchOrOverlap(a, b) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

function centreOf(bear) {
  return { x: bear.centreX != null ? bear.centreX : bear.anchorX + 1, y: bear.centreY != null ? bear.centreY : bear.anchorY + 1 };
}

/** Tile distance from a 2x2 city's centre to a bear's centre. */
function distance(city, bear) {
  const c = centreOf(bear);
  return Math.hypot(city.x + 0.5 - c.x, city.y + 0.5 - c.y);
}

function groupOf(player) {
  return player.group || player.bearGroup || '1';
}

function isDual(player) {
  const g = String(groupOf(player)).toLowerCase();
  return g === 'both' || g === '1&2' || g === '12' || g === 'all';
}

// ---------------------------------------------------------------------------
// 4. Priority: score percentile blended with attendance
// ---------------------------------------------------------------------------

function percentiles(values) {
  // Rank-based percentile, ties share the average rank.
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const first = sorted.indexOf(v);
    const last = sorted.lastIndexOf(v);
    const midRank = (first + last) / 2;
    return sorted.length === 1 ? 1 : midRank / (sorted.length - 1);
  });
}

/**
 * Attach a priority (0..1) to every player.
 * players: [{ name, score, group?, activity?, bear1?, bear2?, locked?, x?, y? }]
 *   score    - bear score in millions
 *   activity - 0..1 recent attendance. Optional; defaults to POLICY.defaultActivity.
 *   bear1/bear2 - optional separate 0..1 attendance per bear. When present for
 *                 a dual-bear player the two are averaged, so missing one bear
 *                 does not read as absence overall.
 *   locked   - true keeps the player in their existing x/y if one is set.
 */
function rankPlayers(players, policy = POLICY) {
  const clean = players.map((p) => ({ ...p, name: String(p.name).trim(), score: Number(p.score) || 0 }));

  const scores = clean.map((p) => p.score);
  const scorePct = policy.usePercentileForScore
    ? percentiles(scores)
    : scores.map((s) => Math.min(1, s / policy.scoreCeiling));

  clean.forEach((p, i) => {
    const b1 = typeof p.bear1 === 'number' ? p.bear1 : null;
    const b2 = typeof p.bear2 === 'number' ? p.bear2 : null;
    let activity = policy.defaultActivity;

    if (isDual(p) && b1 != null && b2 != null) {
      activity = (b1 + b2) / 2;           // dual players: average their two bears
    } else if (isDual(p) && (b1 != null || b2 != null)) {
      activity = b1 != null ? b1 : b2;
    } else if (b1 != null || b2 != null) {
      const own = String(groupOf(p)) === '2' ? b2 : b1;
      activity = own != null ? own : b1 != null ? b1 : b2;
    } else if (typeof p.activity === 'number') {
      activity = p.activity;
    }

    p.activity = Math.max(0, Math.min(1, activity));
    p.scorePercentile = scorePct[i];
    p.priority =
      policy.scoreWeight * scorePct[i] + policy.activityWeight * p.activity;
  });

  return clean.sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// 5. Cost model
// ---------------------------------------------------------------------------

function travelCost(player, spot, map, policy = POLICY) {
  const [bear1, bear2] = map.bears;
  const d1 = distance(spot, bear1);
  const d2 = distance(spot, bear2);

  if (isDual(player)) {
    const balance = (d1 + d2) / 2;
    const farthest = Math.max(d1, d2);
    return policy.dualBalanceWeight * balance + policy.dualFarthestWeight * farthest;
  }
  return String(groupOf(player)) === '2' ? d2 : d1;
}

function placementCost(player, spot, map, policy = POLICY) {
  const travel = travelCost(player, spot, map, policy);
  // Priority scales the travel cost: priority 1 -> (1 + influence)x
  const weighted = (1 + policy.priorityInfluence * player.priority) * travel;

  let move = 0;
  if (typeof player.x === 'number' && typeof player.y === 'number') {
    const moved = Math.abs(player.x - spot.x) + Math.abs(player.y - spot.y);
    // A locked player who cannot stay put is disqualified outright.
    if (player.locked && moved > 0) return { cost: Infinity, travel, move: moved, illegal: 'locked' };
    move = policy.movePenaltyPerTile * moved;
  }

  if (policy.maxDistanceTiles != null && travel > policy.maxDistanceTiles) {
    return { cost: Infinity, travel, move, illegal: 'maxDistance' };
  }
  return { cost: weighted + move, travel, move, illegal: null };
}

// ---------------------------------------------------------------------------
// 6. Candidate spots
// ---------------------------------------------------------------------------

function candidates(map) {
  const blockers = [
    ...map.bears.map((b) => ({ x: b.anchorX, y: b.anchorY, w: b.w || 3, h: b.h || 3 })),
    ...map.fixedObjects.map((o) => ({ x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
    ...(map.blocked || []).map((o) => ({ x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
  ];

  const spots = [];
  const { minX, maxX, minY, maxY } = map.search;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const spot = { x, y, w: 2, h: 2 };
      if (blockers.some((o) => rectsOverlap(spot, o))) continue;
      spots.push(spot);
    }
  }
  return spots;
}

// ---------------------------------------------------------------------------
// 7. Assignment - greedy, then repair passes
// ---------------------------------------------------------------------------
//
// Why not the Hungarian algorithm: available spots (~400) vastly outnumber
// players (~25), so an exact auction is unnecessary and the matrix would be
// mostly Infinity. Greedy-by-global-lowest-cost, then a swap-repair pass,
// lands within a tile or two of optimal here and runs in milliseconds,
// which matters because /hive plan should answer instantly.

function assign(ranked, spots, map, policy = POLICY) {
  const remaining = spots.map((s) => ({ ...s }));
  const assigned = [];

  // Every (player, spot) pair, sorted by cost - the global-greedy order.
  const pairs = [];
  ranked.forEach((p, pi) => {
    spots.forEach((s, si) => {
      const r = placementCost(p, s, map, policy);
      if (Number.isFinite(r.cost)) pairs.push({ pi, si, cost: r.cost, travel: r.travel });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);

  const takenPlayer = new Set();
  const takenSpot = new Set();
  for (const pair of pairs) {
    if (takenPlayer.has(pair.pi) || takenSpot.has(pair.si)) continue;
    takenPlayer.add(pair.pi);
    takenSpot.add(pair.si);
    assigned.push({ index: pair.pi, player: ranked[pair.pi], spot: spots[pair.si], travel: pair.travel });
  }

  // Repair: try pairwise player swaps and single-player relocations that
  // reduce total cost. A handful of passes is plenty at this size.
  const costOf = (p, spot) => placementCost(p, spot, map, policy).cost;
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < assigned.length; i++) {
      for (let j = i + 1; j < assigned.length; j++) {
        const a = assigned[i], b = assigned[j];
        if (a.player.locked || b.player.locked) continue;
        const now = costOf(a.player, a.spot) + costOf(b.player, b.spot);
        const swapped = costOf(a.player, b.spot) + costOf(b.player, a.spot);
        if (swapped < now - 1e-9) {
          const s = a.spot; a.spot = b.spot; b.spot = s;
          a.travel = travelCost(a.player, a.spot, map, policy);
          b.travel = travelCost(b.player, b.spot, map, policy);
          improved = true;
        }
      }
    }
    // Relocate a player into a still-free spot if that is cheaper.
    const free = spots.filter((s) => !assigned.some((a) => a.spot.x === s.x && a.spot.y === s.y));
    for (const a of assigned) {
      if (a.player.locked) continue;
      const now = costOf(a.player, a.spot);
      let best = null;
      for (const s of free) {
        const c = costOf(a.player, s);
        if (c < now - 1e-9 && (!best || c < best.c)) best = { s, c };
      }
      if (best) {
        a.spot = best.s; a.travel = travelCost(a.player, a.spot, map, policy);
        free.splice(free.findIndex((f) => f.x === best.s.x && f.y === best.s.y), 1);
        improved = true;
      }
    }
    if (!improved) break;
  }

  return assigned;
}

// ---------------------------------------------------------------------------
// 8. Validation - hard rules, checked before anything is published
// ---------------------------------------------------------------------------

function validate(assigned, map) {
  const errors = [];
  const warnings = [];
  const items = [
    ...assigned.map((a) => ({ kind: 'player', name: a.player.name, x: a.spot.x, y: a.spot.y, w: 2, h: 2 })),
    ...map.bears.map((b) => ({ kind: 'bear', name: b.name, x: b.anchorX, y: b.anchorY, w: b.w || 3, h: b.h || 3 })),
    ...map.fixedObjects.map((o) => ({ kind: 'object', name: o.name, x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
    ...(map.blocked || []).map((o) => ({ kind: 'blocked', name: o.name, x: o.x, y: o.y, w: o.w || 2, h: o.h || 2 })),
  ];

  // 1. No two things may occupy the same tile.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (rectsOverlap(items[i], items[j])) {
        errors.push(`${items[i].name} overlaps ${items[j].name} at ${items[j].x},${items[j].y}`);
      }
    }
  }

  // 2. Nothing may sit outside the map rectangle.
  const { minX, maxX, minY, maxY } = map.search;
  for (const it of assigned) {
    if (it.spot.x < minX || it.spot.x + 1 > maxX || it.spot.y < minY || it.spot.y + 1 > maxY) {
      errors.push(`${it.player.name} is outside the hive area`);
    }
  }

  // 3. A player should not straddle both bears - they should be one side or central.
  for (const a of assigned) {
    const [b1, b2] = map.bears;
    if (!isDual(a.player) && rectsTouchOrOverlap(a.spot, { x: b1.anchorX, y: b1.anchorY, w: b1.w || 3, h: b1.h || 3 })) {
      warnings.push(`${a.player.name} is directly against ${b1.name}`);
    }
  }

  // 4. Flag a hive that has stretched unusually far.
  const maxTravel = assigned.reduce((m, a) => Math.max(m, a.travel), 0);
  if (maxTravel > 15) warnings.push(`Outermost player is ${maxTravel.toFixed(1)} tiles from their bear - hive is spread out`);

  return { ok: errors.length === 0, errors, warnings, maxTravel };
}

// ---------------------------------------------------------------------------
// 9. Public API
// ---------------------------------------------------------------------------

/**
 * Build a full hive plan.
 * @param {Array} players  roster, see rankPlayers() for the shape
 * @param {Object} opts    { map, policy }
 * @returns {{ assignments, ranked, warnings, errors, map, policy }}
 */
function planHive(players, opts = {}) {
  const map = opts.map || MAP;
  const policy = { ...POLICY, ...(opts.policy || {}) };

  if (!players || !players.length) throw new Error('planHive: roster is empty');

  const ranked = rankPlayers(players, policy);
  const spots = candidates(map);
  if (spots.length < ranked.length) {
    throw new Error(`planHive: only ${spots.length} free spots for ${ranked.length} players - widen map.search`);
  }

  const assigned = assign(ranked, spots, map, policy);
  const check = validate(assigned, map);

  // Order the output for humans, not for the solver.
  const ordered = [...assigned].sort((a, b) => {
    const da = isDual(a.player) !== isDual(b.player) ? (isDual(a.player) ? -1 : 1) : 0;
    return da || a.travel - b.travel;
  });

  return { assignments: ordered, ranked, warnings: check.warnings, errors: check.errors, ok: check.ok, map, policy };
}

/** Human-readable lines for a Discord message. */
function formatPlan(result) {
  const lines = [];
  const g = { Both: [], 1: [], 2: [] };
  for (const a of result.assignments) {
    const key = isDual(a.player) ? 'Both' : String(groupOf(a.player));
    g[key].push(a);
  }
  const section = (title, rows, bearLabel) => {
    if (!rows.length) return;
    lines.push(`**${title}**`);
    for (const a of rows) {
      lines.push(
        `\`${String(a.player.name).padEnd(12)}\` ${String(a.player.score + 'm').padStart(6)}  ` +
          `spot **${a.spot.x}, ${a.spot.y}**  ~${a.travel.toFixed(1)} tiles to ${bearLabel(a)}`
      );
    }
    lines.push('');
  };
  const [b1, b2] = result.map.bears;
  section('Both bears (priority order)', g.Both, (a) => `${b1.name}/${b2.name}`);
  section(`${b1.name} players`, g['1'], () => b1.name);
  section(`${b2.name} players`, g['2'], () => b2.name);
  if (result.warnings.length) {
    lines.push('**Warnings**');
    result.warnings.forEach((w) => lines.push(`- ${w}`));
  }
  return lines.join('\n');
}

/** CSV export, same shape as the file in this chat. */
function toCSV(result) {
  const rows = [['Player', 'Score (millions)', 'Bear group', 'Anchor X', 'Anchor Y', 'Tiles to bear', 'Priority']];
  for (const a of result.assignments) {
    rows.push([
      a.player.name,
      a.player.score,
      isDual(a.player) ? 'Both' : String(groupOf(a.player)),
      a.spot.x,
      a.spot.y,
      a.travel.toFixed(2),
      a.player.priority.toFixed(3),
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

/** Map JSON for a preview renderer (or another service). */
function toMapJSON(result) {
  return {
    generatedAt: new Date().toISOString(),
    bears: result.map.bears,
    fixedObjects: result.map.fixedObjects,
    players: result.assignments.map((a) => ({
      name: a.player.name,
      score: a.player.score,
      group: isDual(a.player) ? 'Both' : String(groupOf(a.player)),
      x: a.spot.x,
      y: a.spot.y,
      distanceToBear: Number(a.travel.toFixed(2)),
    })),
    warnings: result.warnings,
  };
}

module.exports = {
  MAP,
  POLICY,
  planHive,
  rankPlayers,
  candidates,
  placementCost,
  travelCost,
  validate,
  formatPlan,
  toCSV,
  toMapJSON,
  distance,
  isDual,
  rectsOverlap,
};
