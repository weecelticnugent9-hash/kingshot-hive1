'use strict';

/**
 * kingshot-hive/advisor.js
 * Upgrade advisor.
 *
 * Input:  a player's current state, read from MightPulse (hero gear, governor
 *         gear, charm power) or supplied by hand.
 * Output: ranked recommendations, each with the real cost and the real gain.
 *
 * All costs come from tables.js, which is transcribed from the public
 * reference pages at kingshotoptimizer.com. Nothing here is estimated.
 *
 * ---------------------------------------------------------------------------
 * THE THINKING BEHIND THE WEIGHTS (set for this alliance, Sept 2026)
 * ---------------------------------------------------------------------------
 * Three facts about this alliance drove every number below:
 *
 *   1. Mithril is very hard to get. It is the only genuinely gated material,
 *      so it carries an enormous weight. It is gathered in the background and
 *      spent only at a real milestone.
 *
 *   2. Mythic Gear is EASY here - it comes from lucky crates. So it is
 *      weighted barely above a Forgehammer, despite being needed in bulk
 *      (90 per piece for a fully red set).
 *
 *   3. Charm Designs are the standing pinch point, so they outweigh
 *      Charm Guides 3:1.
 *
 * Materials do NOT compete across pools - a stockpile of Satin will never
 * solve a Charm Design shortage. So costs are only ever compared WITHIN a
 * pool. There is deliberately no single global scale.
 */

const T = require('./tables');

// ---------------------------------------------------------------------------
// Weights: relative cost WITHIN each pool. Set by alliance scarcity.
// ---------------------------------------------------------------------------
const POOL_WEIGHTS = {
  charm: { charmGuides: 1.0, charmDesigns: 3.0 },
  hero: { gearXp: 0.002, forgehammers: 1.0, mythicGear: 1.5 },
  red: { mithril: 500.0, mythicGear: 1.5 },
  gov: { satin: 0.0005, threads: 0.05, vision: 0.4 },
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
const RULES = {
  // Red gear. A player only needs Mithril for the pieces they are actually
  // pushing, so the threshold scales with that count rather than the full set.
  red: {
    mithrilPerPiece: 10,
    nearMissAllowance: 3,        // within 3 Mithril -> recommend, note the top-up
    ascensionNeedsMithril: false,
    ascensionMythicGear: 2,
    requireMastery: 10,
    requireMythicLevel: 100,
  },

  // Charms. The community warning: Guides are wasted when every level-3 charm
  // is taken to 4 instead of pushing one to the level-5 breakpoint.
  charm: {
    baselineLevel: 3,
    breakpointLevel: 5,
    flagEarlyLevel4: true,
  },

  // Hero gear mastery. Levels 11+ need Mythic Gear, which is cheap here, so
  // mastery is mostly gated by Forgehammers alone.
  mastery: { cheapCeiling: 10, mythicGearFromLevel: 11 },

  // Stat doctrine. Health and Lethality (charms) are scarcer and worth more
  // than Attack and Defence (gear), which is why charms often win after the
  // basics even before cost is considered.
  statPriority: { lethality: 1.2, health: 1.2, attack: 1.0, defence: 1.0 },
};

// ---------------------------------------------------------------------------
// Cost / gain for each candidate upgrade
// ---------------------------------------------------------------------------

/**
 * Every candidate upgrade a player could take next, with its cost in
 * materials and its raw gain.
 *
 * `state` shape:
 * {
 *   charms:      [{ troop, level }]                     (level 0 = locked/absent)
 *   gear:        [{ slot, troop, enhancement, quality, mastery }]
 *   govGear:     [{ tier }]                             (label from tables.GOV_GEAR)
 *   piecesPushing: 2,                                   (for the red threshold)
 *   materials:   { mithril, mythicGear, charmGuides, charmDesigns,
 *                  forgehammers, gearXp, satin, threads, vision }
 * }
 */
function candidates(state) {
  const out = [];
  const mats = state.materials || {};

  // ------------------------------------------------------------------- charms
  for (const c of state.charms || []) {
    const from = c.level || 0;
    if (from >= T.CHARMS.maxLevel) continue;
    const to = from + 1;
    const step = T.charmStep(from, to);
    out.push({
      pool: 'charm',
      kind: 'charm',
      label: `${c.troop} charm Lv ${from} → ${to}`,
      materials: { charmGuides: step.guides, charmDesigns: step.designs },
      gain: step.bonus,
      gainUnit: '% (Health/Lethality)',
      note: to === RULES.charm.breakpointLevel
        ? 'Reaches the level-5 breakpoint - high value'
        : to === RULES.charm.baselineLevel
          ? 'Reaches the broad level-3 baseline'
          : null,
      state: c,
    });
  }

  // ------------------------------------------------------- hero gear mastery
  for (const g of state.gear || []) {
    const from = g.mastery || 0;
    if (from >= T.FORGEHAMMER.maxLevel) continue;
    const to = from + 1;
    const step = T.forgehammerStep(from, to);
    out.push({
      pool: 'hero',
      kind: 'mastery',
      label: `${g.troop} ${g.slot} mastery ${from} → ${to}`,
      materials: { forgehammers: step.hammers, mythicGear: step.mythic },
      // Mastery itself grants no listed %; its value is unlocking the gear
      // level ceiling, which is where the stat bonus comes from.
      gain: 0,
      gainUnit: 'unlocks higher enhancement',
      note: to === RULES.mastery.mythicGearFromLevel ? 'Now needs Mythic Gear (cheap for you)' : null,
      state: g,
    });
  }

  // ------------------------------------------------------ hero gear level
  for (const g of state.gear || []) {
    const from = g.enhancement || 0;
    if (from >= T.GEAR_XP.maxLevel) continue;
    const to = from + 1;
    const xp = T.gearXpStep(from, to);
    const bonus = T.GEAR_STATS.bonusStep(from, to, g.quality || 'auto');
    out.push({
      pool: 'hero',
      kind: 'gearLevel',
      label: `${g.troop} ${g.slot} +${from} → +${to}${to === 101 ? ' (Red)' : ''}`,
      materials: { gearXp: xp.xp },
      gain: bonus.bonus,
      gainUnit: '% stat',
      note: to === 101 ? 'First red level - ascension must be done first' : null,
      state: g,
    });
  }

  // ------------------------------------------------------- red imbuement
  // Disabled: this alliance is not chasing red-gear imbuement, so Mithril
  // advice is noise. Flip this block back on to restore it.
  const SHOW_IMBUEMENT = false;
  if (SHOW_IMBUEMENT) {
    for (const g of state.gear || []) {
      if (g.quality !== 'red') continue;
      const from = g.enhancement || 100;
      const next = (T.IMBUEMENT.milestones.find((m) => m.at > from) || {}).at;
      if (!next) continue;
      const step = T.IMBUEMENT.stepTo(next);
      out.push({
        pool: 'red',
        kind: 'imbuement',
        label: `${g.troop} ${g.slot} imbuement → +${next}`,
        materials: { mithril: step.mithril, mythicGear: step.mythicGear },
        gain: 0.5 * (next - from),   // ~0.5% per level on the red curve
        gainUnit: '% stat',
        note: `Mithril milestone (+${next})`,
        state: g,
      });
    }
  }

  // ------------------------------------------------- governor gear
  const govTiers = T.GOV_GEAR.tiers;
  for (const p of state.govGear || []) {
    const idx = govTiers.findIndex((t) => t.label === p.tier);
    if (idx < 0 || idx >= govTiers.length - 1) continue;
    const to = govTiers[idx + 1];
    const step = T.govGearStep(p.tier, to.label);
    out.push({
      pool: 'gov',
      kind: 'govGear',
      label: `Governor gear ${p.tier} → ${to.label}`,
      materials: { satin: step.satin, threads: step.threads, vision: step.vision },
      gain: step.bonus,
      gainUnit: '% Attack/Defence',
      note: null,
      state: p,
    });
  }

  return out.map((c) => ({ ...c, ...scoreOf(c, mats, state) }));
}

/** Weighted cost of a candidate, inside its own pool. */
function costWithinPool(candidate) {
  const w = POOL_WEIGHTS[candidate.pool] || {};
  return T.costOf(candidate.materials, w);
}

/** Can the player pay, and by how much do they fall short? */
function affordability(materials, candidate) {
  const shortfalls = [];
  for (const [k, need] of Object.entries(candidate.materials)) {
    if (!need) continue;
    const have = materials[k] || 0;
    if (have < need) shortfalls.push({ material: k, need, have, short: need - have });
  }
  return { affordable: shortfalls.length === 0, shortfalls };
}

/** Attach cost, value-per-cost and red-gear gating to a candidate. */
function scoreOf(candidate, materials, state) {
  const cost = costWithinPool(candidate);
  const aff = affordability(materials, candidate);

  // Red gear only surfaces once the per-piece Mithril threshold is met, or the
  // shortfall is small enough to close with a store purchase.
  let gated = false;
  let gateReason = null;
  if (candidate.pool === 'red') {
    const r = RULES.red;
    const need = r.mithrilPerPiece * Math.max(1, state.piecesPushing || 1);
    const held = materials.mithril || 0;
    if (candidate.kind === 'imbuement' && held + r.nearMissAllowance * Math.max(1, state.piecesPushing || 1) < need) {
      gated = true;
      gateReason = `Hold ~${need} Mithril for this piece (you have ${held}) - keep gathering`;
    }
  }

  // Charms below the baseline are always worth doing first.
  let boost = 0;
  if (candidate.pool === 'charm') {
    const lvl = (candidate.state && candidate.state.level) || 0;
    if (lvl < RULES.charm.baselineLevel) boost += 40;
    else if (lvl < RULES.charm.breakpointLevel - 1 && RULES.charm.flagEarlyLevel4) {
      // levelling a 3 straight to 4 when a 5-breakpoint push is available
      const otherAt3 = (state.charms || []).some((c) => (c.level || 0) === RULES.charm.baselineLevel);
      if (otherAt3) boost -= 15;   // demote: push to 5 elsewhere instead
    }
  }

  // Cheap governor gear early on is fine; it falls away fast.
  if (candidate.pool === 'gov') boost -= 5;

  const valuePerCost = candidate.gain > 0 && cost > 0 ? (candidate.gain * (1 + boost / 100)) / cost : 0;

  return { cost, valuePerCost, affordable: aff.affordable, shortfalls: aff.shortfalls, gated, gateReason };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
function advise(state, opts = {}) {
  const limit = opts.limit || 5;
  const all = candidates(state);

  const available = all.filter((c) => !c.gated && c.gain > 0 && c.affordable);
  const nearMiss = all.filter((c) => !c.gated && c.gain > 0 && !c.affordable && isNearMiss(c, state));
  const blocked = all.filter((c) => c.gated);

  available.sort((a, b) => b.valuePerCost - a.valuePerCost);
  nearMiss.sort((a, b) => totalShort(a) - totalShort(b));

  return {
    recommendations: available.slice(0, limit),
    nearMisses: nearMiss.slice(0, limit),
    blocked: blocked.slice(0, 4),
    notes: buildNotes(state, all),
  };
}

function isNearMiss(candidate, state) {
  const r = RULES.red;
  if (candidate.pool === 'red') {
    const need = r.mithrilPerPiece * Math.max(1, state.piecesPushing || 1);
    const held = state.materials.mithril || 0;
    return held >= need - r.nearMissAllowance * Math.max(1, state.piecesPushing || 1);
  }
  // Any other shortfall with a single modest gap counts as closable.
  return candidate.shortfalls.every((s) => s.short <= Math.max(3, s.need * 0.1));
}

function totalShort(candidate) {
  return candidate.shortfalls.reduce((n, s) => n + s.short * 1000, 0);
}

function buildNotes(state, all) {
  const notes = [];

  // Charm breakpoint warning - the specific mistake the community flags.
  const atThree = (state.charms || []).filter((c) => (c.level || 0) === RULES.charm.baselineLevel);
  const atFour = (state.charms || []).filter((c) => (c.level || 0) === RULES.charm.baselineLevel + 1);
  if (atFour.length > 0 && atThree.length > 0) {
    notes.push(
      `${atFour.length} charm(s) sitting at Lv ${RULES.charm.baselineLevel + 1} while ${atThree.length} ` +
      `are still at Lv ${RULES.charm.baselineLevel}. Push one to Lv ${RULES.charm.breakpointLevel} ` +
      `before taking more to ${RULES.charm.baselineLevel + 1} - the Guides are worth more at the breakpoint.`
    );
  }

  // Ascension is free of Mithril, which is the useful surprise here.
  const ascensionReady = (state.gear || []).filter(
    (g) => (g.enhancement || 0) >= RULES.red.requireMythicLevel
      && (g.mastery || 0) >= RULES.red.requireMastery
      && g.quality !== 'red'
  );
  if (ascensionReady.length) {
    notes.push(
      `${ascensionReady.length} piece(s) are ready to ascend to Red: Mythic 100 + mastery ${RULES.red.requireMastery}. ` +
      `Ascension costs ${RULES.red.ascensionMythicGear} Mythic Gear and NO Mithril - do these before spending Mithril on anything.`
    );
  }

  // Mithril policy.
  const pushing = Math.max(1, state.piecesPushing || 1);
  const need = RULES.red.mithrilPerPiece * pushing;
  notes.push(
    `Mithril: keep gathering in the background. For ${pushing} piece(s) in progress you want ~${need} banked. ` +
    `At ${state.materials.mithril || 0} held, a store purchase closes a ${RULES.red.nearMissAllowance}-Mithril gap.`
  );

  return notes;
}

// ---------------------------------------------------------------------------
// Discord formatting
// ---------------------------------------------------------------------------
const MAT_LABEL = {
  charmGuides: 'Charm Guides', charmDesigns: 'Charm Designs',
  forgehammers: 'Forgehammers', mythicGear: 'Mythic Gear',
  gearXp: 'Gear XP', mithril: 'Mithril',
  satin: 'Satin', threads: 'Gilded Threads', vision: "Artisan's Vision",
};

function costLine(materials) {
  return Object.entries(materials)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v.toLocaleString()} ${MAT_LABEL[k] || k}`)
    .join(' + ');
}

function formatAdvice(result, state) {
  const lines = [];

  if (result.recommendations.length) {
    lines.push('**Do next**');
    result.recommendations.forEach((r, i) => {
      lines.push(
        `${i + 1}. **${r.label}** - +${r.gain ? r.gain.toFixed(1) : '?'}${r.gainUnit ? ' ' + r.gainUnit : ''}\n` +
        `   Cost: ${costLine(r.materials)}`
      );
      if (r.note) lines.push(`   _${r.note}_`);
    });
    lines.push('');
  }

  if (result.nearMisses.length) {
    lines.push('**Within reach (a small top-up unlocks these)**');
    result.nearMisses.forEach((r) => {
      const gaps = r.shortfalls.map((s) => `${s.short} more ${MAT_LABEL[s.material] || s.material}`).join(', ');
      lines.push(`- **${r.label}** - needs ${gaps}`);
    });
    lines.push('');
  }

  if (result.blocked.length) {
    lines.push('**Not yet**');
    result.blocked.forEach((r) => lines.push(`- ${r.label} - ${r.gateReason}`));
    lines.push('');
  }

  if (result.notes.length) {
    lines.push('**Notes**');
    result.notes.forEach((n) => lines.push(`- ${n}`));
  }

  return lines.join('\n');
}

/**
 * Build a state object from a MightPulse player response.
 * Uses whatever the API actually returned; anything absent is simply skipped
 * rather than guessed at.
 */
function stateFromPulse(playerResponse, extras = {}) {
  const p = playerResponse.player || playerResponse;
  const heroes = playerResponse.heroes || p.heroes || [];
  const gov = playerResponse.gov_gear || p.gov_gear || {};

  const gear = [];
  const seen = new Set();
  for (const h of heroes) {
    for (const g of h.gear || []) {
      const id = `${g.troop || '?'}-${g.slot}`;
      if (seen.has(id)) continue;
      seen.add(id);
      gear.push({
        slot: g.slot,
        troop: g.troop_label || g.troop || '?',
        enhancement: g.enhancement_level || 0,
        mastery: g.refine_level || 0,
        quality: g.red ? 'red' : (g.quality_key || 'auto'),
      });
    }
  }

  const govGear = (gov.items || []).map((it) => ({ tier: it.name || it.star || '?' }));

  return {
    charms: extras.charms || [],       // the API exposes charm POWER, not per-charm levels
    gear,
    govGear,
    piecesPushing: extras.piecesPushing || 2,
    materials: extras.materials || {},
  };
}

module.exports = {
  POOL_WEIGHTS, RULES, candidates, advise, formatAdvice,
  stateFromPulse, costWithinPool, costLine,
};
