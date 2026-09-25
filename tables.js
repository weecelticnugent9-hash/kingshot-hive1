'use strict';

/**
 * kingshot-hive/tables.js
 * Upgrade cost and stat tables, copied from the public reference pages at
 * kingshotoptimizer.com (version 1.14.x, 2026-09). These are real numbers,
 * not estimates - the advisor ranks on them directly.
 *
 * If the game patches, update these tables. Each one carries its source.
 */

// ---------------------------------------------------------------------------
// Charms: cost per level and stat bonus per level (per charm, 18 charms total)
// Source: kingshotoptimizer.com/charms/references/
// ---------------------------------------------------------------------------
const CHARMS = {
  source: 'kingshotoptimizer.com/charms/references',
  maxLevel: 22,
  // level -> { guides, designs, bonus }
  levels: {
    1:  { guides: 5,    designs: 5,    bonus: 9.0 },
    2:  { guides: 40,   designs: 15,   bonus: 3.0 },
    3:  { guides: 60,   designs: 40,   bonus: 4.0 },
    4:  { guides: 80,   designs: 100,  bonus: 3.0 },
    5:  { guides: 100,  designs: 200,  bonus: 6.0 },
    6:  { guides: 120,  designs: 300,  bonus: 5.0 },
    7:  { guides: 140,  designs: 400,  bonus: 5.0 },
    8:  { guides: 200,  designs: 400,  bonus: 5.0 },
    9:  { guides: 300,  designs: 400,  bonus: 5.0 },
    10: { guides: 420,  designs: 420,  bonus: 5.0 },
    11: { guides: 560,  designs: 420,  bonus: 5.0 },
    12: { guides: 580,  designs: 600,  bonus: 4.0 },
    13: { guides: 610,  designs: 780,  bonus: 4.0 },
    14: { guides: 645,  designs: 960,  bonus: 4.0 },
    15: { guides: 685,  designs: 1140, bonus: 4.0 },
    16: { guides: 730,  designs: 1320, bonus: 4.0 },
    17: { guides: 780,  designs: 1500, bonus: 4.0 },
    18: { guides: 835,  designs: 1680, bonus: 4.0 },
    19: { guides: 895,  designs: 1860, bonus: 4.0 },
    20: { guides: 960,  designs: 2040, bonus: 4.0 },
    21: { guides: 1030, designs: 2220, bonus: 4.0 },
    22: { guides: 1105, designs: 2400, bonus: 4.0 },
  },
  totals: { guidesToMax: 10880, designsToMax: 19200, cumulativeBonusAtMax: 99.0 },
};

// ---------------------------------------------------------------------------
// Forgehammer (gear mastery): cost is Level x 10 hammers. Levels 11+ also need
// Mythic Gear. Source: kingshotoptimizer.com/hero-gear/references/forgehammer-costs/
// ---------------------------------------------------------------------------
const FORGEHAMMER = {
  source: 'kingshotoptimizer.com/hero-gear/references/forgehammer-costs',
  maxLevel: 20,
  formula: (level) => level * 10,
  // Mythic Gear needed for levels 11-20; zero below that.
  mythicGear: { 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 7, 18: 8, 19: 9, 20: 10 },
  totals: { hammersTo10: 550, hammersTo20: 2100, mythicTo20: 55 },
};

// ---------------------------------------------------------------------------
// Hero gear enhancement XP. Partial table (published sampling); interpolate
// between known points. Source: kingshotoptimizer.com/hero-gear/references/xp-costs/
// ---------------------------------------------------------------------------
const GEAR_XP = {
  source: 'kingshotoptimizer.com/hero-gear/references/xp-costs',
  maxLevel: 200,
  thresholds: { epicMax: 80, mythicMax: 100, redStarts: 101 },
  // level -> cumulative XP
  cumulative: {
    0: 0, 5: 100, 10: 325, 15: 675, 20: 1150, 25: 1750, 30: 2480, 35: 3430,
    40: 4640, 45: 6290, 50: 8440, 55: 11090, 60: 14250, 65: 18100, 70: 22710,
    75: 28260, 80: 34820, 85: 42570, 90: 51570, 95: 61820, 100: 73320,
    105: 83620, 110: 97620, 115: 112870, 120: 125970, 125: 143720,
    130: 162720, 135: 182970, 140: 200070, 145: 222820, 150: 246820,
    155: 272070, 160: 293170, 165: 321670, 170: 352670, 175: 386170,
    180: 414770, 185: 453270, 190: 494270, 195: 537770, 200: 574370,
  },
  totals: { epicMax: 34820, mythicMax: 73320, redRange: 501050, grand: 574370 },
};

// ---------------------------------------------------------------------------
// Hero gear stat bonuses by level and quality.
// Source: kingshotoptimizer.com/hero-gear/references/stat-bonuses
// Published as formulas, which is cleaner than a table:
//   Epic   (0-80):   0.09 + level * 0.0021      -> 9.0% .. 25.8%
//   Mythic (0-100):  0.15 + level * 0.0035      -> 15.0% .. 50.0%
//   Red  (101-200):  0.50 + (level-100) * 0.005 -> 50.5% .. 100.0%
// ---------------------------------------------------------------------------
const GEAR_STATS = {
  source: 'kingshotoptimizer.com/hero-gear/references/stat-bonuses',
  epicMax: 80,
  mythicMax: 100,
  redMax: 200,
  /** Percent stat bonus for a gear piece at a given enhancement level. */
  bonusAt(level, quality = 'auto') {
    const q = quality === 'auto'
      ? (level > 100 ? 'red' : level > 80 ? 'mythic' : 'epic')
      : String(quality).toLowerCase();
    if (q === 'red') return 50 + (level - 100) * 0.5;
    if (q === 'mythic') return 15 + level * 0.35;
    return 9 + level * 0.21;
  },
  /**
   * Stat gain from one enhancement level to another.
   * NOTE: this must not rely on `this`. The advisor destructures tables and
   * calls the helper standalone, which would leave `this` undefined.
   */
  bonusStep(from, to, quality = 'auto') {
    return {
      bonus: gearBonusAt(to, quality) - gearBonusAt(from, quality),
      from, to, quality,
    };
  },
};

/** Standalone so it works with or without an owning object. */
function gearBonusAt(level, quality = 'auto') {
  const q = quality === 'auto'
    ? (level > 100 ? 'red' : level > 80 ? 'mythic' : 'epic')
    : String(quality).toLowerCase();
  if (q === 'red') return 50 + (level - 100) * 0.5;
  if (q === 'mythic') return 15 + level * 0.35;
  return 9 + level * 0.21;
}

// ---------------------------------------------------------------------------
// Red gear imbuement: milestone costs from Mythic 100 to Red 200.
// Source: kingshotoptimizer.com/hero-gear/references/imbuement-costs
// ---------------------------------------------------------------------------
const IMBUEMENT = {
  source: 'kingshotoptimizer.com/hero-gear/references/imbuement-costs',
  ascension: { mythicGear: 2, requiredMastery: 10, note: 'Mythic gear must be at level 100 and mastery at 10+' },
  // +20-level milestones: level reached -> { mastery, mithril, mythicGear }
  milestones: [
    { at: 120, mastery: 11, mithril: 10, mythicGear: 3, cumulativeMithril: 10,  cumulativeMythic: 5 },
    { at: 140, mastery: 12, mithril: 20, mythicGear: 5, cumulativeMithril: 30,  cumulativeMythic: 10 },
    { at: 160, mastery: 13, mithril: 30, mythicGear: 5, cumulativeMithril: 60,  cumulativeMythic: 15 },
    { at: 180, mastery: 14, mithril: 40, mythicGear: 10, cumulativeMithril: 100, cumulativeMythic: 25 },
    { at: 200, mastery: 15, mithril: 50, mythicGear: 10, cumulativeMithril: 150, cumulativeMythic: 35 },
  ],
  perPieceTotals: { mithril: 150, mythicGear: 35 },
  fullSet: { pieces: 12, mithril: 1800, mythicGear: 1080 },
  /** Cost of reaching a red-gear imbuement milestone from Mythic 100. */
  stepTo(targetLevel) {
    let mithril = 0, mythicGear = 2; // ascension
    for (const m of this.milestones) {
      if (m.at > targetLevel) break;
      mithril += m.mithril;
      mythicGear += m.mythicGear;
    }
    return { mithril, mythicGear, to: targetLevel };
  },
};

// ---------------------------------------------------------------------------
// Governor gear: per-tier cost and stat bonus (per piece, 6 pieces)
// Source: kingshotoptimizer.com/governor-gear/references/
// ---------------------------------------------------------------------------
const GOV_GEAR = {
  source: 'kingshotoptimizer.com/governor-gear/references',
  // ordered chain from Green 0* upward
  tiers: [
    { label: 'Green 0*',      rarity: 'Green',  satin: 1500,   threads: 15,   vision: 0,     bonus: 9.35,  cumulative: 9.35,  setBonus: 2.0 },
    { label: 'Green 1*',      rarity: 'Green',  satin: 3800,   threads: 40,   vision: 0,     bonus: 3.40,  cumulative: 12.75, setBonus: 2.5 },
    { label: 'Blue 0*',       rarity: 'Blue',   satin: 7000,   threads: 70,   vision: 0,     bonus: 4.25,  cumulative: 17.00, setBonus: 3.0 },
    { label: 'Blue 1*',       rarity: 'Blue',   satin: 9700,   threads: 95,   vision: 0,     bonus: 4.25,  cumulative: 21.25, setBonus: 3.5 },
    { label: 'Blue 2*',       rarity: 'Blue',   satin: 1000,   threads: 10,   vision: 45,    bonus: 4.25,  cumulative: 25.50, setBonus: 4.0 },
    { label: 'Blue 3*',       rarity: 'Blue',   satin: 1000,   threads: 10,   vision: 50,    bonus: 4.25,  cumulative: 29.75, setBonus: 4.5 },
    { label: 'Purple 0*',     rarity: 'Purple', satin: 1500,   threads: 15,   vision: 60,    bonus: 4.25,  cumulative: 34.00, setBonus: 5.0 },
    { label: 'Purple 1*',     rarity: 'Purple', satin: 1500,   threads: 15,   vision: 70,    bonus: 2.89,  cumulative: 36.89, setBonus: 5.0 },
    { label: 'Purple 2*',     rarity: 'Purple', satin: 6500,   threads: 65,   vision: 40,    bonus: 2.89,  cumulative: 39.78, setBonus: 5.0 },
    { label: 'Purple 3*',     rarity: 'Purple', satin: 8000,   threads: 80,   vision: 50,    bonus: 2.89,  cumulative: 42.67, setBonus: 5.0 },
    { label: 'Purple T1 0*',  rarity: 'Purple', satin: 10000,  threads: 95,   vision: 60,    bonus: 2.89,  cumulative: 45.56, setBonus: 6.0 },
    { label: 'Purple T1 1*',  rarity: 'Purple', satin: 11000,  threads: 110,  vision: 70,    bonus: 2.89,  cumulative: 48.45, setBonus: 6.0 },
    { label: 'Purple T1 2*',  rarity: 'Purple', satin: 13000,  threads: 130,  vision: 85,    bonus: 2.89,  cumulative: 51.34, setBonus: 6.0 },
    { label: 'Purple T1 3*',  rarity: 'Purple', satin: 15000,  threads: 160,  vision: 100,   bonus: 2.89,  cumulative: 54.23, setBonus: 6.0 },
    { label: 'Gold 0*',       rarity: 'Gold',   satin: 22000,  threads: 220,  vision: 40,    bonus: 2.55,  cumulative: 56.78, setBonus: 7.0 },
    { label: 'Gold 1*',       rarity: 'Gold',   satin: 23000,  threads: 230,  vision: 40,    bonus: 2.55,  cumulative: 59.33, setBonus: 7.0 },
    { label: 'Gold 2*',       rarity: 'Gold',   satin: 25000,  threads: 250,  vision: 45,    bonus: 2.55,  cumulative: 61.88, setBonus: 7.0 },
    { label: 'Gold 3*',       rarity: 'Gold',   satin: 26000,  threads: 260,  vision: 45,    bonus: 2.55,  cumulative: 64.43, setBonus: 7.0 },
  ],
  totals: { satinAllTiers: 9947500, threadsAllTiers: 99480, visionAllTiers: 20255, maxCumulative: 171.0 },
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Cost and gain of taking a charm from `from` to `to` (one charm). */
function charmStep(from, to) {
  let guides = 0, designs = 0, bonus = 0;
  for (let l = from + 1; l <= to; l++) {
    const row = CHARMS.levels[l];
    if (!row) continue;
    guides += row.guides;
    designs += row.designs;
    bonus += row.bonus;
  }
  return { guides, designs, bonus, from, to };
}

/** Cost of a forgehammer upgrade step. */
function forgehammerStep(from, to) {
  let hammers = 0, mythic = 0;
  for (let l = from + 1; l <= to; l++) {
    hammers += FORGEHAMMER.formula(l);
    mythic += FORGEHAMMER.mythicGear[l] || 0;
  }
  return { hammers, mythic, from, to };
}

/** Cumulative hero-gear XP at a level, linearly interpolated between samples. */
function gearXpAt(level) {
  const c = GEAR_XP.cumulative;
  if (level <= 0) return 0;
  if (c[level] != null) return c[level];
  const keys = Object.keys(c).map(Number).sort((a, b) => a - b);
  if (level >= keys[keys.length - 1]) return c[keys[keys.length - 1]];
  let lo = keys[0], hi = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] <= level && level <= keys[i + 1]) { lo = keys[i]; hi = keys[i + 1]; break; }
  }
  const t = (level - lo) / (hi - lo);
  return Math.round(c[lo] + (c[hi] - c[lo]) * t);
}

/** XP to go from one gear enhancement level to another. */
function gearXpStep(from, to) {
  return { xp: gearXpAt(to) - gearXpAt(from), from, to };
}

/** Find a governor-gear tier by its label (case-insensitive, tolerant). */
function govTier(label) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const want = norm(label);
  return GOV_GEAR.tiers.find((t) => norm(t.label) === want)
    || GOV_GEAR.tiers.find((t) => norm(t.label).replace(/\s/g, '') === want.replace(/\s/g, ''))
    || null;
}

/** Cost of moving one governor-gear piece between two tiers. */
function govGearStep(fromLabel, toLabel) {
  const a = govTier(fromLabel);
  const b = govTier(toLabel);
  if (!a || !b) return null;
  const ia = GOV_GEAR.tiers.indexOf(a);
  const ib = GOV_GEAR.tiers.indexOf(b);
  if (ib <= ia) return { satin: 0, threads: 0, vision: 0, bonus: 0, from: a.label, to: b.label };
  let satin = 0, threads = 0, vision = 0, bonus = 0;
  for (let i = ia + 1; i <= ib; i++) {
    const t = GOV_GEAR.tiers[i];
    satin += t.satin; threads += t.threads; vision += t.vision; bonus += t.bonus;
  }
  return { satin, threads, vision, bonus, from: a.label, to: b.label };
}

// ---------------------------------------------------------------------------
// Costs expressed in a common unit, so charm / hammer / gear can be compared.
// These are RELATIVE weights you choose - they say how scarce each material is
// for YOUR alliance. Defaults treat one charm guide as 1.0.
// ---------------------------------------------------------------------------
const MATERIAL_WEIGHTS = {
  charmGuides: 1.0,
  charmDesigns: 0.5,
  forgehammers: 1.5,
  mythicGear: 40.0,
  gearXp: 0.002,
  satin: 0.0008,
  threads: 0.12,
  vision: 0.6,
};

function costOf(materials, weights = MATERIAL_WEIGHTS) {
  let total = 0;
  for (const [k, v] of Object.entries(materials)) {
    if (weights[k] == null) continue;
    total += (v || 0) * weights[k];
  }
  return total;
}

module.exports = {
  CHARMS, FORGEHAMMER, GEAR_XP, GOV_GEAR, MATERIAL_WEIGHTS,
  charmStep, forgehammerStep, gearXpAt, gearXpStep, govTier, govGearStep, costOf,
};
