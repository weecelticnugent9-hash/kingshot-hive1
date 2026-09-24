'use strict';

/**
 * kingshot-hive/store.js
 * Persistence + roster upserts. JSON file, atomic writes, no dependencies.
 *
 * Shape of data/hive.json:
 * {
 *   "players": {
 *     "<key>": {
 *       "name": "Panda",
 *       "discordId": "1234...",     // optional, for /hive set
 *       "score": 1000,              // millions
 *       "group": "1" | "2" | "both",
 *       "bear1": 0.9,               // optional attendance 0..1
 *       "bear2": 0.7,
 *       "activity": 0.8,            // optional blended value
 *       "locked": false,
 *       "x": 477, "y": 587,         // current in-game spot
 *       "updatedAt": "2026-09-24T..."
 *     }
 *   },
 *   "history": [ { "at": "...", "player": "Panda", "score": 950 } ],
 *   "lastPlan": { ... }
 * }
 */

const fs = require('fs');
const path = require('path');

const normaliseKey = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');

function createStore(filePath) {
  const file = path.resolve(filePath);
  let db = { players: {}, history: [], lastPlan: null };

  function load() {
    if (!fs.existsSync(file)) return db;
    try {
      db = JSON.parse(fs.readFileSync(file, 'utf8'));
      db.players = db.players || {};
      db.history = db.history || [];
    } catch (err) {
      throw new Error(`store: ${file} is not valid JSON (${err.message}). Fix or delete it.`);
    }
    return db;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file); // atomic: never leaves a half-written roster
  }

  /** Add or update one player. Only supplied fields change. */
  function upsert(entry) {
    const key = normaliseKey(entry.name);
    if (!key) throw new Error('store.upsert: name is required');
    const prev = db.players[key] || { name: String(entry.name).trim() };
    const next = { ...prev, ...entry, name: String(entry.name || prev.name).trim(), updatedAt: new Date().toISOString() };

    if (typeof next.score === 'number' && next.score !== prev.score) {
      db.history.push({ at: new Date().toISOString(), player: next.name, score: next.score });
      if (db.history.length > 5000) db.history = db.history.slice(-5000);
    }
    if (next.group) {
      const g = String(next.group).toLowerCase();
      next.group = g === 'both' || g === '1&2' || g === '12' || g === 'all' ? 'both' : g === '2' ? '2' : '1';
    }
    db.players[key] = next;
    save();
    return next;
  }

  /** Bulk upsert, e.g. from a screen-scraped score list. */
  function upsertMany(entries) {
    const out = entries.map((e) => upsert(e));
    return out;
  }

  /** Remove a player who left the alliance. */
  function remove(name) {
    const key = normaliseKey(name);
    if (!db.players[key]) return false;
    delete db.players[key];
    save();
    return true;
  }

  /** Roster in the shape hive.planHive() expects. */
  function roster() {
    return Object.values(db.players).map((p) => ({
      name: p.name,
      score: p.score,
      group: p.group || p.bearGroup || '1',
      activity: p.activity,
      bear1: p.bear1,
      bear2: p.bear2,
      locked: !!p.locked,
      x: p.x,
      y: p.y,
    }));
  }

  /** Record the published plan, so the next run knows who is already where. */
  function applyPlan(result) {
    for (const a of result.assignments) {
      const key = normaliseKey(a.player.name);
      if (db.players[key]) {
        db.players[key].x = a.spot.x;
        db.players[key].y = a.spot.y;
      }
    }
    db.lastPlan = { at: new Date().toISOString(), warnings: result.warnings };
    save();
  }

  /** Average recent scores - steadier than one lucky bear run. */
  function recentAverage(name, n = 5) {
    const key = normaliseKey(name);
    const rows = db.history.filter((h) => normaliseKey(h.player) === key).slice(-n);
    if (!rows.length) return db.players[key] ? db.players[key].score : null;
    return rows.reduce((s, r) => s + r.score, 0) / rows.length;
  }

  load();
  return { db, load, save, upsert, upsertMany, remove, roster, applyPlan, recentAverage, normaliseKey };
}

module.exports = { createStore, normaliseKey };
