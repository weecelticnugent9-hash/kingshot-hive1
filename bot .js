'use strict';

/**
 * kingshot-hive/bot.js
 * Discord layer. Roster + map editing + planning, all from slash commands.
 *
 *   npm install discord.js
 *   DISCORD_TOKEN=... node bot.js
 *
 * Commands:
 *   /hive set      name score bear [activity] [spot]    - add or update a player
 *   /hive score    name score                           - fast score update
 *   /hive remove   name
 *   /hive list
 *   /hive plan                                          - draft layout + PNG
 *   /hive publish                                       - post + save as official
 *   /hive lock     name spot [unlock]
 *   /hive import   text                                 - bulk roster upsert
 *   /hive map                                           - show the map and lint it
 *
 *   /add    object|blockage|bear   x y [size] [name] [overwrite]
 *   /move   object|blockage|bear   x y [name]
 *   /delete object|blockage|bear   [name] | [x y]
 *
 * The map lives in data/map.json. /add, /move and /delete write to it, so
 * object positions are editable from Discord with no redeploy.
 */

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, EmbedBuilder,
} = require('discord.js');

const hive = require('./hive');
const { createStore } = require('./store');
const { createMapStore } = require('./mapstore');
const { renderPNG, renderText } = require('./render');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const HUB_CHANNEL_ID = process.env.HIVE_CHANNEL_ID;

if (!TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

const DATA_DIR = process.env.HIVE_DATA_DIR || path.join(__dirname, 'data');
const store = createStore(process.env.HIVE_DB || path.join(DATA_DIR, 'hive.json'));
const mapStore = createMapStore(process.env.HIVE_MAP || path.join(DATA_DIR, 'map.json'));

// Restrict map edits to people you trust. Leave empty to allow anyone.
const EDITOR_ROLE_IDS = (process.env.HIVE_EDITOR_ROLES || '').split(',').map((s) => s.trim()).filter(Boolean);

function canEditMap(interaction) {
  if (!EDITOR_ROLE_IDS.length) return true;
  if (interaction.memberPermissions?.has('ManageGuild')) return true;
  return Boolean(interaction.member?.roles?.cache?.some((r) => EDITOR_ROLE_IDS.includes(r.id)));
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------
const ENTITY_CHOICES = [
  { name: 'object (unmovable, 2x2)', value: 'object' },
  { name: 'blockage (keep-clear area)', value: 'blockage' },
  { name: 'bear (3x3 trap)', value: 'bear' },
];

const commands = [
  new SlashCommandBuilder().setName('hive').setDescription('Kingshot hive placement')
    .addSubcommand((s) => s.setName('set').setDescription('Add or update a player')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true))
      .addIntegerOption((o) => o.setName('score').setDescription('Bear score in millions (1000 = 1 billion)').setRequired(true))
      .addStringOption((o) => o.setName('bear').setDescription('Which bear they play').setRequired(true)
        .addChoices({ name: 'Bear 1', value: '1' }, { name: 'Bear 2', value: '2' }, { name: 'Both', value: 'both' }))
      .addNumberOption((o) => o.setName('activity').setDescription('Recent attendance 0-1 (0.9 = 90%)').setMinValue(0).setMaxValue(1))
      .addStringOption((o) => o.setName('spot').setDescription('Current in-game spot as X,Y')))
    .addSubcommand((s) => s.setName('score').setDescription('Update one player\'s score only')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true))
      .addIntegerOption((o) => o.setName('score').setDescription('Bear score in millions').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a player from the roster')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show the stored roster'))
    .addSubcommand((s) => s.setName('plan').setDescription('Compute a hive layout without publishing it'))
    .addSubcommand((s) => s.setName('publish').setDescription('Post the layout image and save it as the current plan'))
    .addSubcommand((s) => s.setName('lock').setDescription('Pin a player to a spot and re-plan around them')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true))
      .addStringOption((o) => o.setName('spot').setDescription('Spot as X,Y').setRequired(true))
      .addBooleanOption((o) => o.setName('unlock').setDescription('Set true to release the lock')))
    .addSubcommand((s) => s.setName('import').setDescription('Bulk upsert from pasted lines')
      .addStringOption((o) => o.setName('text').setDescription('One player per line: Name 100m Bear 1').setRequired(true)))
    .addSubcommand((s) => s.setName('map').setDescription('Show the hive map: bears, objects, blocked areas and free spots')),

  new SlashCommandBuilder().setName('add').setDescription('Add an object, blockage or bear to the hive map')
    .addStringOption((o) => o.setName('type').setDescription('What to add').setRequired(true).addChoices(...ENTITY_CHOICES))
    .addStringOption((o) => o.setName('x').setDescription('X coordinate, or "X400 Y400"').setRequired(true))
    .addStringOption((o) => o.setName('y').setDescription('Y coordinate (leave blank if you used "X400 Y400" above)'))
    .addStringOption((o) => o.setName('size').setDescription('Footprint, e.g. 2x2 or 3x3 (default: 2x2, bears 3x3)'))
    .addStringOption((o) => o.setName('name').setDescription('Label (default: auto-numbered)'))
    .addBooleanOption((o) => o.setName('overwrite').setDescription('Move it if a name already exists')),

  new SlashCommandBuilder().setName('move').setDescription('Move an existing object, blockage or bear')
    .addStringOption((o) => o.setName('type').setDescription('What to move').setRequired(true).addChoices(...ENTITY_CHOICES))
    .addStringOption((o) => o.setName('name').setDescription('Which one (by name)').setRequired(true))
    .addStringOption((o) => o.setName('x').setDescription('New X, or "X400 Y400"').setRequired(true))
    .addStringOption((o) => o.setName('y').setDescription('New Y (leave blank if you used "X400 Y400" above)'))
    .addStringOption((o) => o.setName('size').setDescription('New footprint, e.g. 2x2')),

  new SlashCommandBuilder().setName('delete').setDescription('Remove an object, blockage or bear from the map')
    .addStringOption((o) => o.setName('type').setDescription('What to delete').setRequired(true).addChoices(...ENTITY_CHOICES))
    .addStringOption((o) => o.setName('name').setDescription('Which one (by name)'))
    .addStringOption((o) => o.setName('x').setDescription('Or its X coordinate, if you prefer'))
    .addStringOption((o) => o.setName('y').setDescription('Its Y coordinate')),
].map((c) => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('Slash commands deployed');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const parseScore = (value) => {
  const s = String(value).toLowerCase().replace(/[, ]/g, '');
  const num = parseFloat(s);
  if (Number.isNaN(num)) return null;
  if (s.includes('b')) return Math.round(num * 1000);
  return Math.round(num);
};

const parseGroup = (value) => {
  const v = String(value).toLowerCase();
  if (v.includes('both') || v.includes('1&2') || v.includes('1 and 2')) return 'both';
  return v.includes('2') ? '2' : '1';
};

const parseSpot = (value) => {
  if (!value) return null;
  const m = String(value).match(/(-?\d+)\s*[, ]\s*(-?\d+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

const SCORE_LINE = /^(.+?)\s+([\d.,]+\s*[bm]?)\s*(?:bear\s*)?(1\s*&\s*2|both|1|2)?\s*$/i;

function runPlan() {
  const roster = store.roster();
  if (!roster.length) throw new Error('Roster is empty. Add players with /hive set or /hive import.');
  return hive.planHive(roster, { map: mapStore.get() });
}

/** Coordinates may arrive as (x, y) or as a single "X400 Y400" string in x. */
function coordinatesFrom(options) {
  const rawX = options.getString('x');
  const rawY = options.getString('y');
  if (rawY != null && rawY !== '') {
    const nums = String(rawX).match(/-?\d+/g);
    if (!nums) return null;
    return { x: Number(nums[0]), y: Number(rawY) };
  }
  const nums = String(rawX).replace(/[xX:]/g, ' ').replace(/[yY]/g, ' ').match(/-?\d+/g);
  if (!nums || nums.length < 2) return null;
  return { x: Number(nums[0]), y: Number(nums[1]) };
}

/** Explain what a footprint actually covers, so people can sanity-check it. */
function coverageNote(entry) {
  const x2 = entry.x + entry.w - 1;
  const y2 = entry.y + entry.h - 1;
  return `covers X${entry.x}-${x2}, Y${entry.y}-${y2} (${entry.w}x${entry.h})`;
}

const MAP_BLOCKED_MSG = 'Map editing is restricted to alliance officers. Ask an officer, or set HIVE_EDITOR_ROLES to change who can edit.';

// ---------------------------------------------------------------------------
// Interaction handling
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // =======================================================================
    // Map editing commands
    // =======================================================================
    if (interaction.commandName === 'add' || interaction.commandName === 'move' || interaction.commandName === 'delete') {
      if (!canEditMap(interaction)) return interaction.reply({ content: MAP_BLOCKED_MSG, ephemeral: true });
      const type = interaction.options.getString('type');
      const name = interaction.options.getString('name');

      if (interaction.commandName === 'add') {
        const coord = coordinatesFrom(interaction);
        if (!coord) return interaction.reply({ content: 'Could not read those coordinates. Use `X400 Y400`, `400,400` or fill both boxes.', ephemeral: true });
        const { action, entry, map } = mapStore.put({
          category: type,
          name: name || undefined,
          x: coord.x,
          y: coord.y,
          size: interaction.options.getString('size') || undefined,
          overwrite: interaction.options.getBoolean('overwrite') || false,
        });
        const lint = mapStore.check();
        return interaction.reply({
          content:
            `**${entry.name}** ${action} at **${entry.x}, ${entry.y}** - ${coverageNote(entry)}.\n` +
            `Map now has ${lint.entries} fixed item(s) and ${lint.freeSpots} free 2x2 city spots.` +
            (lint.ok ? '' : `\n\n**Check these:**\n${lint.problems.map((p) => `- ${p}`).join('\n')}`),
          ephemeral: true,
        });
      }

      if (interaction.commandName === 'move') {
        const coord = coordinatesFrom(interaction);
        if (!coord) return interaction.reply({ content: 'Could not read the new coordinates. Use `X400 Y400` or fill both boxes.', ephemeral: true });
        const { entry } = mapStore.put({
          category: type,
          name,
          x: coord.x,
          y: coord.y,
          size: interaction.options.getString('size') || undefined,
          overwrite: true,
        });
        const lint = mapStore.check();
        return interaction.reply({
          content:
            `**${entry.name}** moved to **${entry.x}, ${entry.y}** - ${coverageNote(entry)}.\n` +
            (lint.ok ? `${lint.freeSpots} free 2x2 city spots remain.` : `**Check these:**\n${lint.problems.map((p) => `- ${p}`).join('\n')}`),
          ephemeral: true,
        });
      }

      // delete
      const rawX = interaction.options.getString('x');
      const coord = rawX ? coordinatesFrom(interaction) : null;
      const { removed } = mapStore.remove({ category: type, name: name || undefined, x: coord ? coord.x : null, y: coord ? coord.y : null });
      const lint = mapStore.check();
      return interaction.reply({
        content: `Removed **${removed.name}** (was at ${removed.x}, ${removed.y}). ${lint.freeSpots} free 2x2 city spots now.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName !== 'hive') return;
    const sub = interaction.options.getSubcommand();

    // =======================================================================
    // Roster commands
    // =======================================================================
    if (sub === 'set' || sub === 'score') {
      const name = interaction.options.getString('name');
      const score = interaction.options.getInteger('score');
      const entry = { name, score };
      if (sub === 'set') {
        entry.group = interaction.options.getString('bear');
        const activity = interaction.options.getNumber('activity');
        if (activity != null) entry.activity = activity;
        const spot = parseSpot(interaction.options.getString('spot'));
        if (spot) { entry.x = spot.x; entry.y = spot.y; }
      }
      const saved = store.upsert(entry);
      return interaction.reply({
        content: `Saved **${saved.name}** - ${saved.score}m, bear ${saved.group || '1'}${saved.x != null ? `, spot ${saved.x},${saved.y}` : ''}.`,
        ephemeral: true,
      });
    }

    if (sub === 'remove') {
      const name = interaction.options.getString('name');
      const ok = store.remove(name);
      return interaction.reply({ content: ok ? `Removed **${name}**.` : `No stored player called **${name}**.`, ephemeral: true });
    }

    if (sub === 'list') {
      const roster = store.roster();
      const body = roster.map((p) => `\`${p.name.padEnd(12)}\` ${String(p.score + 'm').padStart(6)}  bear ${p.group}${p.locked ? '  [locked]' : ''}`);
      return interaction.reply({ content: `**${roster.length} players**\n` + body.join('\n'), ephemeral: true });
    }

    // =======================================================================
    // Map inspection
    // =======================================================================
    if (sub === 'map') {
      const lint = mapStore.check();
      return interaction.reply({
        content: mapStore.describe() + `\n\n_Free spots shown are 2x2 city slots. Need at least as many as you have players (${store.roster().length})._`,
        ephemeral: true,
      });
    }

    // =======================================================================
    // Planning
    // =======================================================================
    if (sub === 'plan') {
      await interaction.deferReply();
      const result = runPlan();
      const png = renderPNG(result, { title: 'Kingshot hive plan' });
      const file = new AttachmentBuilder(png, { name: 'hive-plan.png' });
      return interaction.editReply({
        content: `**Draft layout** - ${result.assignments.length} players\n${renderText(result)}`,
        files: [file],
      });
    }

    if (sub === 'publish') {
      await interaction.deferReply();
      const result = runPlan();
      if (!result.ok) {
        return interaction.editReply(`Cannot publish, ${result.errors.length} collision(s):\n` + result.errors.map((e) => `- ${e}`).join('\n'));
      }
      const png = renderPNG(result, { title: 'Kingshot hive - approved' });
      const channel = HUB_CHANNEL_ID ? await client.channels.fetch(HUB_CHANNEL_ID) : interaction.channel;
      const embed = new EmbedBuilder()
        .setTitle('Hive layout published')
        .setDescription('Each spot below is the lowest-X, lowest-Y tile of a 2x2 city.')
        .setColor(0x2563eb)
        .setTimestamp();
      if (result.warnings.length) embed.addFields({ name: 'Warnings', value: result.warnings.join('\n').slice(0, 1000) });
      await channel.send({ embeds: [embed], files: [new AttachmentBuilder(png, { name: 'hive-plan.png' })] });
      store.applyPlan(result);
      return interaction.editReply(`Published to <#${channel.id}> and saved as the current plan.`);
    }

    if (sub === 'lock') {
      const name = interaction.options.getString('name');
      const unlock = interaction.options.getBoolean('unlock');
      const spot = parseSpot(interaction.options.getString('spot'));
      const saved = store.upsert({ name, locked: !unlock, ...(spot ? { x: spot.x, y: spot.y } : {}) });
      return interaction.reply({
        content: unlock ? `Released **${saved.name}**.` : `Locked **${saved.name}**${spot ? ` to ${spot.x},${spot.y}` : ''} - run /hive plan to re-plan around them.`,
        ephemeral: true,
      });
    }

    if (sub === 'import') {
      const text = interaction.options.getString('text');
      const entries = [];
      const rejected = [];
      for (const line of text.split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        const m = raw.match(SCORE_LINE);
        if (!m) { rejected.push(raw); continue; }
        const score = parseScore(m[2]);
        if (score == null) { rejected.push(raw); continue; }
        entries.push({ name: m[1].trim(), score, group: m[3] ? parseGroup(m[3]) : undefined });
      }
      if (!entries.length) return interaction.reply({ content: 'No parsable lines found. Format: `Panda 1b Bear 1&2`', ephemeral: true });
      entries.forEach((e) => { if (!e.group) delete e.group; });
      store.upsertMany(entries);
      return interaction.reply({
        content: `Imported **${entries.length}** players.` + (rejected.length ? `\nSkipped ${rejected.length} line(s):\n${rejected.slice(0, 8).map((r) => `- \`${r}\``).join('\n')}` : ''),
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error(err);
    const message = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Auto-refresh: re-plan quietly when the roster or map changes
// ---------------------------------------------------------------------------
let dirty = false;
let timer = null;

function markDirty() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(refresh, 120000);
}

async function refresh() {
  if (!dirty || !HUB_CHANNEL_ID) return;
  dirty = false;
  try {
    const result = runPlan();
    const png = renderPNG(result, { title: 'Hive plan - refreshed' });
    const channel = await client.channels.fetch(HUB_CHANNEL_ID);
    await channel.send({
      content: 'Roster or map changed, here is the updated layout. Run `/hive publish` to make it official.',
      files: [new AttachmentBuilder(png, { name: 'hive-plan.png' })],
    });
  } catch (err) {
    console.error('Auto-refresh failed:', err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await deployCommands(); } catch (err) { console.error('Command deploy failed:', err.message); }
});

process.on('SIGINT', () => { store.save(); mapStore.save(); client.destroy(); process.exit(0); });

client.login(TOKEN);
