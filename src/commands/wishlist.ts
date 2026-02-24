import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";

export default {
	data: new SlashCommandBuilder()
		.setName("wishlist")
		.setDescription("Manage your wishlist")
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Add a kit to your wishlist")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("The kit to add")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove")
				.setDescription("Remove a kit from your wishlist")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("The kit to remove")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)
		.addSubcommand((sub) =>
			sub.setName("view").setDescription("View your wishlist"),
		),

	async autocomplete(interaction) {
		const focused = interaction.options.getString("kit") ?? "";
		const subcommand = interaction.options.getSubcommand();

		if (focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		if (subcommand === "add") {
			const results = await prisma.kit.findMany({
				where: {
					product_name: { contains: focused, mode: "insensitive" },
				},
				take: 5,
			});
			await interaction.respond(
				results.map((k) => ({ name: k.product_name, value: k.id })),
			);
		} else if (subcommand === "remove") {
			// Only show kits the user actually has wishlisted
			const results = await prisma.wishlist.findMany({
				where: {
					userId: interaction.user.id,
					kit: {
						product_name: { contains: focused, mode: "insensitive" },
					},
				},
				include: { kit: true },
				take: 5,
			});
			await interaction.respond(
				results.map((w) => ({ name: w.kit.product_name, value: w.kitId })),
			);
		} else {
			await interaction.respond([]);
		}
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === "add") {
			const kitId = interaction.options.getString("kit", true);

			try {
				await prisma.wishlist.create({
					data: { userId: interaction.user.id, kitId },
				});
				const kit = await prisma.kit.findUnique({ where: { id: kitId } });
				await interaction.reply({
					content: `Added **${kit?.product_name}** to your wishlist!`,
					flags: MessageFlags.Ephemeral,
				});
			} catch {
				await interaction.reply({
					content: "That kit is already on your wishlist.",
					flags: MessageFlags.Ephemeral,
				});
			}
		} else if (subcommand === "remove") {
			const kitId = interaction.options.getString("kit", true);

			const result = await prisma.wishlist.deleteMany({
				where: { userId: interaction.user.id, kitId },
			});

			if (result.count > 0) {
				const kit = await prisma.kit.findUnique({ where: { id: kitId } });
				await interaction.reply({
					content: `Removed **${kit?.product_name}** from your wishlist.`,
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.reply({
					content: "That kit isn't on your wishlist.",
					flags: MessageFlags.Ephemeral,
				});
			}
		} else if (subcommand === "view") {
			const wishlists = await prisma.wishlist.findMany({
				where: { userId: interaction.user.id },
				include: { kit: true },
				orderBy: { createdAt: "asc" },
			});

			if (wishlists.length === 0) {
				await interaction.reply({
					content: "Your wishlist is empty.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const lines = wishlists
				.map(
					(w) =>
						`- **${w.kit.product_name}** (¥${w.kit.jpy_price.toLocaleString()})`,
				)
				.join("\n");

			await interaction.reply({
				content: `Your wishlist (${wishlists.length} kit${wishlists.length !== 1 ? "s" : ""}):\n${lines}`,
				flags: MessageFlags.Ephemeral,
			});
		}
	},
} satisfies Command;
