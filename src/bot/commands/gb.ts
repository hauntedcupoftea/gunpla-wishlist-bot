/**
 * @module bot/commands/gb
 *
 * Discord slash command handler for all group buy operations.
 *
 * This file is intentionally thin: it handles Discord-specific concerns
 * (permission checks, channel type guards, autocomplete formatting, reply
 * construction) and delegates all business logic and database access to
 * src/services/groupbuy.service.ts.
 *
 * ## Subcommands
 *
 * ### Management (organiser only)
 * - /gb create       — Start a group buy in this forum thread
 * - /gb addkit       — Add a kit slot to the group buy
 * - /gb removekit    — Remove an unclaimed kit slot
 * - /gb setbuyer     — Set the payment aggregator
 * - /gb setreceiver  — Set the parcel receiver
 * - /gb transfer     — Transfer organiser ownership
 * - /gb setstatus    — Advance or update the group buy status
 * - /gb setprice     — Set kit cost + JPY→INR rate
 * - /gb setwarehouse — Set warehouse fee (optional)
 * - /gb setshipping  — Set shipping cost + actual weight + tracking
 * - /gb setcustoms   — Set customs cost + tracking
 * - /gb summary      — Post public payment summary to thread
 *
 * ### Member
 * - /gb info         — View group buy overview (public costs, not personal)
 * - /gb balance      — View your personal cost breakdown and payment status
 * - /gb claim        — Claim a kit slot
 *
 * ### Claims subgroup
 * - /gb claims view     — View claims (organiser sees all; members see their own)
 * - /gb claims manage   — Resolve conflicts and confirm uncontested claims (organiser)
 * - /gb claims unclaim  — Cancel one of your own claims
 * - /gb claims transfer — Move a claim to another user (organiser)
 * - /gb claims pay      — Report a payment (member self-report)
 * - /gb claims confirm  — Confirm a member's reported payment (organiser)
 */

import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	type ChatInputCommandInteraction,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
} from "discord.js";
import type {
	GroupBuyClaim,
	GroupBuyStatus,
	PaymentStage,
} from "../../../generated/client.ts";
import { CLAIM_STATUS_LABEL, withOverrideNote } from "../../lib/util.ts";
import * as GbService from "../../services/groupbuy.service.ts";
import { searchKits } from "../../services/kit.service.ts";
import type { Command } from "../lib/command.ts";
import {
	buildBalanceEmbed,
	buildConflictEmbed,
	buildGroupBuyEmbed,
	buildSummaryEmbed,
} from "../lib/embeds.ts";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
	return !!interaction.memberPermissions?.has(
		PermissionFlagsBits.Administrator,
	);
}

function checkOwner(
	interaction: ChatInputCommandInteraction,
	gb: { ownerId: string },
): { allowed: boolean; adminOverride: boolean } {
	if (gb.ownerId === interaction.user.id)
		return { allowed: true, adminOverride: false };
	if (isAdmin(interaction)) return { allowed: true, adminOverride: true };
	return { allowed: false, adminOverride: false };
}

function checkOwnerOrBuyer(
	interaction: ChatInputCommandInteraction,
	gb: { ownerId: string; buyerId: string | null },
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

async function replyLocked(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.reply({
		content:
			"🔒 This group buy is locked by an administrator. No actions can be taken.",
		flags: MessageFlags.Ephemeral,
	});
}

async function replyNotFound(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.reply({
		content:
			"No group buy found for this thread. Use `/gb create` to start one.",
		flags: MessageFlags.Ephemeral,
	});
}

// ─── Channel guard ────────────────────────────────────────────────────────────

/**
 * Verifies the interaction is happening inside a Discord forum thread.
 * Returns true if the check passes; false (and replies with an error) if not.
 */
async function assertForumThread(
	interaction: ChatInputCommandInteraction,
): Promise<boolean> {
	try {
		let channel = interaction.channel;
		if (channel?.partial) channel = await channel.fetch();

		let parent = channel?.isThread() ? channel.parent : null;
		if (channel?.isThread() && !parent && channel.parentId) {
			parent = (await interaction.client.channels.fetch(
				channel.parentId,
			)) as any;
		}

		if (
			channel?.type !== ChannelType.PublicThread ||
			parent?.type !== ChannelType.GuildForum
		) {
			await interaction.reply({
				content: "⚠️ Group buy commands must be used inside a **forum thread**.",
				flags: MessageFlags.Ephemeral,
			});
			return false;
		}
		return true;
	} catch (err: any) {
		await interaction.reply({
			content:
				err.code === 50001
					? "❌ I'm missing **View Channel** permission here. Please check my role permissions."
					: "❌ Unable to verify this channel. Please try again.",
			flags: MessageFlags.Ephemeral,
		});
		return false;
	}
}

// ─── Command definition ───────────────────────────────────────────────────────

export default {
	data: new SlashCommandBuilder()
		.setName("gb")
		.setDescription("Group buy commands")

		// ── Management ──────────────────────────────────────────────────────────

		.addSubcommand((sub) =>
			sub
				.setName("create")
				.setDescription("Create a group buy in this forum thread"),
		)

		.addSubcommand((sub) =>
			sub
				.setName("addkit")
				.setDescription("Add a kit slot to this group buy (organiser only)")
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
						.setDescription("Per-unit weight in grams (for shipping split)")
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
				.setDescription("Remove an unclaimed kit slot (organiser only)")
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
					"Set the payment aggregator for this group buy (organiser only)",
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
				.setDescription(
					"Transfer group buy ownership to another member (organiser only)",
				)
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
							{ name: "🔒 Locked (admin)", value: "LOCKED" },
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
					"Set kit cost price and JPY→INR conversion rate (organiser/buyer only)",
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
				.setName("setwarehouse")
				.setDescription(
					"Set domestic shipping (to warehouse) fee (organiser/buyer only). Use 0 to clear.",
				)
				.addIntegerOption((o) =>
					o
						.setName("warehouse_cost")
						.setDescription("Total to-warehouse fee in JPY (0 = none)")
						.setRequired(true)
						.setMinValue(0),
				),
		)

		.addSubcommand((sub) =>
			sub
				.setName("setshipping")
				.setDescription(
					"Set international shipping cost, actual parcel weight and tracking (organiser/buyer only)",
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
						.setDescription(
							"Actual courier-weighed parcel weight in grams (for your records)",
						)
						.setRequired(true),
				)
				.addStringOption((o) =>
					o
						.setName("tracking_number")
						.setDescription("Tracking number")
						.setRequired(false),
				)
				.addStringOption((o) =>
					o
						.setName("tracking_url")
						.setDescription("Tracking URL")
						.setRequired(false),
				),
		)

		.addSubcommand((sub) =>
			sub
				.setName("setcustoms")
				.setDescription(
					"Set customs/import duties and tracking (organiser/buyer only)",
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
				.setName("summary")
				.setDescription(
					"Post a public payment breakdown for all confirmed claimants (organiser/buyer only)",
				),
		)

		// ── Member ──────────────────────────────────────────────────────────────

		.addSubcommand((sub) =>
			sub
				.setName("info")
				.setDescription("View group buy overview for this thread"),
		)

		.addSubcommand((sub) =>
			sub
				.setName("balance")
				.setDescription(
					"View your personal cost breakdown and payment status for this group buy",
				),
		)

		.addSubcommand((sub) =>
			sub
				.setName("claim")
				.setDescription("Claim a kit slot in this group buy")
				.addStringOption((o) =>
					o
						.setName("kit")
						.setDescription("Kit to claim")
						.setRequired(true)
						.setAutocomplete(true),
				),
		)

		// ── Claims subgroup ─────────────────────────────────────────────────────

		.addSubcommandGroup((group) =>
			group
				.setName("claims")
				.setDescription("Manage claims")
				.addSubcommand((sub) =>
					sub
						.setName("view")
						.setDescription(
							"View claims (organiser sees all; members see their own)",
						),
				)
				.addSubcommand((sub) =>
					sub
						.setName("manage")
						.setDescription(
							"Resolve conflicts and confirm uncontested claims (organiser only)",
						),
				)
				.addSubcommand((sub) =>
					sub
						.setName("unclaim")
						.setDescription("Cancel one of your claims")
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Which claim to cancel")
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((sub) =>
					sub
						.setName("transfer")
						.setDescription(
							"Transfer a claim to another member (organiser only)",
						)
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
				)
				.addSubcommand((sub) =>
					sub
						.setName("pay")
						.setDescription("Report that you have made a payment for a stage")
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Which claim")
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((o) =>
							o
								.setName("stage")
								.setDescription("Which payment stage you have completed")
								.setRequired(true)
								.addChoices(
									{ name: "💴 Kit cost", value: "KIT" },
									{ name: "📦 Warehouse fee", value: "WAREHOUSE" },
									{ name: "🚢 Shipping", value: "SHIPPING" },
									{ name: "🛃 Customs", value: "CUSTOMS" },
								),
						)
						.addStringOption((o) =>
							o
								.setName("note")
								.setDescription(
									"Optional note (e.g. UTR number, screenshot link)",
								)
								.setRequired(false),
						),
				)
				.addSubcommand((sub) =>
					sub
						.setName("confirm")
						.setDescription(
							"Confirm a member's reported payment (organiser/buyer only)",
						)
						.addStringOption((o) =>
							o
								.setName("claim")
								.setDescription("Claim to confirm payment on")
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((o) =>
							o
								.setName("stage")
								.setDescription("Which payment stage to confirm")
								.setRequired(true)
								.addChoices(
									{ name: "💴 Kit cost", value: "KIT" },
									{ name: "📦 Warehouse fee", value: "WAREHOUSE" },
									{ name: "🚢 Shipping", value: "SHIPPING" },
									{ name: "🛃 Customs", value: "CUSTOMS" },
								),
						)
						.addStringOption((o) =>
							o
								.setName("note")
								.setDescription("Optional note")
								.setRequired(false),
						),
				),
		),

	// ─── Autocomplete ──────────────────────────────────────────────────────────

	async autocomplete(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const focused = interaction.options.getFocused();

		if (focused.length === 0) {
			await interaction.respond([]);
			return;
		}

		try {
			if (subcommand === "addkit") {
				// Exclude kits already in this GB
				const existing = await import("../../lib/prisma.ts").then(
					({ prisma }) =>
						prisma.groupBuyKit.findMany({
							where: { groupBuy: { threadId: interaction.channelId } },
							select: { kitId: true },
						}),
				);
				const excludedIds = existing.map((e) => e.kitId);
				const kits = await searchKits(focused, 5);
				await interaction.respond(
					kits
						.filter((k) => !excludedIds.includes(k.id))
						.map((k) => ({ name: k.product_name, value: k.id })),
				);
				return;
			}

			if (subcommand === "removekit") {
				// BUG FIX: value is Kit.id (not GroupBuyKit.id)
				const options = await GbService.getRemovableKitsForGroupBuy(
					interaction.channelId,
					focused,
				);
				await interaction.respond(options);
				return;
			}

			if (subcommand === "claim") {
				const options = await GbService.getClaimableKitsForUser(
					interaction.channelId,
					interaction.user.id,
					focused,
				);
				await interaction.respond(options);
				return;
			}

			if (subcommand === "unclaim" || subcommand === "pay") {
				const options = await GbService.getUserClaimOptions(
					interaction.channelId,
					interaction.user.id,
					focused,
				);
				await interaction.respond(options);
				return;
			}

			if (subcommand === "transfer" || subcommand === "confirm") {
				// BUG FIX: value is claim.id (was previously groupBuyKit.id in places)
				const options = await GbService.getAllClaimOptions(
					interaction.channelId,
					focused,
				);
				await interaction.respond(options);
				return;
			}
		} catch {
			// Autocomplete must not throw
		}

		await interaction.respond([]);
	},

	// ─── Execute ───────────────────────────────────────────────────────────────

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const subcommandGroup = interaction.options.getSubcommandGroup(false);

		if (!(await assertForumThread(interaction))) return;

		const threadId = interaction.channelId;

		// ── /gb create ─────────────────────────────────────────────────────────
		if (subcommand === "create") {
			const existing = await GbService.getGroupBuyByThread(threadId);
			if (existing) {
				await interaction.reply({
					content: "A group buy already exists for this thread.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const gb = await GbService.createGroupBuy({
				threadId,
				guildId: interaction.guildId!,
				ownerId: interaction.user.id,
			});

			const full = await GbService.getGroupBuyByThread(threadId);
			await interaction.reply({ embeds: [buildGroupBuyEmbed(full!)] });
			return;
		}

		// ── /gb info ───────────────────────────────────────────────────────────
		if (subcommand === "info") {
			const gb = await GbService.getGroupBuyByThread(threadId);
			if (!gb) {
				await replyNotFound(interaction);
				return;
			}

			await interaction.reply({
				embeds: [buildGroupBuyEmbed(gb)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// ── /gb balance ────────────────────────────────────────────────────────
		if (subcommand === "balance") {
			const gb = await GbService.getGroupBuyByThread(threadId);
			if (!gb) {
				await replyNotFound(interaction);
				return;
			}

			const claims = await GbService.getUserClaimsInGroupBuy(
				gb.id,
				interaction.user.id,
			);
			const summaries = await GbService.getGroupBuySummary(gb.id);
			const mySummaries = summaries.filter(
				(s) => s.userId === interaction.user.id,
			);

			await interaction.reply({
				embeds: [buildBalanceEmbed(mySummaries, gb.inrConversionRate)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// ── All remaining subcommands need the GB to exist ─────────────────────
		const gb = await GbService.getGroupBuyByThread(threadId);
		if (!gb) {
			await replyNotFound(interaction);
			return;
		}

		if (gb.status === "LOCKED" && !isAdmin(interaction)) {
			await replyLocked(interaction);
			return;
		}

		// ── /gb addkit ─────────────────────────────────────────────────────────
		if (subcommand === "addkit") {
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can add kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const kitId = interaction.options.getString("kit", true);
			const weight = interaction.options.getInteger("weight_grams", true);
			const quantity = interaction.options.getInteger("quantity") ?? 1;

			try {
				const slots = await GbService.addKitToGroupBuy({
					groupBuyId: gb.id,
					kitId,
					weightGrams: weight,
					quantity,
				});
				const kitName = slots[0]
					? ((
							await import("../../lib/prisma.ts").then(({ prisma }) =>
								prisma.kit.findUnique({
									where: { id: kitId },
									select: { product_name: true },
								}),
							)
						)?.product_name ?? kitId)
					: kitId;

				const updated = await GbService.getGroupBuyByThread(threadId);
				await interaction.reply(
					withOverrideNote(
						`Added **${quantity}× ${kitName}** (${weight}g each). Total weight: ${updated?.totalWeight ?? "?"}g.`,
						adminOverride,
					),
				);
			} catch (err: any) {
				await interaction.reply({
					content: `❌ ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
			}
			return;
		}

		// ── /gb removekit ──────────────────────────────────────────────────────
		if (subcommand === "removekit") {
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can remove kits.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// BUG FIX: value from autocomplete is now Kit.id (not GroupBuyKit.id)
			const kitId = interaction.options.getString("kit", true);
			const quantity = interaction.options.getInteger("quantity") ?? 1;

			try {
				const { kitName, totalWeight } = await GbService.removeKitFromGroupBuy(
					gb.id,
					kitId,
					quantity,
				);
				await interaction.reply(
					withOverrideNote(
						`Removed **${quantity}× ${kitName}**. Total weight: ${totalWeight}g.`,
						adminOverride,
					),
				);
			} catch (err: any) {
				await interaction.reply({
					content: `❌ ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
			}
			return;
		}

		// ── /gb setbuyer ───────────────────────────────────────────────────────
		if (subcommand === "setbuyer") {
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can set the buyer.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const user = interaction.options.getUser("user", true);
			await GbService.setGroupBuyBuyer(gb.id, user.id);
			await interaction.reply(
				withOverrideNote(
					`Set <@${user.id}> as the payment handler.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setreceiver ────────────────────────────────────────────────────
		if (subcommand === "setreceiver") {
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can set the receiver.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const user = interaction.options.getUser("user", true);
			await GbService.setGroupBuyReceiver(gb.id, user.id);
			await interaction.reply(
				withOverrideNote(
					`Set <@${user.id}> as the parcel receiver.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb transfer ───────────────────────────────────────────────────────
		if (subcommand === "transfer") {
			const { allowed, adminOverride } = checkOwner(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser can transfer ownership.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
			const user = interaction.options.getUser("user", true);
			await GbService.transferGroupBuyOwnership(gb.id, user.id);
			await interaction.reply(
				withOverrideNote(
					`Transferred ownership to <@${user.id}>.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setstatus ──────────────────────────────────────────────────────
		if (subcommand === "setstatus") {
			const newStatus = interaction.options.getString(
				"status",
				true,
			) as GroupBuyStatus;
			const isLockOp = newStatus === "LOCKED" || gb.status === "LOCKED";

			if (isLockOp && !isAdmin(interaction)) {
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
					content: "Only the organiser can change the status.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await GbService.setGroupBuyStatus(gb.id, newStatus);
			await interaction.reply(
				withOverrideNote(
					`Status updated to **${newStatus.replace(/_/g, " ")}**.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setprice ───────────────────────────────────────────────────────
		if (subcommand === "setprice") {
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

			const updated = await GbService.updateFinancials(gb.id, {
				costPrice,
				inrConversionRate,
			});
			const claimCount = gb.claims.filter(
				(c: GroupBuyClaim) => c.status !== "CANCELLED",
			).length;

			await interaction.reply(
				withOverrideNote(
					`Kit cost set to **¥${costPrice.toLocaleString()}** at **₹${inrConversionRate}/¥**. ` +
						`Recalculated across **${claimCount}** active claim${claimCount !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setwarehouse ───────────────────────────────────────────────────
		if (subcommand === "setwarehouse") {
			const { allowed, adminOverride } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser or buyer can set the warehouse fee.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const warehouseCost = interaction.options.getInteger(
				"warehouse_cost",
				true,
			);
			await GbService.updateFinancials(gb.id, {
				warehouseCost: warehouseCost === 0 ? null : warehouseCost,
			});

			const claimCount = gb.claims.filter(
				(c: GroupBuyClaim) => c.status !== "CANCELLED",
			).length;
			await interaction.reply(
				withOverrideNote(
					warehouseCost === 0
						? `Warehouse fee cleared.`
						: `Warehouse fee set to **¥${warehouseCost.toLocaleString()}**. Recalculated across **${claimCount}** claim${claimCount !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setshipping ────────────────────────────────────────────────────
		if (subcommand === "setshipping") {
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

			// updateFinancials recalculates shipping splits by claim weight (not shippingWeight) — bug fixed
			await GbService.updateFinancials(gb.id, { shippingCost, shippingWeight });
			if (trackingNumber || trackingUrl) {
				await GbService.updateTracking(gb.id, {
					shippingTrackingNumber: trackingNumber ?? undefined,
					shippingTrackingUrl: trackingUrl ?? undefined,
				});
			}

			const claimCount = gb.claims.filter(
				(c: GroupBuyClaim) => c.status !== "CANCELLED",
			).length;
			await interaction.reply(
				withOverrideNote(
					`Shipping set to **¥${shippingCost.toLocaleString()}** for **${shippingWeight}g**. ` +
						`Recalculated across **${claimCount}** claim${claimCount !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb setcustoms ─────────────────────────────────────────────────────
		if (subcommand === "setcustoms") {
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

			await GbService.updateFinancials(gb.id, { customsCost });
			if (trackingUrl)
				await GbService.updateTracking(gb.id, {
					customsTrackingUrl: trackingUrl,
				});

			const claimCount = gb.claims.filter(
				(c: GroupBuyClaim) => c.status !== "CANCELLED",
			).length;
			await interaction.reply(
				withOverrideNote(
					`Customs set to **¥${customsCost.toLocaleString()}**. ` +
						`Recalculated across **${claimCount}** claim${claimCount !== 1 ? "s" : ""}.`,
					adminOverride,
				),
			);
			return;
		}

		// ── /gb summary ────────────────────────────────────────────────────────
		if (subcommand === "summary") {
			const { allowed } = checkOwnerOrBuyer(interaction, gb);
			if (!allowed) {
				await interaction.reply({
					content: "Only the organiser or buyer can post the summary.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const summaries = await GbService.getGroupBuySummary(gb.id);
			const confirmed = summaries.filter(
				(s) => !["PENDING", "CANCELLED"].includes(s.status),
			);

			if (confirmed.length === 0) {
				await interaction.reply({
					content:
						"No confirmed claims yet. Resolve conflicts with `/gb claims manage` first.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await interaction.reply({ embeds: [buildSummaryEmbed(gb, confirmed)] });
			return;
		}

		// ── /gb claim ──────────────────────────────────────────────────────────
		if (subcommand === "claim") {
			if (gb.status !== "OPEN") {
				await interaction.reply({
					content: `This group buy is **${gb.status.replace(/_/g, " ")}** and is not accepting new claims.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const kitId = interaction.options.getString("kit", true);

			try {
				const claim = await GbService.claimKit(
					gb.id,
					kitId,
					interaction.user.id,
				);
				await interaction.reply({
					content:
						`✅ Your claim has been submitted! The organiser will confirm it.\n` +
						`Run \`/gb balance\` at any time to see your costs and payment status.`,
					flags: MessageFlags.Ephemeral,
				});
			} catch (err: any) {
				await interaction.reply({
					content: `❌ ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
			}
			return;
		}

		// ── /gb claims * ───────────────────────────────────────────────────────
		if (subcommandGroup === "claims") {
			// /gb claims view ────────────────────────────────────────────────────
			if (subcommand === "view") {
				const isOwner =
					gb.ownerId === interaction.user.id || isAdmin(interaction);

				if (isOwner) {
					const slots = await GbService.getSlotsWithClaimCounts(gb.id);
					const withClaims = slots.filter((s) => s.claims.length > 0);

					if (withClaims.length === 0) {
						await interaction.reply({
							content: "No active claims yet.",
							flags: MessageFlags.Ephemeral,
						});
						return;
					}

					const lines = withClaims.map((s) => {
						const slotLabel =
							slots.filter((x) => x.kitId === s.kitId).length > 1
								? `**${s.kit.product_name} #${s.slotNumber}**`
								: `**${s.kit.product_name}**`;
						const claimLines = s.claims
							.map(
								(c) =>
									`  · <@${c.userId}> — ${CLAIM_STATUS_LABEL[c.status] ?? c.status}`,
							)
							.join("\n");
						return `${slotLabel} (${s.claims.length})\n${claimLines}`;
					});

					await interaction.reply({
						content: lines.join("\n\n"),
						flags: MessageFlags.Ephemeral,
					});
				} else {
					const summaries = await GbService.getGroupBuySummary(gb.id);
					const mine = summaries.filter(
						(s) => s.userId === interaction.user.id,
					);

					if (mine.length === 0) {
						await interaction.reply({
							content: "You have no active claims.",
							flags: MessageFlags.Ephemeral,
						});
						return;
					}

					await interaction.reply({
						embeds: [buildBalanceEmbed(mine, gb.inrConversionRate)],
						flags: MessageFlags.Ephemeral,
					});
				}
				return;
			}

			// /gb claims manage ──────────────────────────────────────────────────
			if (subcommand === "manage") {
				const { allowed } = checkOwner(interaction, gb);
				if (!allowed) {
					await interaction.reply({
						content: "Only the organiser can manage claims.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const slots = await GbService.getSlotsWithClaimCounts(gb.id);
				const contested = slots.filter((s) => s.claims.length > 1);
				const uncontested = slots.filter(
					(s) => s.claims.length === 1 && s.claims[0].status === "PENDING",
				);
				const resolvedSlots = slots.filter(
					(s) => s.claims.length === 1 && s.claims[0].status !== "PENDING",
				);
				const unclaimed = slots.filter((s) => s.claims.length === 0);

				const MAX_SELECTS = uncontested.length > 0 ? 4 : 5;
				const shown = contested.slice(0, MAX_SELECTS);

				// Build select menus for contested slots
				const selectRows = shown.map((gbk) => {
					const label = `${gbk.kit.product_name} #${gbk.slotNumber}`;
					const select = new StringSelectMenuBuilder()
						.setCustomId(`claims:resolve:${gbk.id}`)
						.setPlaceholder(`${label} — pick one claimant`)
						// BUG FIX: labels are plain text — show username format, not <@mention>
						.addOptions(
							gbk.claims.map((c) => ({
								label: `User ${c.userId}`,
								description: `Confirm for ${label}, cancel all others`,
								value: c.id,
							})),
						);
					return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
						select,
					);
				});

				const components: (
					| ActionRowBuilder<StringSelectMenuBuilder>
					| ActionRowBuilder<ButtonBuilder>
				)[] = [...selectRows];

				if (uncontested.length > 0) {
					const btn = new ButtonBuilder()
						.setCustomId("claims:confirm_uncontested")
						.setLabel(
							`Confirm ${uncontested.length} uncontested claim${uncontested.length !== 1 ? "s" : ""}`,
						)
						.setStyle(ButtonStyle.Success);
					components.push(
						new ActionRowBuilder<ButtonBuilder>().addComponents(btn),
					);
				}

				if (contested.length === 0) {
					const parts: string[] = [];
					if (resolvedSlots.length > 0) {
						parts.push(
							`✅ **Resolved:**\n${resolvedSlots
								.map(
									(k) =>
										`  · ${k.kit.product_name} #${k.slotNumber} → <@${k.claims[0].userId}> [${CLAIM_STATUS_LABEL[k.claims[0].status]}]`,
								)
								.join("\n")}`,
						);
					}
					if (unclaimed.length > 0) {
						parts.push(
							`⚠️ **Unclaimed slots:**\n${unclaimed.map((k) => `  · ${k.kit.product_name} #${k.slotNumber}`).join("\n")}`,
						);
					}

					const canAdvance =
						unclaimed.length === 0 &&
						resolvedSlots.length > 0 &&
						gb.status === "OPEN";
					const summary = parts.join("\n\n") || "No claims yet.";

					await interaction.reply({
						content: canAdvance
							? `${summary}\n\n✅ All slots filled. Use \`/gb setstatus\` to advance to **CLAIMED**.`
							: summary,
						components,
						flags: MessageFlags.Ephemeral,
					});
				} else {
					await interaction.reply({
						embeds: [
							buildConflictEmbed(
								contested.map((k) => ({
									kitName: k.kit.product_name,
									slotNumber: k.slotNumber,
									claims: k.claims,
								})),
								MAX_SELECTS,
								contested.length,
							),
						],
						components,
						flags: MessageFlags.Ephemeral,
					});
				}

				if (components.length > 0) {
					const message = await interaction.fetchReply();
					const collector = message.createMessageComponentCollector({
						time: 5 * 60_000,
					});

					collector.on("collect", async (i) => {
						if (i.isButton() && i.customId === "claims:confirm_uncontested") {
							const count = await GbService.confirmUncontestedClaims(gb.id);
							await i.reply({
								content: `✅ Confirmed ${count} uncontested claim${count !== 1 ? "s" : ""}.`,
								flags: MessageFlags.Ephemeral,
							});
							return;
						}

						if (
							i.isStringSelectMenu() &&
							i.customId.startsWith("claims:resolve:")
						) {
							const gbkId = i.customId.split(":")[2];
							const winnerClaimId = i.values[0];

							await GbService.resolveContestedSlot(gbkId, winnerClaimId);

							const stillContested = await GbService.getSlotsWithClaimCounts(
								gb.id,
							);
							const remaining = stillContested.filter(
								(s) => s.claims.length > 1,
							).length;

							await i.reply({
								content:
									remaining > 0
										? `✅ Conflict resolved. **${remaining}** slot${remaining !== 1 ? "s" : ""} still need resolution.`
										: "✅ All conflicts resolved. Use `/gb setstatus` to advance when ready.",
								flags: MessageFlags.Ephemeral,
							});
						}
					});

					collector.on("end", async (_collected, reason) => {
						if (reason === "time") {
							await interaction.editReply({ components: [] }).catch(() => {});
						}
					});
				}
				return;
			}

			// /gb claims unclaim ─────────────────────────────────────────────────
			if (subcommand === "unclaim") {
				const claimId = interaction.options.getString("claim", true);
				const claim = await import("../../lib/prisma.ts").then(({ prisma }) =>
					prisma.groupBuyClaim.findUnique({
						where: { id: claimId },
						include: { groupBuyKit: { include: { kit: true } } },
					}),
				);

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

				await GbService.cancelClaim(claimId);
				await interaction.reply({
					content: `Cancelled your claim for **${claim.groupBuyKit.kit.product_name}**.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// /gb claims transfer ────────────────────────────────────────────────
			if (subcommand === "transfer") {
				const { allowed, adminOverride } = checkOwner(interaction, gb);
				if (!allowed) {
					await interaction.reply({
						content: "Only the organiser can transfer claims.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				// BUG FIX: claimId is now correctly claim.id (service autocomplete returns claim.id)
				const claimId = interaction.options.getString("claim", true);
				const newUser = interaction.options.getUser("user", true);

				try {
					const claim = await GbService.transferClaim(claimId, newUser.id);
					const prisma = (await import("../../lib/prisma.ts")).prisma;
					const gbk = await prisma.groupBuyKit.findUnique({
						where: { id: claim.groupBuyKitId },
						include: { kit: true },
					});
					await interaction.reply(
						withOverrideNote(
							`Transferred **${gbk?.kit.product_name ?? "claim"}** to <@${newUser.id}>.`,
							adminOverride,
						),
					);
				} catch (err: any) {
					await interaction.reply({
						content: `❌ ${err.message}`,
						flags: MessageFlags.Ephemeral,
					});
				}
				return;
			}

			// /gb claims pay ─────────────────────────────────────────────────────
			if (subcommand === "pay") {
				const claimId = interaction.options.getString("claim", true);
				const stage = interaction.options.getString(
					"stage",
					true,
				) as PaymentStage;
				const note = interaction.options.getString("note") ?? undefined;

				const claim = await import("../../lib/prisma.ts").then(({ prisma }) =>
					prisma.groupBuyClaim.findUnique({ where: { id: claimId } }),
				);

				if (!claim || claim.userId !== interaction.user.id) {
					await interaction.reply({
						content: "Claim not found or not yours.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				await GbService.reportPayment(
					claimId,
					interaction.user.id,
					stage,
					note,
				);

				await interaction.reply({
					content:
						`✅ Your **${stage}** payment has been reported. ` +
						`The organiser will confirm it. Run \`/gb balance\` to track your payment status.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// /gb claims confirm ─────────────────────────────────────────────────
			if (subcommand === "confirm") {
				const { allowed, adminOverride } = checkOwnerOrBuyer(interaction, gb);
				if (!allowed) {
					await interaction.reply({
						content: "Only the organiser or buyer can confirm payments.",
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const claimId = interaction.options.getString("claim", true);
				const stage = interaction.options.getString(
					"stage",
					true,
				) as PaymentStage;
				const note = interaction.options.getString("note") ?? undefined;

				try {
					const { claim } = await GbService.confirmPaymentStage(
						claimId,
						interaction.user.id,
						stage,
						note,
					);

					// Auto-advance to PAID_IN_FULL if customs was the last stage
					// (or shipping, if no customs cost is set)
					const isLastStage =
						stage === "CUSTOMS" || (stage === "SHIPPING" && !gb.customsCost);

					if (isLastStage) {
						await GbService.markPaidInFull(claimId);
					}

					const statusLabel = isLastStage
						? CLAIM_STATUS_LABEL["PAID_IN_FULL"]
						: (CLAIM_STATUS_LABEL[claim.status] ?? claim.status);

					await interaction.reply(
						withOverrideNote(
							`✅ **${stage}** payment confirmed for <@${claim.userId}>. Status: ${statusLabel}`,
							adminOverride,
						),
					);
				} catch (err: any) {
					await interaction.reply({
						content: `❌ ${err.message}`,
						flags: MessageFlags.Ephemeral,
					});
				}
				return;
			}
		}
	},
} satisfies Command;
