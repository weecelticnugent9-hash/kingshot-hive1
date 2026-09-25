'use strict';

/**
 * kingshot-hive/pulse.js
 * MightPulse API client (https://api.mightpulse.com/v1).
 *
 * Auth:   Authorization: Bearer kss_...
 * Limits: 60 requests/minute, 5,000/day. 429 on exceed.
 * Freshness: responses may be up to 60 minutes old per section. A stale
 *            section makes the request wait up to 90s for a refresh.
 *
 * DESIGN RULE: nothing here is called inline from a slash command. A stale
 * section can block for 90 seconds, which would time out the interaction.
 * Everything goes through the cache; a background refresh keeps it warm.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://api.mightpulse.com/v1';

// ---------------------------------------------------------------------------
// Rate limiter: 60/min sliding window. The daily cap is tracked too and
// logged, but a bot at this scale will not approach 5,000.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60 * 1000;
const MAX_PER_MINUTE = 60;

class RateLimiter {
  constructor() {
    this.hits = [];
    this.dayCount = 0;
    this.dayStart = Date.now();
  }

  async wait() {
    const now = Date.now();
    if (now - this.dayStart > 86400000) { this.dayCount = 0; this.dayStart = now; }
    this.hits = this.hits.filter((t) => now - t < WINDOW_MS);
    if (this.hits.length >= MAX_PER_MINUTE) {
      const waitMs = WINDOW_MS - (now - this.hits[0]) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.wait();
    }
    this.hits.push(Date.now());
    this.dayCount++;
  }

  get stats() {
    const now = Date.now();
    return {
      lastMinute: this.hits.filter((t) => now - t < WINDOW_MS).length,
      today: this.dayCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const TTL = {
  player: 45 * 60 * 1000,      // API data is up to 60 min old anyway
  alliance: 45 * 60 * 1000,
  kingdom: 60 * 60 * 1000,
};

function createPulse(key, opts = {}) {
  if (!key) throw new Error('pulse: an API key is required. Set MIGHTPULSE_KEY.');

  const cacheFile = opts.cacheFile || path.join(process.env.HIVE_DATA_DIR || 'data', 'pulse-cache.json');
  const limiter = new RateLimiter();
  let cache = { players: {}, alliances: {}, kingdoms: {} };

  function load() {
    try {
      if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (err) {
      console.error('pulse: cache unreadable, starting fresh:', err.message);
      cache = { players: {}, alliances: {}, kingdoms: {} };
    }
    cache.players = cache.players || {};
    cache.alliances = cache.alliances || {};
    cache.kingdoms = cache.kingdoms || {};
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, cacheFile);
    } catch (err) {
      console.error('pulse: could not write cache:', err.message);
    }
  }

  /** One HTTP call, with the rate limit respected and a retry on 429. */
  async function request(pathname, attempt = 0) {
    await limiter.wait();
    const res = await fetch(BASE + pathname, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });

    if (res.status === 429) {
      if (attempt >= 2) throw new Error('MightPulse rate limit hit and did not clear. Try again shortly.');
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return request(pathname, attempt + 1);
    }
    if (res.status === 404) throw new Error('That id is not tracked by MightPulse (404).');
    if (res.status === 401 || res.status === 403) {
      throw new Error('MightPulse rejected the API key. Check MIGHTPULSE_KEY in Railway.');
    }
    if (!res.ok) throw new Error(`MightPulse returned ${res.status}.`);

    return res.json();
  }

  function fresh(entry, ttl) {
    return entry && entry.at && Date.now() - entry.at < ttl;
  }

  // -------------------------------------------------------------------------
  // Player
  // -------------------------------------------------------------------------
  /**
   * @param {string|number} id  governor_id by default, or uid with idType:'uid'
   * @param {string[]} include  any of base, heroes, ranks, gov_gear
   * @param {boolean} force     bypass the cache
   */
  async function player(id, include = ['base'], force = false) {
    const key = `${id}:${[...include].sort().join(',')}`;
    if (!force && fresh(cache.players[key], TTL.player)) return cache.players[key].data;

    const qs = new URLSearchParams({ include: include.join(',') });
    const data = await request(`/players/${encodeURIComponent(id)}?${qs}`);
    cache.players[key] = { at: Date.now(), data };
    save();
    return data;
  }

  // -------------------------------------------------------------------------
  // Alliance
  // -------------------------------------------------------------------------
  async function alliance(kid, tag, include = ['info', 'roster'], force = false) {
    const key = `${kid}/${tag}:${[...include].sort().join(',')}`;
    if (!force && fresh(cache.alliances[key], TTL.alliance)) return cache.alliances[key].data;

    const qs = new URLSearchParams({ include: include.join(',') });
    const data = await request(`/alliances/${encodeURIComponent(kid)}/${encodeURIComponent(tag)}?${qs}`);
    cache.alliances[key] = { at: Date.now(), data };
    save();
    return data;
  }

  // -------------------------------------------------------------------------
  // Kingdom
  // -------------------------------------------------------------------------
  async function kingdom(kid, include = [], force = false, limit = 100) {
    const key = `${kid}:${[...include].sort().join(',')}`;
    if (!force && fresh(cache.kingdoms[key], TTL.kingdom)) return cache.kingdoms[key].data;

    const qs = new URLSearchParams();
    if (include.length) qs.set('include', include.join(','));
    if (include.includes('boards')) qs.set('limit', String(Math.min(100, limit)));
    const data = await request(`/kingdoms/${encodeURIComponent(kid)}${qs.toString() ? '?' + qs : ''}`);
    cache.kingdoms[key] = { at: Date.now(), data };
    save();
    return data;
  }

  async function kingdomRanks(kid, board, limit = 100) {
    const qs = new URLSearchParams({ limit: String(Math.min(100, limit)) });
    if (board) qs.set('board', board);
    return request(`/kingdoms/${encodeURIComponent(kid)}/ranks?${qs}`);
  }

  /** Roster members in the shape the hive store expects. */
  async function roster(kid, tag) {
    const res = await alliance(kid, tag, ['info', 'roster']);
    const members = res.members || [];
    return members.map((m) => ({
      name: m.nick_name,
      governorId: m.governor_id,
      uid: m.uid,
      power: m.power,
      townCenter: m.town_center_level,
      kills: m.kills,
      rank: m.alliance_rank_label,
      lastActive: m.last_active_at,
      online: m.online,
      kid: m.kid,
    }));
  }

  /** Coordinates for one player, or for a whole roster. */
  async function positions(kid, tag) {
    const members = await roster(kid, tag);
    const out = [];
    for (const m of members) {
      try {
        const p = await player(m.governorId, ['base']);
        const pl = p.player || {};
        if (pl.x != null && pl.y != null) {
          out.push({ name: m.nick_name, governorId: m.governorId, x: pl.x, y: pl.y, power: pl.power });
        }
      } catch (err) {
        // A single untracked player must not abort the whole scan.
        console.error(`pulse: no position for ${m.nick_name} (${err.message})`);
      }
    }
    return out;
  }

  load();
  return {
    player, alliance, kingdom, kingdomRanks, roster, positions,
    request, limiter, save,
    get cachePath() { return cacheFile; },
    get rateStats() { return limiter.stats; },
  };
}

module.exports = { createPulse, BASE };
