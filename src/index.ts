import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	ActivityType,
	Client,
	Collection,
	GatewayIntentBits,
	REST,
	Routes,
} from "discord.js";
import type { Command } from "./lib/command.ts";
import { MessageFlags } from "discord.js";

declare module "discord.js" {
	interface Client {
		commands: Collection<string, Command>;
	}
}

const client = new Client({
	intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
const commands: unknown[] = [];
const commandsPath = path.join(import.meta.dirname ?? "", "commands");

const commandFiles = fs
	.readdirSync(commandsPath)
	.filter((file) => file.endsWith(".ts"));

for (const file of commandFiles) {
	const filePath = path.join(commandsPath, file);
	const fileUrl = pathToFileURL(filePath).href;
	const commandModule = await import(fileUrl);
	const command: Command = commandModule.default || commandModule;

	if ("data" in command && "execute" in command) {
		client.commands.set(command.data.name, command);
		commands.push(command.data.toJSON());
		console.log(`Loaded command: ${command.data.name}`);
	} else {
		console.warn(
			`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
		);
	}
}

const token = Deno.env.get("DISCORD_TOKEN");
const appId = Deno.env.get("APPLICATION_ID");
const guildId = Deno.env.get("GUILD_ID");

if (!token || !appId) {
	throw new Error(
		"Missing DISCORD_TOKEN or APPLICATION_ID in environment variables.",
	);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
	try {
		console.log("Started refreshing application (/) commands.");
		let data: unknown;

		if (guildId) {
			data = await rest.put(Routes.applicationGuildCommands(appId, guildId), {
				body: commands,
			});
			console.log(
				`Successfully reloaded ${data.length} guild-specific application (/) commands.`,
			);
		} else {
			// Global commands
			data = await rest.put(Routes.applicationCommands(appId), {
				body: commands,
			});
			console.log(
				`Successfully reloaded ${data.length} global application (/) commands.`,
			);
		}
	} catch (error) {
		console.error("Error refreshing commands:", error);
	}
})();

client.on("interactionCreate", async (interaction) => {
	if (interaction.isChatInputCommand()) {
		const command = client.commands.get(interaction.commandName);
		if (!command) return;

		try {
			await command.execute(interaction);
		} catch (error) {
			console.error(error);
			await interaction.reply({
				content: "There was an error while executing this command!",
				flags: MessageFlags.Ephemeral,
			});
		}
	} else if (interaction.isAutocomplete()) {
		const command = client.commands.get(interaction.commandName);
		if (!command) return;

		try {
			if (command.autocomplete) await command.autocomplete(interaction);
		} catch (error) {
			console.error(error);
		}
	}
});

client.once("clientReady", () => {
	console.log("Bot is starting up...");
	setTimeout(() => {
		console.log("Bot is now ready!");
		client.user?.setActivity("commands", { type: ActivityType.Listening });
	}, 5000);
});

client.login(token);
