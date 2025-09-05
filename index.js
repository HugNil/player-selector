import dotenv from "dotenv";
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, "players.json");
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return {}; }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}
function ensureGuild(db, guildId) {
  if (!db[guildId]) db[guildId] = { players: [], taken: [] };
}

function renderList(players, taken) {
  if (!players.length) return "_(Inga spelare tillagda än)_";
  return players.map(p => (taken.includes(p) ? `✅ ${p}` : `⬜ ${p}`)).join("\n");
}

const BUTTONS_PER_ROW = 4;
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_MESSAGE = BUTTONS_PER_ROW * MAX_ROWS;
const LABEL_MAX = 20;

function truncLabel(name) {
  if (name.length <= LABEL_MAX) return name;
  return name.slice(0, LABEL_MAX - 1) + "…";
}

function computeChunks(playersLength) {
  const chunks = [];
  for (let start = 0; start < playersLength; start += MAX_BUTTONS_PER_MESSAGE) {
    chunks.push([start, Math.min(playersLength, start + MAX_BUTTONS_PER_MESSAGE)]);
  }
  return chunks;
}

function buildButtonsForChunk(players, taken, start, end, chunkIndex) {
  const rows = [];
  let rowBtns = [];

  for (let i = start; i < end; i++) {
    const name = players[i];
    const isTaken = taken.includes(name);
    const label = `${isTaken ? "✅" : "⬜"} ${truncLabel(name)}`;

    const btn = new ButtonBuilder()
      .setCustomId(`toggle:${i}:chunk:${chunkIndex}`)
      .setLabel(label)
      .setStyle(isTaken ? ButtonStyle.Success : ButtonStyle.Secondary);

    rowBtns.push(btn);

    if (rowBtns.length === BUTTONS_PER_ROW) {
      rows.push(new ActionRowBuilder().addComponents(rowBtns));
      rowBtns = [];
      if (rows.length === MAX_ROWS) break;
    }
  }

  if (rowBtns.length && rows.length < MAX_ROWS) {
    while (rowBtns.length < BUTTONS_PER_ROW) {
      rowBtns.push(
        new ButtonBuilder()
          .setCustomId(`spacer:${chunkIndex}:${rowBtns.length}:${Date.now()}`)
          .setLabel("\u200b")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
    }
    rows.push(new ActionRowBuilder().addComponents(rowBtns));
  }

  return rows;
}

async function upsertCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("spelare-add")
      .setDescription("Lägg till en spelare i listan")
      .addStringOption(o => o.setName("namn").setDescription("Spelarens namn").setRequired(true)),
    new SlashCommandBuilder()
      .setName("spelare-remove")
      .setDescription("Ta bort en spelare från listan")
      .addStringOption(o => o.setName("namn").setDescription("Spelarens namn (exakt)").setRequired(true)),
    new SlashCommandBuilder()
      .setName("spelare-list")
      .setDescription("Visa listan med spelare"),
    new SlashCommandBuilder()
      .setName("spelare-reset")
      .setDescription("Rensa alla spelare och avbockningar"),
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Visa alla spelare som knappar (20 per meddelande)"),
    new SlashCommandBuilder()
      .setName("spelare-move")
      .setDescription("Flytta en spelare till en annan position")
      .addStringOption(o => o.setName("namn").setDescription("Spelarens namn").setRequired(true))
      .addIntegerOption(o => o.setName("position").setDescription("Ny position (1 = högst upp)").setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Guild-kommandon uppdaterade.");
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Globala kommandon uppdaterade.");
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", (c) => {
  console.log(`Inloggad som ${c.user.tag}`);
  c.guilds.fetch().then(guilds => {
    const list = [...guilds.values()].map(g => `${g.name} (${g.id})`).join(", ") || "(inga)";
    console.log("Guilds jag är i:", list);
  });
});

client.on("interactionCreate", async (interaction) => {
  const db = loadDB();

  if (interaction.isChatInputCommand()) {
    ensureGuild(db, interaction.guildId);
    const g = db[interaction.guildId];

    try {
      if (interaction.commandName === "spelare-add") {
        const name = interaction.options.getString("namn").trim();
        if (!name) return interaction.reply({ content: "Ogiltigt namn.", ephemeral: true });
        if (g.players.includes(name)) {
          return interaction.reply({ content: `\`${name}\` finns redan.`, ephemeral: true });
        }
        g.players.push(name);
        saveDB(db);
        return interaction.reply({ content: `La till \`${name}\`.`, ephemeral: true });
      }

      if (interaction.commandName === "spelare-remove") {
        const name = interaction.options.getString("namn").trim();
        const idx = g.players.indexOf(name);
        if (idx === -1) {
          return interaction.reply({ content: `Hittade inte \`${name}\`.`, ephemeral: true });
        }
        g.players.splice(idx, 1);
        g.taken = g.taken.filter(p => p !== name);
        saveDB(db);
        return interaction.reply({ content: `Tog bort \`${name}\`.`, ephemeral: true });
      }

      if (interaction.commandName === "spelare-list") {
        const embed = new EmbedBuilder()
          .setTitle("Spelare")
          .setDescription(renderList(g.players, g.taken))
          .setColor(0x2b2d31);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "spelare-reset") {
        g.players = [];
        g.taken = [];
        saveDB(db);
        return interaction.reply({ content: "Listan nollställd.", ephemeral: true });
      }

      if (interaction.commandName === "panel") {
        const chunks = computeChunks(g.players.length);

        if (chunks.length === 0) {
          return interaction.reply({ content: "Inga spelare tillagda än.", ephemeral: true });
        }

        const [start0, end0] = chunks[0];
        const rows0 = buildButtonsForChunk(g.players, g.taken, start0, end0, 0);
        await interaction.reply({ content: "\u200b", components: rows0 });

        for (let ci = 1; ci < chunks.length; ci++) {
          const [start, end] = chunks[ci];
          const rows = buildButtonsForChunk(g.players, g.taken, start, end, ci);
          await interaction.followUp({ content: "\u200b", components: rows });
        }

        return;
      }

      if (interaction.commandName === "spelare-move") {
        const name = interaction.options.getString("namn").trim();
        const pos = interaction.options.getInteger("position");
        const idx = g.players.indexOf(name);

        if (idx === -1) {
          return interaction.reply({ content: `Hittade inte \`${name}\`.`, ephemeral: true });
        }
        if (pos < 1 || pos > g.players.length) {
          return interaction.reply({ content: `Position måste vara mellan 1 och ${g.players.length}.`, ephemeral: true });
        }

        g.players.splice(idx, 1);
        g.players.splice(pos - 1, 0, name);
        saveDB(db);

        return interaction.reply({ content: `Flyttade \`${name}\` till position ${pos}.`, ephemeral: true });
      }
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: "Något gick fel. Kolla loggen.", ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    const db2 = loadDB();
    ensureGuild(db2, interaction.guildId);
    const g = db2[interaction.guildId];

    try {
      const parts = interaction.customId.split(":");
      const kind = parts[0];

      if (kind === "toggle") {
        const absIndex = parseInt(parts[1], 10);
        const chunkIndex = parseInt(parts[3] || "0", 10);

        const name = g.players[absIndex];
        if (name) {
          const i = g.taken.indexOf(name);
          if (i >= 0) g.taken.splice(i, 1);
          else g.taken.push(name);
          saveDB(db2);
        }

        const chunks = computeChunks(g.players.length);
        const [start, end] = chunks[chunkIndex] || [0, 0];
        const rows = buildButtonsForChunk(g.players, g.taken, start, end, chunkIndex);

        await interaction.update({ content: "\u200b", components: rows });
        return;
      }
    } catch (e) {
      console.error(e);
      try { await interaction.reply({ content: "Kunde inte uppdatera panelen.", ephemeral: true }); } catch {}
    }
  }
});

(async () => {
  await upsertCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
