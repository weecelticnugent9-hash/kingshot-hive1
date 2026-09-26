'use strict';

/**
 * kingshot-hive/dupes.js
 * Find and merge near-duplicate player names.
 *
 * Why this exists: /hive sync stores names as MightPulse reports them, while
 * /hive import uses the in-game display name. Where they differ, the import
 * creates a SECOND player instead of updating the first - so a 97-strong
 * roster can quietly become 118.
 *
 * PERFORMANCE: a naive all-pairs comparison is O(n^2) with a Levenshtein
 * inside it, which is too slow at 100+ players for a Discord interaction.
 * So candidates are bucketed by lowercase first letter first (near-duplicates
 * almost always share one), and cheap length/content tests run before the
 * expensive edit-distance.
 */

/** Loose key: lowercase, letters and digits only. */
function looseKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strip decorative tags people bolt onto names. */
function baseKey(name) {
  return looseKey(name)
    .replace(/(rawr|mini|jr|sr|ii|iii|the|v)$/i, '')
    .replace(/^the/, '');
}

/** Do two names plausibly refer to the same person? Cheap tests first. */
function similar(a, b) {
  const la = looseKey(a);
  const lb = looseKey(b);
  if (!la || !lb) return false;
  if (la === lb) return true;

  // Cheap rejection: lengths far apart cannot be an edit-distance-2 match.
  if (Math.abs(la.length - lb.length) > 6) return false;

  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  if (short.length >= 4 && long.includes(short)) return true;

  const ba = baseKey(a);
  const bb = baseKey(b);
  if (ba && bb && ba === bb && ba.length >= 3) return true;

  if (la.length >= 6 && lb.length >= 6 && Math.abs(la.length - lb.length) <= 2 && levenshtein(la, lb) <= 2) return true;
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  if (Math.abs(m - n) > 3) return 99;   // caller only cares about small distances
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Group the roster into clusters of likely-duplicate players.
 * Only compares names inside the same first-letter bucket.
 * @param {Array} players from store.roster()
 */
function findDuplicates(players, opts = {}) {
  const maxGroups = opts.maxGroups || 20;
  const buckets = new Map();

  for (const p of players) {
    const k = looseKey(p.name).slice(0, 1) || '?';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p.name);
  }

  const groups = [];
  const used = new Set();

  for (const names of buckets.values()) {
    for (let i = 0; i < names.length; i++) {
      if (used.has(names[i])) continue;
      const cluster = [names[i]];
      let reason = null;

      for (let j = i + 1; j < names.length; j++) {
        if (used.has(names[j])) continue;
        if (similar(names[i], names[j])) {
          cluster.push(names[j]);
          used.add(names[j]);
          reason = reason || (
            looseKey(names[i]) === looseKey(names[j])
              ? 'same name ignoring case/punctuation'
              : `"${names[j]}" looks like "${names[i]}"`
          );
        }
      }

      if (cluster.length > 1) {
        used.add(names[i]);
        groups.push({ names: cluster, reason });
        if (groups.length >= maxGroups) return groups;
      }
    }
  }

  return groups;
}

/**
 * Which entry in a cluster should survive?
 * Prefer one with a bear score, then one with a governorId, then the longer name.
 */
function pickSurvivor(cluster, players) {
  const byName = new Map(players.map((p) => [p.name, p]));
  const scored = cluster.filter((n) => {
    const p = byName.get(n);
    return p && typeof p.score === 'number' && p.score > 0;
  });
  if (scored.length) {
    return scored.sort((a, b) => (byName.get(b).score || 0) - (byName.get(a).score || 0))[0];
  }
  const withGov = cluster.filter((n) => byName.get(n) && byName.get(n).governorId);
  if (withGov.length) return withGov[0];
  return cluster.slice().sort((a, b) => b.length - a.length)[0];
}

module.exports = { findDuplicates, pickSurvivor, similar, looseKey, baseKey, levenshtein };
