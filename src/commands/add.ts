import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";

export default {
	data: new SlashCommandBuilder()
		.setName("kit")
		.setDescription("Kit commands")
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Add a new kit to the database")
				.addStringOption((o) =>
					o
						.setName("product_name")
						.setDescription("The full name of the kit")
						.setRequired(true),
				)
				.addIntegerOption((o) =>
					o
						.setName("jpy_price")
						.setDescription("Price in JPY (use MSRP where possible)")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("availability")
						.setDescription("Availability status or source")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("item_code")
						.setDescription(
							"Item code (e.g. BAN123456). Defaults to product name if omitted.",
						)
						.setRequired(false),
				)
				.addStringOption((o) =>
					o
						.setName("release_date")
						.setDescription('Release date (e.g. "September 2024")')
						.setRequired(false),
				)
				.addStringOption((o) =>
					o
						.setName("stock_status")
						.setDescription("Stock status")
						.setRequired(false),
				),
		),

	async execute(interaction) {
		const productName = interaction.options.getString("product_name", true);
		const jpyPrice = interaction.options.getInteger("jpy_price", true);
		const availability = interaction.options.getString("availability", true);
		const itemCode = interaction.options.getString("item_code") ?? productName;
		const releaseDate = interaction.options.getString("release_date");
		const stockStatus = interaction.options.getString("stock_status");

		try {
			const newKit = await prisma.kit.create({
				data: {
					product_name: productName,
					jpy_price: jpyPrice,
					availability,
					item_code: itemCode,
					release_date: releaseDate,
					stock_status: stockStatus,
				},
			});

			await interaction.reply(
				`Successfully added **${newKit.product_name}** to the database!`,
			);
		} catch (error: unknown) {
			console.error(error);
			const isDupe =
				error instanceof Error && error.message.includes("Unique constraint");

			await interaction.reply({
				content: isDupe
					? `A kit with item code \`${itemCode}\` already exists.`
					: "There was an error while adding the kit.",
				flags: MessageFlags.Ephemeral,
			});
		}
	},
} satisfies Command;
