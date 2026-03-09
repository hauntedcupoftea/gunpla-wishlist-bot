/**
 * @module index
 *
 * Unified entrypoint for the Haro application.
 *
 * Starts two long-running services from a single Deno process:
 * 1. The Discord bot (discord.js client, slash command registration)
 * 2. The Elysia HTTP API server (REST endpoints + Discord OAuth)
 *
 * Both services share the same Prisma client instance and service layer.
 * Neither service is aware of the other — they communicate only through
 * the shared database.
 */

import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	ActivityType,
	Client,
	Collection,
	GatewayIntentBits,
	Partials,
	REST,
	Routes,
} from "discord.js";
import type { Command } from "./bot/lib/command.ts";
import { env } from "./lib/env.ts";

declare module "discord.js" {
	interface Client {
		commands: Collection<string, Command>;
	}
}

const client = new Client({
	intents: [GatewayIntentBits.Guilds],
	partials: [Partials.Channel],
});

client.commands = new Collection();
const commands: unknown[] = [];

const commandsPath = path.join(import.meta.dirname ?? "", "bot", "commands");
const commandFiles = fs
	.readdirSync(commandsPath)
	.filter((file) => file.endsWith(".ts"));

for (const file of commandFiles) {
	const filePath = path.join(commandsPath, file);
	const fileUrl = pathToFileURL(filePath).href;
	const mod = await import(fileUrl);
	const command: Command = mod.default ?? mod;

	if ("data" in command && "execute" in command) {
		client.commands.set(command.data.name, command);
		commands.push(command.data.toJSON());
		console.log(`[bot] Loaded command: ${command.data.name}`);
	} else {
		console.warn(`[bot] Skipping ${file} — missing "data" or "execute".`);
	}
}

const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

(async () => {
	try {
		console.log("[bot] Registering application (/) commands…");

		if (env.GUILD_ID) {
			const data = (await rest.put(
				Routes.applicationGuildCommands(env.APPLICATION_ID, env.GUILD_ID),
				{ body: commands },
			)) as unknown[];
			console.log(
				`[bot] Registered ${data.length} guild commands (${env.GUILD_ID}).`,
			);
		} else {
			const data = (await rest.put(
				Routes.applicationCommands(env.APPLICATION_ID),
				{ body: commands },
			)) as unknown[];
			console.log(`[bot] Registered ${data.length} global commands.`);
		}
	} catch (err) {
		console.error("[bot] Failed to register commands:", err);
	}
})();

client.on("interactionCreate", async (interaction) => {
	if (interaction.isChatInputCommand()) {
		const command = client.commands.get(interaction.commandName);
		if (!command) return;

		try {
			await command.execute(interaction);
		} catch (err) {
			console.error(`[bot] Error in /${interaction.commandName}:`, err);
			const payload = {
				content: "❌ Something went wrong executing this command.",
				ephemeral: true,
			} as const;
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp(payload);
			} else {
				await interaction.reply(payload);
			}
		}
	} else if (interaction.isAutocomplete()) {
		const command = client.commands.get(interaction.commandName);
		if (!command?.autocomplete) return;

		try {
			await command.autocomplete(interaction);
		} catch (err) {
			console.error(
				`[bot] Autocomplete error in /${interaction.commandName}:`,
				err,
			);
		}
	}
});

client.once("clientReady", () => {
	console.log(`[bot] Logged in as ${client.user?.tag}`);
	client.user?.setActivity("group buys", { type: ActivityType.Watching });
});

try {
	const { startApi } = await import("./api/index.ts");
	await startApi();
} catch (err) {
	console.warn("[api] Failed to start API server:", err);
	console.warn("[api] Bot will continue running without the API.");
}

await client.login(env.DISCORD_TOKEN);
