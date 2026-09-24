'use strict';

/**
 * kingshot-hive/bot.js
 * Discord layer. Reads and updates the roster, runs the planner, posts results.
 *
 *   npm install discord.js
 *   DISCORD_TOKEN=... node bot.js
 *
 * Slash commands:
 *   /hive set      name:<name> score:<millions> bear:<1|2|both> [activity:0-1] [spot:477,587]
 *   /hive score    name:<name> score:<millions>          - fast path, bulk score updates
 *   /hive remove   name:<name>
 *   /hive list                                           - show the stored roster
 *   /hive plan     [dry_run:true]                        - compute and display
 *   /hive publish                                        - post the PNG and apply the plan
 *   /hive lock     name:<name> spot:<X,Y>                - pin someone, then re-plan
 *   /hive import   paste a score list                    - bulk upsert from the screenshot format
 */

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');

const hive = require('./hive');
const { createStore } = require('./store');
const { renderPNG, renderText } = require('./render');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;          // for instant command deploy
const HUB_CHANNEL_ID = process.env.HIVE_CHANNEL_ID;     // where publish posts

if (!TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

const store = createStore(process.env.HIVE_DB || path.join(__dirname, 'data', 'hive.json'));

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName('hive').setDescription('Kingshot hive placement')
    .addSubcommand((s) => s.setName('set').setDescription('Add or update a player')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true))
      .addIntegerOption((o) => o.setName('score').setDescription('Bear score in millions (e.g. 1000 = 1 billion)').setRequired(true))
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
      .addStringOption((o) => o.setName('text').setDescription('One player per line: Name 100m Bear 1').setRequired(true))),
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
  return Math.round(num); // already millions
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
  return hive.planHive(roster);
}

// ---------------------------------------------------------------------------
// Interaction handling
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'hive') return;
  const sub = interaction.options.getSubcommand();

  try {
    // ----------------------------------------------------------------- set
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

    // -------------------------------------------------------------- remove
    if (sub === 'remove') {
      const name = interaction.options.getString('name');
      const ok = store.remove(name);
      return interaction.reply({ content: ok ? `Removed **${name}**.` : `No stored player called **${name}**.`, ephemeral: true });
    }

    // ---------------------------------------------------------------- list
    if (sub === 'list') {
      const roster = store.roster();
      const body = roster.map((p) => `\`${p.name.padEnd(12)}\` ${String(p.score + 'm').padStart(6)}  bear ${p.group}${p.locked ? '  [locked]' : ''}`);
      return interaction.reply({ content: `**${roster.length} players**\n` + body.join('\n'), ephemeral: true });
    }

    // ---------------------------------------------------------------- plan
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

    // ------------------------------------------------------------- publish
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
        .setDescription('Spots below are the lowest-X, lowest-Y tile of each 2x2 city.')
        .setColor(0x2563eb)
        .setTimestamp();
      if (result.warnings.length) embed.addFields({ name: 'Warnings', value: result.warnings.join('\n').slice(0, 1000) });
      await channel.send({ embeds: [embed], files: [new AttachmentBuilder(png, { name: 'hive-plan.png' })] });
      store.applyPlan(result);
      return interaction.editReply(`Published to <#${channel.id}> and saved as the current plan.`);
    }

    // ---------------------------------------------------------------- lock
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

    // -------------------------------------------------------------- import
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
      if (!entries.length) return interaction.reply({ content: 'No parsable lines found.', ephemeral: true });
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
// Auto-refresh: re-plan quietly when the roster changes enough
// ---------------------------------------------------------------------------
let dirty = false;
let timer = null;

function markDirty() {
  dirty = true;
  clearTimeout(timer);
  // Debounce: a burst of /hive score calls triggers one re-plan, not ten.
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
      content: 'Roster changed, here is the updated layout. Run `/hive publish` to make it official.',
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

process.on('SIGINT', () => { store.save(); client.destroy(); process.exit(0); });

client.login(TOKEN);
