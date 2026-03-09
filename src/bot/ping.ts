import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with Pong and shows latency!"),

  async execute(interaction) {
    const response = await interaction.reply({
      content: "Pinging...",
      withResponse: true,
    });
    const message = response.resource?.message;
    if (!message) return;
    const roundTripLatency = message.createdTimestamp -
      interaction.createdTimestamp;
    await interaction.editReply(
      `Pong! 🏓\nRound-trip latency: ${roundTripLatency}ms\nAPI Latency: ${interaction.client.ws.ping}ms`,
    );
  },
} satisfies Command;
