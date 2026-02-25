import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";
import { icontains } from "../lib/util.ts";

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
				)
				.addIntegerOption((o) =>
					o
						.setName("weight_grams")
						.setDescription(
							"Kit weight in grams (used for shipping cost split)",
						)
						.setRequired(true),
				),
		)
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
		)
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
		const subcommand = interaction.options.getSubcommand();
		const focused = interaction.options.getString("kit") ?? "";

		// "add" has no autocomplete
		if (subcommand === "add" || focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		const results = await prisma.kit.findMany({
			where: {
				product_name: icontains(focused),
			},
			take: 5,
		});

		await interaction.respond(
			results.map((k) => ({ name: k.product_name, value: k.id })),
		);
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === "add") {
			const productName = interaction.options.getString("product_name", true);
			const jpyPrice = interaction.options.getInteger("jpy_price", true);
			const availability = interaction.options.getString("availability", true);
			const itemCode =
				interaction.options.getString("item_code") ?? productName;
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
						weight_grams: interaction.options.getInteger("weight_grams", true),
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
		} else if (subcommand === "info") {
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
		} else if (subcommand === "wanted") {
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
		}
	},
} satisfies Command;
