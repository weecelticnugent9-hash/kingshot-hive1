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
 *   /hive overlay  image anchor tilepx                  - draw your map over a screenshot
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
const { renderOverlay } = require('./overlay');
const { createPulse } = require('./pulse');
const advisor = require('./advisor');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const HUB_CHANNEL_ID = process.env.HIVE_CHANNEL_ID;

// Your alliance, used as the default for /hive sync and /hive spots.
const KID = Number(process.env.HIVE_KID || 511);
const TAG = process.env.HIVE_TAG || 'FAr';

if (!TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

const DATA_DIR = process.env.HIVE_DATA_DIR || path.join(__dirname, 'data');
const store = createStore(process.env.HIVE_DB || path.join(DATA_DIR, 'hive.json'));
const mapStore = createMapStore(process.env.HIVE_MAP || path.join(DATA_DIR, 'map.json'));

// MightPulse is optional: without the key the bot runs, and only the
// pulse-powered commands report that it is unavailable.
let pulseClient = null;
function getPulse() {
  if (pulseClient) return pulseClient;
  const key = process.env.MIGHTPULSE_KEY;
  if (!key) return null;
  try {
    pulseClient = createPulse(key, { cacheFile: path.join(DATA_DIR, 'pulse-cache.json') });
    return pulseClient;
  } catch (err) {
    console.error('MightPulse init failed:', err.message);
    return null;
  }
}

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
    .addSubcommand((s) => s.setName('map').setDescription('Show the hive map: bears, objects, blocked areas and free spots'))
    .addSubcommand((s) => s.setName('overlay').setDescription('Draw your stored map over a screenshot to check it matches')
      .addAttachmentOption((o) => o.setName('image').setDescription('Screenshot of the hive area (PNG)').setRequired(true))
      .addStringOption((o) => o.setName('anchor').setDescription('A visible coordinate on the image, e.g. X472 Y586').setRequired(true))
      .addNumberOption((o) => o.setName('tilepx').setDescription('Pixels per tile on your screenshot (measure one tile)').setRequired(true))
      .addNumberOption((o) => o.setName('anchorpx').setDescription('X pixel of that tile\'s bottom-left corner').setRequired(true))
      .addNumberOption((o) => o.setName('anchorpy').setDescription('Y pixel of that tile\'s bottom-left corner').setRequired(true)))
    .addSubcommand((s) => s.setName('sync').setDescription('Pull your alliance roster from MightPulse and update power/activity')
      .addBooleanOption((o) => o.setName('create').setDescription('Also create players who are not in the roster yet')))
    .addSubcommand((s) => s.setName('spots').setDescription('Read every member\'s map coordinates from MightPulse'))
    .addSubcommand((s) => s.setName('pulse').setDescription('Test the MightPulse connection and show the rate-limit usage')),

  new SlashCommandBuilder().setName('advisor').setDescription('What should this player upgrade next?')
    .addStringOption((o) => o.setName('governor_id').setDescription('Governor id (from their profile)').setRequired(true))
    .addIntegerOption((o) => o.setName('pieces').setDescription('Gear pieces they are actively pushing (for the Mithril threshold)').setMinValue(1).setMaxValue(12))
    .addIntegerOption((o) => o.setName('mithril').setDescription('Mithril they currently hold, for the red-gear advice'))
    .addIntegerOption((o) => o.setName('mythic_gear').setDescription('Mythic Gear they currently hold'))
    .addIntegerOption((o) => o.setName('forgehammers').setDescription('Forgehammers they currently hold'))
    .addIntegerOption((o) => o.setName('charm_guides').setDescription('Charm Guides they currently hold'))
    .addIntegerOption((o) => o.setName('charm_designs').setDescription('Charm Designs they currently hold'))
    .addStringOption((o) => o.setName('charms').setDescription('Charm levels, e.g. "inf 5, arch 3, cav 3"')),

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

    // =======================================================================
    // Advisor: what to upgrade next
    // =======================================================================
    if (interaction.commandName === 'advisor') {
      await interaction.deferReply();

      const client2 = getPulse();
      if (!client2) {
        return interaction.editReply('MIGHTPULSE_KEY is not set. Add it in Railway, then restart the service.');
      }

      const governorId = interaction.options.getString('governor_id');
      const pieces = interaction.options.getInteger('pieces') || 2;

      // Materials the API does not expose come from the options.
      const materials = {
        mithril: interaction.options.getInteger('mithril') || 0,
        mythicGear: interaction.options.getInteger('mythic_gear') || 0,
        forgehammers: interaction.options.getInteger('forgehammers') || 0,
        charmGuides: interaction.options.getInteger('charm_guides') || 0,
        charmDesigns: interaction.options.getInteger('charm_designs') || 0,
      };

      // Charm levels are typed: "inf 5, arch 3, cav 3"
      const charms = [];
      const charmText = interaction.options.getString('charms');
      if (charmText) {
        for (const part of charmText.split(/[,;]/)) {
          const m = part.trim().match(/^([a-z]+)\D*(\d+)/i);
          if (!m) continue;
          const troop = m[1].toLowerCase().startsWith('inf') ? 'Infantry'
            : m[1].toLowerCase().startsWith('arc') ? 'Archer'
              : m[1].toLowerCase().startsWith('cav') ? 'Cavalry' : m[1];
          charms.push({ troop, level: Number(m[2]) });
        }
      }

      let response;
      try {
        response = await client2.player(governorId, ['base', 'heroes', 'gov_gear']);
      } catch (err) {
        return interaction.editReply(`Could not read governor **${governorId}** from MightPulse: ${err.message}`);
      }

      const base = response.player || {};
      const state = advisor.stateFromPulse(response, { charms, materials, piecesPushing: pieces });

      if (!state.gear.length) {
        return interaction.editReply(
          `Read **${base.nick_name || governorId}** but no hero gear came back, so there is nothing to advise on.\n` +
          `MightPulse may not hold gear for this player yet.`
        );
      }

      const result = advisor.advise(state, { limit: 5 });

      return interaction.editReply(
        `**${base.nick_name || governorId}** - ${(base.power || 0).toLocaleString()} power, ` +
        `TC ${base.town_center_level || '?'}\n` +
        `Gear read: ${state.gear.length} piece(s), governor gear: ${state.govGear.length} piece(s)` +
        (charms.length ? `, charms: ${charms.length}` : ', charms: none supplied') + `\n\n` +
        advisor.formatAdvice(result, state)
      );
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
      await interaction.deferReply({ ephemeral: true });
      const roster = store.roster().sort((a, b) => (b.score || 0) - (a.score || 0));
      const page = Math.max(1, interaction.options.getInteger('page') || 1);
      const perPage = 18;
      const pages = Math.max(1, Math.ceil(roster.length / perPage));
      const slice = roster.slice((page - 1) * perPage, page * perPage);

      const rows = slice.map((p) => {
        const gov = p.governorId ? String(p.governorId) : '-';
        return `\`${p.name.slice(0, 14).padEnd(14)}\` ${String(p.score != null ? p.score + 'm' : '?').padStart(6)}  ${p.group}  ${gov}`;
      });

      return interaction.editReply(
        `**Roster** ${roster.length} players - page ${page}/${pages}\n` +
        `\`name           score  bear  governor_id\`\n` +
        (rows.length ? rows.join('\n') : '_no players on this page_') +
        (pages > 1 ? `\n\n_Next: \`/hive list page:${Math.min(page + 1, pages)}\`_` : '')
      );
    }

    if (sub === 'who') {
      await interaction.deferReply({ ephemeral: true });
      const needle = interaction.options.getString('name').trim().toLowerCase();
      const roster = store.roster();
      const hits = roster.filter((p) => (p.name || '').toLowerCase().includes(needle));

      if (!hits.length) {
        return interaction.editReply(`No stored player matching **${interaction.options.getString('name')}**. Run \`/hive sync\` to pull the alliance from MightPulse.`);
      }
      if (hits.length > 12) {
        return interaction.editReply(`**${hits.length}** matches - narrow it down. E.g. ${hits.slice(0, 6).map((h) => h.name).join(', ')}...`);
      }

      const blocks = hits.map((p) =>
        `**${p.name}**\n` +
        `governor_id: \`${p.governorId || 'unknown'}\`\n` +
        `power ${(p.power || 0).toLocaleString()}  TC ${p.townCenter || '?'}  bear ${p.group}  score ${p.score != null ? p.score + 'm' : 'unset'}` +
        (p.x != null ? `  spot ${p.x},${p.y}` : '')
      );
      return interaction.editReply(blocks.join('\n\n') + '\n\n_Copy the governor_id into `/advisor`._');
    }

    // =======================================================================
    // Map inspection
    // =======================================================================
    if (sub === 'map') {
      return interaction.reply({
        content: mapStore.describe() + `\n\n_Free spots shown are 2x2 city slots. Need at least as many as you have players (${store.roster().length})._`,
        ephemeral: true,
      });
    }

    // =======================================================================
    // Overlay: draw the stored map over a screenshot
    // =======================================================================
    if (sub === 'overlay') {
      await interaction.deferReply();
      const attachment = interaction.options.getAttachment('image');
      const anchorCoord = parseSpot(interaction.options.getString('anchor'));
      if (!anchorCoord) {
        return interaction.editReply('Could not read the anchor. Use `X472 Y586`.');
      }
      const tilePx = interaction.options.getNumber('tilepx');
      const anchorPx = interaction.options.getNumber('anchorpx');
      const anchorPy = interaction.options.getNumber('anchorpy');

      if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
        return interaction.editReply('That attachment is not an image.');
      }
      if (attachment.contentType === 'image/jpeg') {
        return interaction.editReply(
          'That is a JPEG, and Discord converts screenshots to JPEG on upload. ' +
          'Send it as a PNG file instead - on iOS, use Share → Save to Files first, or re-save it as PNG.'
        );
      }
      if (attachment.size > 8 * 1024 * 1024) {
        return interaction.editReply('That image is larger than 8 MB. Crop it to the hive area and try again.');
      }

      const res = await fetch(attachment.url);
      const bytes = Buffer.from(await res.arrayBuffer());

      const out = renderOverlay(bytes, mapStore.get(), {
        x: anchorCoord.x,
        y: anchorCoord.y,
        px: anchorPx,
        py: anchorPy,
        tilePx,
      }, { players: store.roster().filter((p) => p.x != null && p.y != null) });

      const file = new AttachmentBuilder(out.png, { name: 'hive-overlay.png' });
      return interaction.editReply({
        content:
          `Drew **${out.drawn.objects}** object(s), **${out.drawn.blocked}** blockage(s), **${out.drawn.bears}** bear(s)` +
          (out.drawn.players ? ` and **${out.drawn.players}** stored player spot(s)` : '') +
          ` over your ${out.imageSize.width}x${out.imageSize.height} image.\n` +
          `The **red box** marks the anchor - if it is not sitting on the tile you named, adjust \`anchorpx\`/\`anchorpy\` or \`tilepx\` and run it again.`,
        files: [file],
      });
    }

    // =======================================================================
    // MightPulse: connection test
    // =======================================================================
    if (sub === 'pulse') {
      await interaction.deferReply({ ephemeral: true });
      const client2 = getPulse();
      if (!client2) {
        return interaction.editReply('MIGHTPULSE_KEY is not set. Add it in Railway, then restart the service.');
      }
      try {
        const k = await client2.kingdom(KID);
        return interaction.editReply(
          `MightPulse is reachable.\n` +
          `Kingdom **${KID}**: ${(k.name || 'unnamed')} - ${k.player_count ?? '?'} players, ${k.alliance_count ?? '?'} alliances.\n` +
          `Requests this minute: **${client2.rateStats.lastMinute}/60**, today: **${client2.rateStats.today}/5000**.`
        );
      } catch (err) {
        return interaction.editReply(`MightPulse call failed: ${err.message}`);
      }
    }

    // =======================================================================
    // MightPulse: roster sync (roster first, positions separate)
    // =======================================================================
    if (sub === 'sync') {
      await interaction.deferReply();
      const client2 = getPulse();
      if (!client2) {
        return interaction.editReply('MIGHTPULSE_KEY is not set. Add it in Railway, then restart the service.');
      }

      const tag = interaction.options.getString('tag') || TAG;
      const kid = interaction.options.getInteger('kingdom') || KID;
      const create = interaction.options.getBoolean('create') !== false;

      let members;
      try {
        members = await client2.roster(kid, tag);
      } catch (err) {
        return interaction.editReply(
          `Could not read alliance **${tag}** in kingdom **${kid}**: ${err.message}\n` +
          `Check the tag is the in-game abbreviation (case-sensitive) and the kingdom id is right.`
        );
      }
      if (!members.length) {
        return interaction.editReply(`Alliance **${tag}** in kingdom **${kid}** returned no members. Check the tag.`);
      }

      const before = store.roster();
      const known = new Set(before.map((p) => p.name.toLowerCase()));
      let created = 0, updated = 0;
      const addedNames = [];

      for (const m of members) {
        const isNew = !known.has(m.name.toLowerCase());
        if (isNew && !create) continue;
        store.upsert({
          name: m.name,
          ...(isNew ? { group: '1' } : {}),
          power: m.power,
          townCenter: m.townCenter,
          kills: m.kills,
          rank: m.rankLabel,
          lastActive: m.lastActive,
          governorId: String(m.governorId || ''),
        });
        if (isNew) { created++; addedNames.push(m.name); } else { updated++; }
      }

      const after = store.roster();
      return interaction.editReply(
        `Synced **${tag}** (kingdom ${kid}) from MightPulse.\n` +
        `**${members.length}** members found - ${created} added, ${updated} updated.\n` +
        `Roster now holds **${after.length}** players.\n` +
        (addedNames.length ? `New: ${addedNames.slice(0, 20).join(', ')}${addedNames.length > 20 ? ` +${addedNames.length - 20} more` : ''}\n` : '') +
        `\nBear scores are not in the API, so set those with \`/hive import\` or \`/hive score\`. ` +
        `Run \`/hive spots\` separately to pull map coordinates.`
      );
    }

    // =======================================================================
    // MightPulse: coordinates
    // =======================================================================
    if (sub === 'spots') {
      await interaction.deferReply();
      const client2 = getPulse();
      if (!client2) {
        return interaction.editReply('MIGHTPULSE_KEY is not set. Add it in Railway, then restart the service.');
      }

      const tag = interaction.options.getString('tag') || TAG;
      const kid = interaction.options.getInteger('kingdom') || KID;

      let members;
      try {
        members = await client2.roster(kid, tag);
      } catch (err) {
        return interaction.editReply(`Could not read alliance **${tag}**: ${err.message}`);
      }

      const found = [];
      const missing = [];
      for (const m of members) {
        try {
          const res = await client2.player(m.governorId, ['base']);
          const pl = res.player || {};
          if (pl.x != null && pl.y != null) {
            store.upsert({ name: m.name, x: pl.x, y: pl.y, governorId: String(m.governorId || '') });
            found.push(`${m.name} ${pl.x},${pl.y}`);
          } else {
            missing.push(m.name);
          }
        } catch (err) {
          missing.push(m.name);
        }
      }

      return interaction.editReply(
        `Read coordinates for **${found.length}** of **${members.length}** members.\n` +
        (found.length ? '```\n' + found.slice(0, 25).join('\n') + (found.length > 25 ? `\n+${found.length - 25} more` : '') + '\n```\n' : '') +
        (missing.length ? `No coordinates returned for: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ` +${missing.length - 15} more` : ''}\n` : '') +
        `\nRun \`/hive plan\` - stored spots are now used by the planner.`
      );
    }

    // =======================================================================
    // Planning
    // =======================================================================
    if (sub === 'plan') {
      await interaction.deferReply();
      const result = runPlan();
      const png = renderPNG(result, { title: 'Kingshot hive plan' });
      const file = new AttachmentBuilder(png, { name: 'hive-plan.png' });
      const seatNote = result.minScore != null
        ? `Seating **${result.seated}** players above **${result.minScore}m** - ${result.excluded} left out.\n`
        : '';
      return interaction.editReply({
        content: `**Draft layout** - ${result.assignments.length} players\n${seatNote}${renderText(result)}`,
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
