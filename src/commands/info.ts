import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";

export default {
	data: new SlashCommandBuilder()
		.setName("kit")
		.setDescription("Kit commands")
		.addSubcommand((sub) =>
			sub
				.setName("info")
				.setDescription("Search for a kit and view its details")
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

		const wishlistCount = await prisma.wishlist.count({
			where: { kitId: kit.id },
		});

		const embed = new EmbedBuilder()
			.setTitle(kit.product_name)
			.setColor(0x2b82cb)
			.addFields(
				{ name: "Item Code", value: kit.item_code, inline: true },
				{
					name: "Price (JPY)",
					value: `¥${kit.jpy_price.toLocaleString()}`,
					inline: true,
				},
				{ name: "Availability", value: kit.availability, inline: true },
				{
					name: "Release Date",
					value: kit.release_date ?? "Unknown",
					inline: true,
				},
				{
					name: "Stock Status",
					value: kit.stock_status ?? "Unknown",
					inline: true,
				},
				{
					name: "Weight",
					value: kit.weight_grams ? `${kit.weight_grams}g` : "Unknown",
					inline: true,
				},
				{
					name: "Wishlisted by",
					value: `${wishlistCount} member${wishlistCount !== 1 ? "s" : ""}`,
					inline: true,
				},
			);

		await interaction.reply({ embeds: [embed] });
	},
} satisfies Command;
