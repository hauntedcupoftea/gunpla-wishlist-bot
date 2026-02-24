import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";

export default {
	data: new SlashCommandBuilder()
		.setName("kit")
		.setDescription("Kit commands")
		.addSubcommand((sub) =>
			sub
				.setName("wanted")
				.setDescription("See which members have a kit on their wishlist")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("Kit to look up")
						.setRequired(true)
						.setAutocomplete(true),
				),
		),

	async autocomplete(interaction) {
		const focused = interaction.options.getString("kit") ?? "";

		if (focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		const results = await prisma.kit.findMany({
			where: {
				product_name: { contains: focused, mode: "insensitive" },
			},
			take: 5,
		});

		await interaction.respond(
			results.map((k) => ({ name: k.product_name, value: k.id })),
		);
	},

	async execute(interaction) {
		const kitId = interaction.options.getString("kit", true);

		const kit = await prisma.kit.findUnique({ where: { id: kitId } });

		if (!kit) {
			await interaction.reply({
				content: "Kit not found.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const wishlists = await prisma.wishlist.findMany({
			where: { kitId },
		});

		if (wishlists.length === 0) {
			await interaction.reply(
				`Nobody has **${kit.product_name}** on their wishlist yet.`,
			);
			return;
		}

		const userList = wishlists.map((w) => `- <@${w.userId}>`).join("\n");
		await interaction.reply(
			`Members wanting **${kit.product_name}** (${wishlists.length}):\n${userList}`,
		);
	},
} satisfies Command;
