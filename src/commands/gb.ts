import {
	type ChatInputCommandInteraction,
	EmbedBuilder,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import type {
	GroupBuy,
	GroupBuyKit,
	Kit,
} from "../../generated/client/client.ts";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";

async function getGbForThread(interaction: ChatInputCommandInteraction) {
	const gb = await prisma.groupBuy.findUnique({
		where: { threadId: interaction.channelId },
		include: {
			kits: { include: { kit: true } },
			claims: true,
		},
	});

	if (!gb) {
		await interaction.reply({
			content:
				"No group buy found for this thread. Use `/gb create` to start one.",
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	return gb;
}

type GbWithKits = GroupBuy & { kits: (GroupBuyKit & { kit: Kit })[] };

function buildGbEmbed(gb: GbWithKits): EmbedBuilder {
	const statusEmoji: Record<string, string> = {
		OPEN: "🟢",
		LOCKED: "🔒",
		PURCHASED: "🛒",
		AT_WAREHOUSE: "🏭",
		SHIPPED: "🚢",
		AT_CUSTOMS: "🛃",
		CLEARED_CUSTOMS: "✅",
		AT_RECEIVER: "📦",
		COMPLETED: "🎉",
		CANCELLED: "❌",
	};

	const kitLines =
		gb.kits.length > 0
			? gb.kits
					.map(
						(gbk) =>
							`- **${gbk.kit.product_name}** (¥${gbk.kit.jpy_price.toLocaleString()})`,
					)
					.join("\n")
			: "_No kits added yet._";

	const embed = new EmbedBuilder()
		.setTitle("Group Buy Summary")
		.setColor(0x2b82cb)
		.addFields(
			{
				name: "Status",
				value: `${statusEmoji[gb.status] ?? "❓"} ${gb.status}`,
				inline: true,
			},
			{ name: "Organiser", value: `<@${gb.ownerId}>`, inline: true },
			{
				name: "Buyer",
				value: gb.buyerId ? `<@${gb.buyerId}>` : "_Not set_",
				inline: true,
			},
			{
				name: "Receiver",
				value: gb.receiverId ? `<@${gb.receiverId}>` : "_Not set_",
				inline: true,
			},
			{ name: `Kits (${gb.kits.length})`, value: kitLines },
		);

	// Financials — only show once data exists
	const financialLines: string[] = [];
	if (gb.costPrice)
		financialLines.push(`Kit cost: ¥${gb.costPrice.toLocaleString()}`);
	if (gb.shippingCost)
		financialLines.push(`Shipping: ¥${gb.shippingCost.toLocaleString()}`);
	if (gb.customsCost)
		financialLines.push(`Customs: ¥${gb.customsCost.toLocaleString()}`);
	if (gb.inrConversionRate)
		financialLines.push(`Rate: ¥1 = ₹${gb.inrConversionRate}`);

	if (financialLines.length > 0) {
		embed.addFields({ name: "Financials", value: financialLines.join("\n") });
	}

	// Tracking
	const trackingLines: string[] = [];
	if (gb.shippingTrackingUrl)
		trackingLines.push(`[Shipping tracking](${gb.shippingTrackingUrl})`);
	if (gb.customsTrackingUrl)
		trackingLines.push(`[Customs tracking](${gb.customsTrackingUrl})`);

	if (trackingLines.length > 0) {
		embed.addFields({ name: "Tracking", value: trackingLines.join("\n") });
	}

	embed.setFooter({ text: `GB ID: ${gb.id}` }).setTimestamp();

	return embed;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export default {
	data: new SlashCommandBuilder()
		.setName("gb")
		.setDescription("Group buy commands")

		// /gb create
		.addSubcommand((sub) =>
			sub
				.setName("create")
				.setDescription("Create a group buy in this forum thread"),
		)

		// /gb info
		.addSubcommand((sub) =>
			sub
				.setName("info")
				.setDescription("View the group buy summary for this thread"),
		)

		// /gb addkit
		.addSubcommand((sub) =>
			sub
				.setName("addkit")
				.setDescription("Add a kit to this group buy (organiser only)")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("Kit to add")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)

		// /gb removekit
		.addSubcommand((sub) =>
			sub
				.setName("removekit")
				.setDescription("Remove a kit from this group buy (organiser only)")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("Kit to remove")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)

		// /gb setbuyer
		.addSubcommand((sub) =>
			sub
				.setName("setbuyer")
				.setDescription(
					"Set the payment handler for this group buy (organiser only)",
				)
				.addUserOption((o) =>
					o.setName("user").setDescription("The buyer").setRequired(true),
				),
		)

		// /gb setreceiver
		.addSubcommand((sub) =>
			sub
				.setName("setreceiver")
				.setDescription(
					"Set the parcel receiver for this group buy (organiser only)",
				)
				.addUserOption((o) =>
					o.setName("user").setDescription("The receiver").setRequired(true),
				),
		)

		// /gb transfer
		.addSubcommand((sub) =>
			sub
				.setName("transfer")
				.setDescription("Transfer group buy ownership (organiser only)")
				.addUserOption((o) =>
					o.setName("user").setDescription("New organiser").setRequired(true),
				),
		)

		// /gb setstatus
		.addSubcommand((sub) =>
			sub
				.setName("setstatus")
				.setDescription("Update the group buy status (organiser only)")
				.addStringOption((o) =>
					o
						.setName("status")
						.setDescription("New status")
						.setRequired(true)
						.addChoices(
							{ name: "🟢 Open", value: "OPEN" },
							{ name: "🔒 Locked", value: "LOCKED" },
							{ name: "🛒 Purchased", value: "PURCHASED" },
							{ name: "🏭 At Warehouse", value: "AT_WAREHOUSE" },
							{ name: "🚢 Shipped", value: "SHIPPED" },
							{ name: "🛃 At Customs", value: "AT_CUSTOMS" },
							{ name: "✅ Cleared Customs", value: "CLEARED_CUSTOMS" },
							{ name: "📦 At Receiver", value: "AT_RECEIVER" },
							{ name: "🎉 Completed", value: "COMPLETED" },
							{ name: "❌ Cancelled", value: "CANCELLED" },
						),
				),
		)

		// /gb setprice
		.addSubcommand((sub) =>
			sub
				.setName("setprice")
				.setDescription(
					"Set the total cost price and INR conversion rate (organiser/buyer only)",
				)
				.addIntegerOption((o) =>
					o
						.setName("cost_price")
						.setDescription("Total paid to supplier in JPY")
						.setRequired(true),
				)
				.addNumberOption((o) =>
					o
						.setName("inr_rate")
						.setDescription("JPY → INR conversion rate (e.g. 0.57)")
						.setRequired(true),
				),
		)

		// /gb setshipping
		.addSubcommand((sub) =>
			sub
				.setName("setshipping")
				.setDescription(
					"Set shipping cost, actual parcel weight and tracking (organiser/buyer only)",
				)
				.addIntegerOption((o) =>
					o
						.setName("shipping_cost")
						.setDescription("Total international shipping cost in JPY")
						.setRequired(true),
				)
				.addIntegerOption((o) =>
					o
						.setName("shipping_weight")
						.setDescription("Actual courier-weighed parcel weight in grams")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("tracking_number")
						.setDescription("Shipping tracking number")
						.setRequired(false),
				)
				.addStringOption((o) =>
					o
						.setName("tracking_url")
						.setDescription("Shipping tracking URL")
						.setRequired(false),
				),
		)

		// /gb setcustoms
		.addSubcommand((sub) =>
			sub
				.setName("setcustoms")
				.setDescription(
					"Set customs cost and tracking URL (organiser/buyer only)",
				)
				.addIntegerOption((o) =>
					o
						.setName("customs_cost")
						.setDescription("Total customs/import duties in JPY")
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("tracking_url")
						.setDescription("Indian customs portal tracking URL")
						.setRequired(false),
				),
		)

		// /gb claim
		.addSubcommand((sub) =>
			sub
				.setName("claim")
				.setDescription("Claim a kit in this group buy")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("Kit to claim")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)

		// /gb claims
		.addSubcommandGroup((group) =>
			group
				.setName("claims")
				.setDescription("Manage claims")
				.addSubcommand((sub) =>
					sub.setName("view").setDescription("View claims for this group buy"),
				)
				.addSubcommand((sub) =>
					sub
						.setName("unclaim")
						.setDescription("Cancel a specific claim")
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Claim to cancel")
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((sub) =>
					sub
						.setName("transfer")
						.setDescription("Transfer a claim to another user (organiser only)")
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Claim to transfer")
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addUserOption((o) =>
							o
								.setName("user")
								.setDescription("New claimant")
								.setRequired(true),
						),
				),
		),

	async autocomplete(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const focused = interaction.options.getFocused();

		if (focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		// /gb addkit — all kits in DB, excluding ones already in this GB
		if (subcommand === "addkit") {
			const existing = await prisma.groupBuyKit.findMany({
				where: { groupBuy: { threadId: interaction.channelId } },
				select: { kitId: true },
			});
			const excludedIds = existing.map((e) => e.kitId);

			const results = await prisma.kit.findMany({
				where: {
					product_name: { contains: focused, mode: "insensitive" },
					id: { notIn: excludedIds },
				},
				take: 5,
			});

			await interaction.respond(
				results.map((k) => ({ name: k.product_name, value: k.id })),
			);
			return;
		}

		// /gb removekit — only kits in this GB
		if (subcommand === "removekit") {
			const results = await prisma.groupBuyKit.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					kit: { product_name: { contains: focused, mode: "insensitive" } },
				},
				include: { kit: true },
				take: 5,
			});

			await interaction.respond(
				results.map((gbk) => ({ name: gbk.kit.product_name, value: gbk.id })),
			);
			return;
		}

		// /gb claim — kits in this GB
		if (subcommand === "claim") {
			const results = await prisma.groupBuyKit.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					kit: { product_name: { contains: focused, mode: "insensitive" } },
				},
				include: { kit: true },
				take: 5,
			});

			await interaction.respond(
				results.map((gbk) => ({ name: gbk.kit.product_name, value: gbk.id })),
			);
			return;
		}

		// /gb claims unclaim — caller's active claims in this GB
		if (subcommand === "unclaim") {
			const results = await prisma.groupBuyClaim.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					userId: interaction.user.id,
					status: { not: "CANCELLED" },
					groupBuyKit: {
						kit: { product_name: { contains: focused, mode: "insensitive" } },
					},
				},
				include: { groupBuyKit: { include: { kit: true } } },
				take: 5,
			});

			await interaction.respond(
				results.map((c) => ({
					name: c.groupBuyKit.kit.product_name,
					value: c.id,
				})),
			);
			return;
		}

		// /gb claims transfer — all active claims in this GB
		if (subcommand === "transfer") {
			const results = await prisma.groupBuyClaim.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					status: { not: "CANCELLED" },
					groupBuyKit: {
						kit: { product_name: { contains: focused, mode: "insensitive" } },
					},
				},
				include: { groupBuyKit: { include: { kit: true } } },
				take: 5,
			});

			await interaction.respond(
				results.map((c) => ({
					name: `${c.groupBuyKit.kit.product_name} — <@${c.userId}>`,
					value: c.id,
				})),
			);
			return;
		}

		await interaction.respond([]);
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const subcommandGroup = interaction.options.getSubcommandGroup(false);

		// ── /gb create ────────────────────────────────────────────────────────
		if (subcommand === "create") {
			const existing = await prisma.groupBuy.findUnique({
				where: { threadId: interaction.channelId },
			});

			if (existing) {
				await interaction.reply({
					content: "A group buy already exists for this thread.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const gb = await prisma.groupBuy.create({
				data: {
					threadId: interaction.channelId,
					guildId: interaction.guildId!,
					ownerId: interaction.user.id,
				},
				include: { kits: { include: { kit: true } }, claims: true },
			});

			const embed = buildGbEmbed(gb);
			await interaction.reply({ embeds: [embed] });
			return;
		}

		// ── /gb info ──────────────────────────────────────────────────────────
		if (subcommand === "info") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			const embed = buildGbEmbed(gb);
			await interaction.reply({ embeds: [embed] });
			return;
		}

		// ── /gb addkit ────────────────────────────────────────────────────────
		if (subcommand === "addkit") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the group buy organiser can add kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const kitId = interaction.options.getString("kit", true);
			const kit = await prisma.kit.findUnique({ where: { id: kitId } });

			if (!kit) {
				await interaction.reply({
					content: "Kit not found.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await prisma.groupBuyKit.create({
				data: { groupBuyId: gb.id, kitId: kit.id },
			});

			const allKitsAfterAdd = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id },
				include: { kit: true },
			});
			const totalWeightAfterAdd = allKitsAfterAdd.reduce(
				(sum, k) => sum + k.kit.weight_grams,
				0,
			);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { totalWeight: totalWeightAfterAdd },
			});

			await interaction.reply(
				`Added **${kit.product_name}** to the group buy. Total kit weight: ${totalWeightAfterAdd}g.`,
			);
			return;
		}

		// ── /gb removekit ─────────────────────────────────────────────────────
		if (subcommand === "removekit") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the group buy organiser can remove kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const gbkId = interaction.options.getString("kit", true);

			// Check for active claims before removing
			const claimCount = await prisma.groupBuyClaim.count({
				where: { groupBuyKitId: gbkId, status: { not: "CANCELLED" } },
			});

			if (claimCount > 0) {
				await interaction.reply({
					content: `Cannot remove this kit — it has ${claimCount} active claim${claimCount !== 1 ? "s" : ""}. Cancel the claims first.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const gbk = await prisma.groupBuyKit.delete({
				where: { id: gbkId },
				include: { kit: true },
			});

			const allKitsAfterRemove = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id },
				include: { kit: true },
			});
			const totalWeightAfterRemove = allKitsAfterRemove.reduce(
				(sum, k) => sum + k.kit.weight_grams,
				0,
			);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { totalWeight: totalWeightAfterRemove },
			});

			await interaction.reply(
				`Removed **${gbk.kit.product_name}** from the group buy. Total kit weight: ${totalWeightAfterRemove}g.`,
			);
			return;
		}

		// ── /gb setbuyer ──────────────────────────────────────────────────────
		if (subcommand === "setbuyer") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the organiser can set the buyer.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const user = interaction.options.getUser("user", true);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { buyerId: user.id },
			});

			await interaction.reply(`Set <@${user.id}> as the payment handler.`);
			return;
		}

		// ── /gb setreceiver ───────────────────────────────────────────────────
		if (subcommand === "setreceiver") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the organiser can set the receiver.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const user = interaction.options.getUser("user", true);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { receiverId: user.id },
			});

			await interaction.reply(`Set <@${user.id}> as the parcel receiver.`);
			return;
		}

		// ── /gb transfer ──────────────────────────────────────────────────────
		if (subcommand === "transfer") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the current organiser can transfer ownership.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const user = interaction.options.getUser("user", true);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { ownerId: user.id },
			});

			await interaction.reply(
				`Transferred group buy ownership to <@${user.id}>.`,
			);
			return;
		}

		// ── /gb setstatus ─────────────────────────────────────────────────────
		if (subcommand === "setstatus") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.ownerId !== interaction.user.id) {
				await interaction.reply({
					content: "Only the organiser can update the status.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const status = interaction.options.getString(
				"status",
				true,
			) as GroupBuyStatus;

			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { status },
			});

			await interaction.reply(`Status updated to **${status}**.`);
			return;
		}

		// ── /gb setprice ──────────────────────────────────────────────────────
		if (subcommand === "setprice") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			const isAuthorised =
				gb.ownerId === interaction.user.id ||
				gb.buyerId === interaction.user.id;

			if (!isAuthorised) {
				await interaction.reply({
					content: "Only the organiser or buyer can set the price.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const costPrice = interaction.options.getInteger("cost_price", true);
			const inrConversionRate = interaction.options.getNumber("inr_rate", true);

			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { costPrice, inrConversionRate },
			});

			// Snapshot kit costs to all active claims
			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});

			// Total MSRP of all claimed kits (for proportional split)
			const totalMsrp = activeClaims.reduce(
				(sum, c) => sum + c.groupBuyKit.kit.jpy_price,
				0,
			);

			await Promise.all(
				activeClaims.map((claim) => {
					const proportion = claim.groupBuyKit.kit.jpy_price / totalMsrp;
					const data: {
						calculatedKitCost: number;
						calculatedCustomsCost?: number;
					} = { calculatedKitCost: Math.round(proportion * costPrice) };
					// Pre-snapshot customs if costPrice already set — same MSRP proportion
					if (gb.customsCost !== null) {
						data.calculatedCustomsCost = Math.round(
							proportion * gb.customsCost,
						);
					}
					return prisma.groupBuyClaim.update({ where: { id: claim.id }, data });
				}),
			);

			await interaction.reply(
				`Cost price set to ¥${costPrice.toLocaleString()} at ₹${inrConversionRate}/¥. Kit costs snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
			);
			return;
		}

		// ── /gb setshipping ───────────────────────────────────────────────────
		if (subcommand === "setshipping") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			const isAuthorised =
				gb.ownerId === interaction.user.id ||
				gb.buyerId === interaction.user.id;

			if (!isAuthorised) {
				await interaction.reply({
					content: "Only the organiser or buyer can set shipping.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const shippingCost = interaction.options.getInteger(
				"shipping_cost",
				true,
			);
			const shippingWeight = interaction.options.getInteger(
				"shipping_weight",
				true,
			);
			const trackingNumber = interaction.options.getString("tracking_number");
			const trackingUrl = interaction.options.getString("tracking_url");

			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: {
					shippingCost,
					shippingWeight,
					shippingTrackingNumber: trackingNumber ?? undefined,
					shippingTrackingUrl: trackingUrl ?? undefined,
				},
			});

			// Snapshot shipping costs to all active claims (split by weight proportion)
			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});

			await Promise.all(
				activeClaims.map((claim) => {
					const kitWeight = claim.groupBuyKit.kit.weight_grams;
					const proportion =
						shippingWeight > 0 ? kitWeight / shippingWeight : 0;
					return prisma.groupBuyClaim.update({
						where: { id: claim.id },
						data: {
							calculatedShippingCost: Math.round(proportion * shippingCost),
						},
					});
				}),
			);

			await interaction.reply(
				`Shipping set to ¥${shippingCost.toLocaleString()} for ${shippingWeight}g (courier weight). Shipping costs snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
			);
			return;
		}

		// ── /gb setcustoms ────────────────────────────────────────────────────
		if (subcommand === "setcustoms") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			const isAuthorised =
				gb.ownerId === interaction.user.id ||
				gb.buyerId === interaction.user.id;

			if (!isAuthorised) {
				await interaction.reply({
					content: "Only the organiser or buyer can set customs.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const customsCost = interaction.options.getInteger("customs_cost", true);
			const trackingUrl = interaction.options.getString("tracking_url");

			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: {
					customsCost,
					customsTrackingUrl: trackingUrl ?? undefined,
				},
			});

			// Snapshot customs costs (same MSRP proportion as kit cost)
			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});

			const totalMsrp = activeClaims.reduce(
				(sum, c) => sum + c.groupBuyKit.kit.jpy_price,
				0,
			);

			await Promise.all(
				activeClaims.map((claim) => {
					const proportion = claim.groupBuyKit.kit.jpy_price / totalMsrp;
					return prisma.groupBuyClaim.update({
						where: { id: claim.id },
						data: {
							calculatedCustomsCost: Math.round(proportion * customsCost),
						},
					});
				}),
			);

			await interaction.reply(
				`Customs cost set to ¥${customsCost.toLocaleString()}. Customs costs snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
			);
			return;
		}

		// ── /gb claim ─────────────────────────────────────────────────────────
		if (subcommand === "claim") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			if (gb.status !== "OPEN") {
				await interaction.reply({
					content: `This group buy is **${gb.status}** and is not accepting new claims.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const gbkId = interaction.options.getString("kit", true);
			const gbk = await prisma.groupBuyKit.findUnique({
				where: { id: gbkId },
				include: { kit: true },
			});

			if (!gbk) {
				await interaction.reply({
					content: "Kit not found in this group buy.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await prisma.groupBuyClaim.create({
				data: {
					groupBuyId: gb.id,
					groupBuyKitId: gbk.id,
					userId: interaction.user.id,
				},
			});

			await interaction.reply({
				content: `Claimed **${gbk.kit.product_name}**! The organiser will confirm your claim.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// ── /gb claims subcommand group ───────────────────────────────────────
		if (subcommandGroup === "claims") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			// /gb claims view
			if (subcommand === "view") {
				const isOwner = gb.ownerId === interaction.user.id;

				if (isOwner) {
					// Owner sees all claims grouped by kit
					const gbWithClaims = await prisma.groupBuy.findUnique({
						where: { id: gb.id },
						include: {
							kits: {
								include: {
									kit: true,
									claims: { where: { status: { not: "CANCELLED" } } },
								},
							},
						},
					});

					if (
						!gbWithClaims ||
						gbWithClaims.kits.every((k) => k.claims.length === 0)
					) {
						await interaction.reply({
							content: "No active claims in this group buy.",
							flags: MessageFlags.Ephemeral,
						});
						return;
					}

					const lines = gbWithClaims.kits
						.filter((k) => k.claims.length > 0)
						.map((k) => {
							const claimLines = k.claims
								.map((c) => `  - <@${c.userId}> [${c.status}]`)
								.join("\n");
							return `**${k.kit.product_name}** (${k.claims.length})\n${claimLines}`;
						})
						.join("\n\n");

					await interaction.reply({
						content: lines,
						flags: MessageFlags.Ephemeral,
					});
				} else {
					// Regular user sees their own claims
					const myClaims = await prisma.groupBuyClaim.findMany({
						where: {
							groupBuyId: gb.id,
							userId: interaction.user.id,
							status: { not: "CANCELLED" },
						},
						include: { groupBuyKit: { include: { kit: true } } },
					});

					if (myClaims.length === 0) {
						await interaction.reply({
							content: "You have no active claims in this group buy.",
							flags: MessageFlags.Ephemeral,
						});
						return;
					}

					const lines = myClaims.map((c) => {
						const kitCost = c.calculatedKitCost
							? `¥${c.calculatedKitCost.toLocaleString()}`
							: "TBD";
						const shipping = c.calculatedShippingCost
							? `¥${c.calculatedShippingCost.toLocaleString()}`
							: "TBD";
						const customs = c.calculatedCustomsCost
							? `¥${c.calculatedCustomsCost.toLocaleString()}`
							: "TBD";

						const inrRate = gb.inrConversionRate;
						const totalJpy =
							(c.calculatedKitCost ?? 0) +
							(c.calculatedShippingCost ?? 0) +
							(c.calculatedCustomsCost ?? 0);
						const totalInr =
							inrRate && totalJpy > 0
								? ` = ₹${Math.round(totalJpy * inrRate).toLocaleString()}`
								: "";

						return `**${c.groupBuyKit.kit.product_name}** [${c.status}]\n  Kit: ${kitCost} | Shipping: ${shipping} | Customs: ${customs}${totalInr ? `\n  Total: ¥${totalJpy.toLocaleString()}${totalInr}` : ""}`;
					});

					await interaction.reply({
						content: `Your claims (${myClaims.length}):\n\n${lines.join("\n\n")}`,
						flags: MessageFlags.Ephemeral,
					});
				}
				return;
			}

			// /gb claims unclaim
			if (subcommand === "unclaim") {
				const claimId = interaction.options.getString("claim", true);

				const claim = await prisma.groupBuyClaim.findUnique({
					where: { id: claimId },
					include: { groupBuyKit: { include: { kit: true } } },
				});

				if (!claim) {
					await interaction.reply({
						content: "Claim not found.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const isOwner = gb.ownerId === interaction.user.id;
				const isClaimer = claim.userId === interaction.user.id;

				if (!isOwner && !isClaimer) {
					await interaction.reply({
						content: "You can only cancel your own claims.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				await prisma.groupBuyClaim.update({
					where: { id: claimId },
					data: { status: "CANCELLED" },
				});

				await interaction.reply({
					content: `Cancelled claim for **${claim.groupBuyKit.kit.product_name}**.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// /gb claims transfer
			if (subcommand === "transfer") {
				const gb2 = await getGbForThread(interaction);
				if (!gb2) return;

				if (gb2.ownerId !== interaction.user.id) {
					await interaction.reply({
						content: "Only the organiser can transfer claims.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const claimId = interaction.options.getString("claim", true);
				const newUser = interaction.options.getUser("user", true);

				const claim = await prisma.groupBuyClaim.findUnique({
					where: { id: claimId },
					include: { groupBuyKit: { include: { kit: true } } },
				});

				if (!claim) {
					await interaction.reply({
						content: "Claim not found.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				await prisma.groupBuyClaim.update({
					where: { id: claimId },
					data: { userId: newUser.id },
				});

				await interaction.reply(
					`Transferred claim for **${claim.groupBuyKit.kit.product_name}** to <@${newUser.id}>.`,
				);
				return;
			}
		}
	},
} satisfies Command;
