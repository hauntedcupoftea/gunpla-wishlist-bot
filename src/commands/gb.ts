import {
	ActionRowBuilder,
	type ChatInputCommandInteraction,
	ComponentType,
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
} from "discord.js";
import type {
	GroupBuy,
	GroupBuyKit,
	GroupBuyStatus,
	Kit,
} from "../../generated/client.ts";
import type { Command } from "../lib/command.ts";
import { prisma } from "../lib/prisma.ts";
import { kitNameFilter } from "../lib/util.ts";

type GbWithKits = GroupBuy & { kits: (GroupBuyKit & { kit: Kit })[] };

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
	return !!interaction.memberPermissions?.has(
		PermissionFlagsBits.Administrator,
	);
}

function checkOwner(
	interaction: ChatInputCommandInteraction,
	gb: GroupBuy,
): { allowed: boolean; adminOverride: boolean } {
	if (gb.ownerId === interaction.user.id)
		return { allowed: true, adminOverride: false };
	if (isAdmin(interaction)) return { allowed: true, adminOverride: true };
	return { allowed: false, adminOverride: false };
}

function checkOwnerOrBuyer(
	interaction: ChatInputCommandInteraction,
	gb: GroupBuy,
): { allowed: boolean; adminOverride: boolean } {
	if (
		gb.ownerId === interaction.user.id ||
		gb.buyerId === interaction.user.id
	) {
		return { allowed: true, adminOverride: false };
	}
	if (isAdmin(interaction)) return { allowed: true, adminOverride: true };
	return { allowed: false, adminOverride: false };
}

function withOverrideNote(content: string, adminOverride: boolean): string {
	return adminOverride ? `${content}\n-# ⚠️ Admin override used.` : content;
}

async function isLocked(
	interaction: ChatInputCommandInteraction,
	gb: GroupBuy,
): Promise<boolean> {
	if (gb.status !== "LOCKED") return false;
	if (isAdmin(interaction)) return false;
	await interaction.reply({
		content:
			"This group buy is locked by an administrator. No actions can be taken.",
		flags: MessageFlags.Ephemeral,
	});
	return true;
}

// ─── GB lookup ────────────────────────────────────────────────────────────────

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

// ─── Cost snapshot ────────────────────────────────────────────────────────────

/**
 * Snapshots kit (and customs if set) costs onto a single claim using current GB financials.
 * Safe to call on a newly created claim — no-ops if costPrice isn't set yet.
 */
async function snapshotKitCost(
	claimId: string,
	kitJpyPrice: number,
	gb: GroupBuy,
) {
	if (!gb.costPrice) return;

	const activeClaims = await prisma.groupBuyClaim.findMany({
		where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
		include: { groupBuyKit: { include: { kit: true } } },
	});

	const totalMsrp = activeClaims.reduce(
		(sum, c) => sum + c.groupBuyKit.kit.jpy_price,
		0,
	);
	if (totalMsrp === 0) return;

	const proportion = kitJpyPrice / totalMsrp;
	const data: { calculatedKitCost: number; calculatedCustomsCost?: number } = {
		calculatedKitCost: Math.round(proportion * gb.costPrice),
	};
	if (gb.customsCost !== null) {
		data.calculatedCustomsCost = Math.round(proportion * gb.customsCost);
	}

	await prisma.groupBuyClaim.update({ where: { id: claimId }, data });
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function buildGbEmbed(gb: GbWithKits): EmbedBuilder {
	const statusEmoji: Record<string, string> = {
		OPEN: "🟢",
		CLAIMED: "✅",
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

		.addSubcommand((sub) =>
			sub
				.setName("create")
				.setDescription("Create a group buy in this forum thread"),
		)
		.addSubcommand((sub) =>
			sub
				.setName("info")
				.setDescription("View the group buy summary for this thread"),
		)
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
				)
				.addIntegerOption((o) =>
					o
						.setName("weight_grams")
						.setDescription(
							"Weight of one unit in grams (used for shipping split)",
						)
						.setRequired(true)
						.setMinValue(1),
				)
				.addIntegerOption((o) =>
					o
						.setName("quantity")
						.setDescription("Number of slots to add (default: 1)")
						.setRequired(false)
						.setMinValue(1)
						.setMaxValue(20),
				),
		)
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
				)
				.addIntegerOption((o) =>
					o
						.setName("quantity")
						.setDescription("Number of slots to remove (default: 1)")
						.setRequired(false)
						.setMinValue(1)
						.setMaxValue(20),
				),
		)
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
		.addSubcommand((sub) =>
			sub
				.setName("transfer")
				.setDescription("Transfer group buy ownership (organiser only)")
				.addUserOption((o) =>
					o.setName("user").setDescription("New organiser").setRequired(true),
				),
		)
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
							{ name: "✅ Claimed", value: "CLAIMED" },
							{ name: "🔒 Locked (admin freeze)", value: "LOCKED" },
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
		.addSubcommand((sub) =>
			sub
				.setName("summary")
				.setDescription(
					"Post a public breakdown of what each member owes (organiser/buyer only)",
				),
		)
		.addSubcommandGroup((group) =>
			group
				.setName("claims")
				.setDescription("Manage claims")
				.addSubcommand((sub) =>
					sub.setName("view").setDescription("View claims for this group buy"),
				)
				.addSubcommand((sub) =>
					sub
						.setName("manage")
						.setDescription("Resolve claim conflicts per kit (organiser only)"),
				)
				.addSubcommand((sub) =>
					sub
						.setName("unclaim")
						.setDescription("Cancel one of your claims")
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Kit to unclaim")
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

	// ─── Autocomplete ─────────────────────────────────────────────────────────

	async autocomplete(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const focused = interaction.options.getFocused();

		if (focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		if (subcommand === "addkit") {
			const existing = await prisma.groupBuyKit.findMany({
				where: { groupBuy: { threadId: interaction.channelId } },
				select: { kitId: true },
			});
			const excludedIds = existing.map((e) => e.kitId);
			const results = await prisma.kit.findMany({
				where: {
					...kitNameFilter(focused),
					id: { notIn: excludedIds },
				},
				take: 5,
			});
			console.info(results);
			await interaction.respond(
				results.map((k) => ({ name: k.product_name, value: k.id })),
			);
			return;
		}

		if (subcommand === "removekit") {
			const results = await prisma.groupBuyKit.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					kit: { ...kitNameFilter(focused) },
				},
				include: { kit: true },
				take: 5,
			});
			await interaction.respond(
				results.map((gbk) => ({ name: gbk.kit.product_name, value: gbk.id })),
			);
			return;
		}

		if (subcommand === "claim") {
			// Find kits the user already has an active claim for (exclude entire kit)
			const alreadyClaimed = await prisma.groupBuyClaim.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					userId: interaction.user.id,
					status: { not: "CANCELLED" },
				},
				include: { groupBuyKit: { select: { kitId: true } } },
			});
			const excludedKitIds = alreadyClaimed.map((c) => c.groupBuyKit.kitId);

			// Load all slots for matching kits, aggregate by kitId
			const slots = await prisma.groupBuyKit.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					kit: { ...kitNameFilter(focused) },
					kitId: { notIn: excludedKitIds },
				},
				include: {
					kit: true,
					claims: { where: { status: { not: "CANCELLED" } } },
				},
			});

			const byKit = new Map<
				string,
				{ name: string; total: number; pending: number }
			>();
			for (const slot of slots) {
				const entry = byKit.get(slot.kitId) ?? {
					name: slot.kit.product_name,
					total: 0,
					pending: 0,
				};
				entry.total++;
				entry.pending += slot.claims.length;
				byKit.set(slot.kitId, entry);
			}

			const options = [...byKit.entries()]
				.slice(0, 5)
				.map(([kitId, { name, total, pending }]) => ({
					name: `${name} (${pending} pending / ${total} slot${total !== 1 ? "s" : ""})`,
					value: kitId,
				}));

			await interaction.respond(options);
			return;
		}

		if (subcommand === "unclaim") {
			const results = await prisma.groupBuyClaim.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					userId: interaction.user.id,
					status: { not: "CANCELLED" },
					groupBuyKit: { kit: { ...kitNameFilter(focused) } },
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

		if (subcommand === "transfer") {
			const results = await prisma.groupBuyClaim.findMany({
				where: {
					groupBuy: { threadId: interaction.channelId },
					status: { not: "CANCELLED" },
					groupBuyKit: { kit: { ...kitNameFilter(focused) } },
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

	// ─── Execute ──────────────────────────────────────────────────────────────

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
			await interaction.reply({ embeds: [buildGbEmbed(gb)] });
			return;
		}

		// ── /gb info ──────────────────────────────────────────────────────────
		if (subcommand === "info") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			await interaction.reply({
				embeds: [buildGbEmbed(gb)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// ── /gb addkit ────────────────────────────────────────────────────────
		if (subcommand === "addkit") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the group buy organiser can add kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const kitId = interaction.options.getString("kit", true);
			const weightGrams = interaction.options.getInteger("weight_grams", true);
			const quantity = interaction.options.getInteger("quantity") ?? 1;
			const kit = await prisma.kit.findUnique({ where: { id: kitId } });
			if (!kit) {
				await interaction.reply({
					content: "Kit not found.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			// Find highest existing slot number for this kit in this GB
			const existingSlots = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id, kitId: kit.id },
				orderBy: { slotNumber: "desc" },
				take: 1,
			});
			const nextSlot = (existingSlots[0]?.slotNumber ?? 0) + 1;

			await prisma.groupBuyKit.createMany({
				data: Array.from({ length: quantity }, (_, i) => ({
					groupBuyId: gb.id,
					kitId: kit.id,
					weight_grams: weightGrams,
					slotNumber: nextSlot + i,
				})),
			});
			const allSlots = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id },
			});
			const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { totalWeight },
			});
			await interaction.reply(
				withOverrideNote(
					`Added **${quantity}x ${kit.product_name}** (${weightGrams}g each) to the group buy. Total weight: ${totalWeight}g.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb removekit ─────────────────────────────────────────────────────
		if (subcommand === "removekit") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the group buy organiser can remove kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const kitId = interaction.options.getString("kit", true);
			const quantity = interaction.options.getInteger("quantity") ?? 1;

			// Find unclaimed slots for this kit in this GB
			const unclaimedSlots = await prisma.groupBuyKit.findMany({
				where: {
					groupBuyId: gb.id,
					kitId,
					claims: { none: { status: { not: "CANCELLED" } } },
				},
				include: { kit: true },
				take: quantity,
			});

			if (unclaimedSlots.length < quantity) {
				const totalSlots = await prisma.groupBuyKit.count({
					where: { groupBuyId: gb.id, kitId },
				});
				await interaction.reply({
					content: `Not enough unclaimed slots — only ${unclaimedSlots.length} of ${totalSlots} slot${totalSlots !== 1 ? "s" : ""} are unclaimed.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const kitName = unclaimedSlots[0].kit.product_name;
			await prisma.groupBuyKit.deleteMany({
				where: { id: { in: unclaimedSlots.map((s) => s.id) } },
			});

			const allSlots = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id },
			});
			const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { totalWeight },
			});

			await interaction.reply(
				withOverrideNote(
					`Removed **${quantity}x ${kitName}** from the group buy. Total weight: ${totalWeight}g.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setbuyer ──────────────────────────────────────────────────────
		if (subcommand === "setbuyer") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
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
			await interaction.reply(
				withOverrideNote(
					`Set <@${user.id}> as the payment handler.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setreceiver ───────────────────────────────────────────────────
		if (subcommand === "setreceiver") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
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
			await interaction.reply(
				withOverrideNote(
					`Set <@${user.id}> as the parcel receiver.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb transfer ──────────────────────────────────────────────────────
		if (subcommand === "transfer") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
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
				withOverrideNote(
					`Transferred group buy ownership to <@${user.id}>.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setstatus ─────────────────────────────────────────────────────
		if (subcommand === "setstatus") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;

			const newStatus = interaction.options.getString(
				"status",
				true,
			) as GroupBuyStatus;
			const settingLocked = newStatus === "LOCKED";
			const unsettingLocked = gb.status === "LOCKED";

			if ((settingLocked || unsettingLocked) && !isAdmin(interaction)) {
				await interaction.reply({
					content:
						"Only a server administrator can lock or unlock a group buy.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can update the status.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			await prisma.groupBuy.update({
				where: { id: gb.id },
				data: { status: newStatus },
			});
			await interaction.reply(
				withOverrideNote(`Status updated to **${newStatus}**.`, adminOverride),
			);
			return;
		}

		// ── /gb setprice ──────────────────────────────────────────────────────
		if (subcommand === "setprice") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
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

			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});
			const totalMsrp = activeClaims.reduce(
				(sum, c) => sum + c.groupBuyKit.kit.jpy_price,
				0,
			);
			if (totalMsrp > 0) {
				await Promise.all(
					activeClaims.map((claim) => {
						const proportion = claim.groupBuyKit.kit.jpy_price / totalMsrp;
						const data: {
							calculatedKitCost: number;
							calculatedCustomsCost?: number;
						} = {
							calculatedKitCost: Math.round(proportion * costPrice),
						};
						if (gb.customsCost !== null) {
							data.calculatedCustomsCost = Math.round(
								proportion * gb.customsCost,
							);
						}
						return prisma.groupBuyClaim.update({
							where: { id: claim.id },
							data,
						});
					}),
				);
			}
			await interaction.reply(
				withOverrideNote(
					`Cost price set to ¥${costPrice.toLocaleString()} at ₹${inrConversionRate}/¥. Snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setshipping ───────────────────────────────────────────────────
		if (subcommand === "setshipping") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
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

			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});
			await Promise.all(
				activeClaims.map((claim) => {
					const proportion =
						shippingWeight > 0
							? claim.groupBuyKit.weight_grams / shippingWeight
							: 0;
					return prisma.groupBuyClaim.update({
						where: { id: claim.id },
						data: {
							calculatedShippingCost: Math.round(proportion * shippingCost),
						},
					});
				}),
			);
			await interaction.reply(
				withOverrideNote(
					`Shipping set to ¥${shippingCost.toLocaleString()} for ${shippingWeight}g. Snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setcustoms ────────────────────────────────────────────────────
		if (subcommand === "setcustoms") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;
			const { allowed, adminOverride } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
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
				data: { customsCost, customsTrackingUrl: trackingUrl ?? undefined },
			});

			const activeClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: { not: "CANCELLED" } },
				include: { groupBuyKit: { include: { kit: true } } },
			});
			const totalMsrp = activeClaims.reduce(
				(sum, c) => sum + c.groupBuyKit.kit.jpy_price,
				0,
			);
			if (totalMsrp > 0) {
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
			}
			await interaction.reply(
				withOverrideNote(
					`Customs set to ¥${customsCost.toLocaleString()}. Snapshotted to ${activeClaims.length} claim${activeClaims.length !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb summary ──────────────────────────────────────────────────────
		if (subcommand === "summary") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;

			const { allowed } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser or buyer can post the payment summary.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const confirmedClaims = await prisma.groupBuyClaim.findMany({
				where: { groupBuyId: gb.id, status: "CONFIRMED" },
				include: { groupBuyKit: { include: { kit: true } } },
				orderBy: { userId: "asc" },
			});

			if (confirmedClaims.length === 0) {
				await interaction.reply({
					content:
						"No confirmed claims yet. Resolve conflicts with `/gb claims manage` first.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Group by userId
			const byUser = new Map<string, typeof confirmedClaims>();
			for (const claim of confirmedClaims) {
				const existing = byUser.get(claim.userId) ?? [];
				existing.push(claim);
				byUser.set(claim.userId, existing);
			}

			const hasKit = confirmedClaims.some((c) => c.calculatedKitCost !== null);
			const hasShipping = confirmedClaims.some(
				(c) => c.calculatedShippingCost !== null,
			);
			const hasCustoms = confirmedClaims.some(
				(c) => c.calculatedCustomsCost !== null,
			);

			const userLines = [...byUser.entries()].map(([userId, claims]) => {
				const kitTotal = claims.reduce(
					(sum, c) => sum + (c.calculatedKitCost ?? 0),
					0,
				);
				const shippingTotal = claims.reduce(
					(sum, c) => sum + (c.calculatedShippingCost ?? 0),
					0,
				);
				const customsTotal = claims.reduce(
					(sum, c) => sum + (c.calculatedCustomsCost ?? 0),
					0,
				);
				const grandTotal = kitTotal + shippingTotal + customsTotal;
				const grandInr =
					gb.inrConversionRate && grandTotal > 0
						? ` **(₹${Math.round(grandTotal * gb.inrConversionRate).toLocaleString()})**`
						: "";

				// Per-kit lines — show slot number only when kit has multiple slots
				const kitLines = claims
					.map((c) => {
						const slotsForKit = confirmedClaims.filter(
							(x) => x.groupBuyKit.kitId === c.groupBuyKit.kitId,
						);
						const slotLabel =
							slotsForKit.length > 1
								? `${c.groupBuyKit.kit.product_name} #${c.groupBuyKit.slotNumber}`
								: c.groupBuyKit.kit.product_name;
						return `  - ${slotLabel}`;
					})
					.join("\n");

				// Cost breakdown
				const costParts: string[] = [];
				if (hasKit) costParts.push(`Kit ¥${kitTotal.toLocaleString()}`);
				if (hasShipping)
					costParts.push(`Shipping ¥${shippingTotal.toLocaleString()}`);
				if (hasCustoms)
					costParts.push(`Customs ¥${customsTotal.toLocaleString()}`);

				const costLine =
					costParts.length > 0
						? `  **Total: ¥${grandTotal.toLocaleString()}**${grandInr}` +
							(costParts.length > 1 ? ` (${costParts.join(" + ")})` : "")
						: "  _Costs not yet set_";

				return `<@${userId}>\n${kitLines}\n${costLine}`;
			});

			const header = [
				`## Payment Summary`,
				gb.inrConversionRate ? `Rate: ¥1 = ₹${gb.inrConversionRate}` : null,
				"",
			]
				.filter((l) => l !== null)
				.join("\n");

			await interaction.reply({ content: header + userLines.join("\n\n") });
			return;
		}

		// ── /gb claim ─────────────────────────────────────────────────────────
		if (subcommand === "claim") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;

			if (gb.status !== "OPEN") {
				await interaction.reply({
					content: `This group buy is **${gb.status}** and is not accepting new claims.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const kitId = interaction.options.getString("kit", true);

			// Duplicate claim protection — one claim per user per kit across all slots
			const existing = await prisma.groupBuyClaim.findFirst({
				where: {
					groupBuyId: gb.id,
					userId: interaction.user.id,
					status: { not: "CANCELLED" },
					groupBuyKit: { kitId },
				},
			});
			if (existing) {
				await interaction.reply({
					content: "You already have an active claim for this kit.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Load all slots for this kit, with their active claim counts
			const slots = await prisma.groupBuyKit.findMany({
				where: { groupBuyId: gb.id, kitId },
				include: {
					kit: true,
					claims: { where: { status: { not: "CANCELLED" } } },
				},
				orderBy: { slotNumber: "asc" },
			});

			if (slots.length === 0) {
				await interaction.reply({
					content: "Kit not found in this group buy.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Assign to the slot with the fewest pending claims (ties broken by slotNumber)
			const bestSlot = slots.reduce((best, slot) =>
				slot.claims.length < best.claims.length ? slot : best,
			);

			const claim = await prisma.groupBuyClaim.create({
				data: {
					groupBuyId: gb.id,
					groupBuyKitId: bestSlot.id,
					userId: interaction.user.id,
				},
			});

			// Auto-snapshot if financials already set
			await snapshotKitCost(claim.id, bestSlot.kit.jpy_price, gb);

			const slotLabel =
				slots.length > 1 ? ` (slot #${bestSlot.slotNumber})` : "";
			await interaction.reply({
				content: `Claimed **${bestSlot.kit.product_name}**${slotLabel}! The organiser will confirm your claim.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// ── /gb claims ────────────────────────────────────────────────────────
		if (subcommandGroup === "claims") {
			const gb = await getGbForThread(interaction);
			if (!gb) return;
			if (await isLocked(interaction, gb)) return;

			// /gb claims view ─────────────────────────────────────────────────
			if (subcommand === "view") {
				const isOwner =
					gb.ownerId === interaction.user.id || isAdmin(interaction);

				if (isOwner) {
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
							const slotLabel =
								gbWithClaims.kits.filter((s) => s.kitId === k.kitId).length > 1
									? `**${k.kit.product_name} #${k.slotNumber}**`
									: `**${k.kit.product_name}**`;
							const claimLines = k.claims
								.map((c) => `  - <@${c.userId}> [${c.status}]`)
								.join("\n");
							return `${slotLabel} (${k.claims.length})\n${claimLines}`;
						})
						.join("\n\n");

					await interaction.reply({
						content: lines,
						flags: MessageFlags.Ephemeral,
					});
				} else {
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
						const totalJpy =
							(c.calculatedKitCost ?? 0) +
							(c.calculatedShippingCost ?? 0) +
							(c.calculatedCustomsCost ?? 0);
						const totalInr =
							gb.inrConversionRate && totalJpy > 0
								? ` = ₹${Math.round(totalJpy * gb.inrConversionRate).toLocaleString()}`
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

			// /gb claims manage ───────────────────────────────────────────────
			if (subcommand === "manage") {
				const { allowed } = checkOwner(interaction, gb);
				if (!allowed) {
					await interaction.reply({
						content: "Only the organiser can manage claims.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const kitsWithClaims = await prisma.groupBuyKit.findMany({
					where: { groupBuyId: gb.id },
					include: {
						kit: true,
						claims: { where: { status: { not: "CANCELLED" } } },
					},
					orderBy: [{ kitId: "asc" }, { slotNumber: "asc" }],
				});

				const contested = kitsWithClaims.filter((k) => k.claims.length > 1);
				const resolved = kitsWithClaims.filter((k) => k.claims.length === 1);
				const unclaimed = kitsWithClaims.filter((k) => k.claims.length === 0);

				if (contested.length === 0) {
					const parts: string[] = [];
					if (resolved.length > 0) {
						parts.push(
							`✅ Resolved:\n${resolved.map((k) => `  - **${k.kit.product_name} #${k.slotNumber}** → <@${k.claims[0].userId}>`).join("\n")}`,
						);
					}
					if (unclaimed.length > 0) {
						parts.push(
							`⚠️ No claims yet:\n${unclaimed.map((k) => `  - **${k.kit.product_name}**`).join("\n")}`,
						);
					}
					const summary = parts.join("\n\n") || "No claims yet.";
					const canAdvance =
						unclaimed.length === 0 &&
						resolved.length > 0 &&
						gb.status === "OPEN";
					await interaction.reply({
						content: canAdvance
							? `${summary}\n\nAll kits are claimed. Use \`/gb setstatus\` to advance to **CLAIMED**.`
							: summary,
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				// Up to 5 select menus (Discord component limit)
				const shown = contested.slice(0, 5);
				const rows = shown.map((gbk) => {
					const slotLabel = `${gbk.kit.product_name} #${gbk.slotNumber}`;
					const select = new StringSelectMenuBuilder()
						.setCustomId(`claims:confirm:${gbk.id}`)
						.setPlaceholder(`${slotLabel} — pick one claimer`)
						.addOptions(
							gbk.claims.map((c) => ({
								label: `<@${c.userId}>`,
								description: `Confirm for ${slotLabel}, cancel all others`,
								value: c.id,
							})),
						);
					return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						select,
					);
				});

				const embed = new EmbedBuilder()
					.setTitle("Claim conflicts")
					.setColor(0xe67e22)
					.setDescription(
						`${contested.length} slot${contested.length !== 1 ? "s have" : " has"} multiple claimers. ` +
							`Select one winner per slot — all others will be cancelled.\n\n` +
							contested
								.map(
									(k) =>
										`**${k.kit.product_name} #${k.slotNumber}** — ${k.claims.length} claimers: ${k.claims.map((c) => `<@${c.userId}>`).join(", ")}`,
								)
								.join("\n"),
					);

				if (contested.length > 5) {
					embed.setFooter({
						text: `Showing 5 of ${contested.length} conflicts. Run /gb claims manage again after resolving these.`,
					});
				}

				const response = await interaction.reply({
					embeds: [embed],
					components: rows,
					flags: MessageFlags.Ephemeral,
				});

				const collector = response.createMessageComponentCollector({
					componentType: ComponentType.StringSelect,
					time: 5 * 60 * 1000,
				});

				collector.on("collect", async (sel: StringSelectMenuInteraction) => {
					const [, , gbkId] = sel.customId.split(":");
					const confirmedClaimId = sel.values[0];

					const allClaims = await prisma.groupBuyClaim.findMany({
						where: { groupBuyKitId: gbkId, status: { not: "CANCELLED" } },
						include: { groupBuyKit: { include: { kit: true } } },
					});
					const kitName = allClaims[0]?.groupBuyKit.kit.product_name ?? "kit";

					await prisma.groupBuyClaim.update({
						where: { id: confirmedClaimId },
						data: { status: "CONFIRMED" },
					});
					await prisma.groupBuyClaim.updateMany({
						where: {
							groupBuyKitId: gbkId,
							id: { not: confirmedClaimId },
							status: { not: "CANCELLED" },
						},
						data: { status: "CANCELLED" },
					});

					await sel.reply({
						content: `✅ Confirmed claim for **${kitName}**.`,
						flags: MessageFlags.Ephemeral,
					});

					// Check if all kits now have exactly one non-cancelled claim
					const stillPending = await prisma.groupBuyClaim.count({
						where: { groupBuyId: gb.id, status: "PENDING" },
					});
					const stillContested = await prisma.groupBuyKit.findMany({
						where: { groupBuyId: gb.id },
						include: { claims: { where: { status: { not: "CANCELLED" } } } },
					});
					const hasConflicts = stillContested.some((k) => k.claims.length > 1);

					if (!hasConflicts && stillPending === 0) {
						await sel.followUp({
							content:
								"All conflicts resolved. Use `/gb setstatus` to advance to **CLAIMED** when ready.",
							flags: MessageFlags.Ephemeral,
						});
					}
				});

				collector.on("end", async (_, reason) => {
					if (reason === "time") {
						await interaction.editReply({ components: [] });
					}
				});

				return;
			}

			// /gb claims unclaim ──────────────────────────────────────────────
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
				const isOwner =
					gb.ownerId === interaction.user.id || isAdmin(interaction);
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

			// /gb claims transfer ─────────────────────────────────────────────
			if (subcommand === "transfer") {
				const { allowed, adminOverride } = checkOwner(interaction, gb);
				if (!allowed) {
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
				// Duplicate protection on transfer target
				const conflict = await prisma.groupBuyClaim.findFirst({
					where: {
						groupBuyKitId: claim.groupBuyKitId,
						userId: newUser.id,
						status: { not: "CANCELLED" },
						id: { not: claimId },
					},
				});
				if (conflict) {
					await interaction.reply({
						content: `<@${newUser.id}> already has an active claim for **${claim.groupBuyKit.kit.product_name}**.`,
						flags: MessageFlags.Ephemeral,
					});
					return;
				}
				await prisma.groupBuyClaim.update({
					where: { id: claimId },
					data: { userId: newUser.id },
				});
				await interaction.reply(
					withOverrideNote(
						`Transferred claim for **${claim.groupBuyKit.kit.product_name}** to <@${newUser.id}>.`,
						adminOverride,
					),
				);
				return;
			}
		}
	},
} satisfies Command;
