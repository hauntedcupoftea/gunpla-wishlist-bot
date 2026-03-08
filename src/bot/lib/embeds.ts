/**
 * @module bot/lib/embeds
 *
 * Centralised Discord embed builders. All visual formatting for embeds lives
 * here so that command handlers stay thin and embeds are consistent and
 * easily updatable across the bot.
 */

import { EmbedBuilder } from "discord.js";
import type {
  ClaimCostBreakdown,
  GroupBuyFull,
} from "../../services/groupbuy.service.ts";
import type { GroupBuyKit, Kit } from "../../../generated/client.ts";
import { CLAIM_STATUS_LABEL, fmtCost, fmtJpy, fmtInr } from "../../lib/util.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  OPEN:            "🟢",
  CLAIMED:         "✅",
  LOCKED:          "🔒",
  PURCHASED:       "🛒",
  AT_WAREHOUSE:    "🏭",
  SHIPPED:         "🚢",
  AT_CUSTOMS:      "🛃",
  CLEARED_CUSTOMS: "✅",
  AT_RECEIVER:     "📦",
  COMPLETED:       "🎉",
  CANCELLED:       "❌",
};

const COLORS = {
  INFO:    0x2b82cb,
  WARNING: 0xe67e22,
  SUCCESS: 0x2ecc71,
  DANGER:  0xe74c3c,
} as const;

// ─── Group Buy embeds ─────────────────────────────────────────────────────────

/**
 * Builds the main Group Buy info embed shown by /gb info and /gb create.
 *
 * Shows:
 * - Status, organiser, buyer, receiver
 * - All kits with their MSRP
 * - Financials (cost price, warehouse, shipping, customs) with INR equivalents
 * - Tracking links
 * - A note on how to see per-claim costs (/gb balance)
 */
export function buildGroupBuyEmbed(gb: GroupBuyFull): EmbedBuilder {
  const kitLines =
    gb.kits.length > 0
      ? gb.kits
          .map((gbk: GroupBuyKit & { kit: Kit; claims: unknown[] }) => {
            const claimCount = gbk.claims.length;
            const label =
              gb.kits.filter((k: GroupBuyKit) => k.kitId === gbk.kitId).length > 1
                ? `${gbk.kit.product_name} #${gbk.slotNumber}`
                : gbk.kit.product_name;
            return `- **${label}** — MSRP ${fmtJpy(gbk.kit.jpy_price)} · ${claimCount} claim${claimCount !== 1 ? "s" : ""}`;
          })
          .join("\n")
      : "_No kits added yet._";

  const embed = new EmbedBuilder()
    .setTitle("Group Buy Summary")
    .setColor(COLORS.INFO)
    .addFields(
      {
        name: "Status",
        value: `${STATUS_EMOJI[gb.status] ?? "❓"} **${gb.status.replace(/_/g, " ")}**`,
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
      { name: `Kits (${gb.kits.length} slot${gb.kits.length !== 1 ? "s" : ""})`, value: kitLines },
    );

  // ── Financials ──────────────────────────────────────────────────────────
  const rate = gb.inrConversionRate ?? undefined;
  const financialLines: string[] = [];

  if (gb.costPrice != null)
    financialLines.push(`Kit cost: **${fmtCost(gb.costPrice, rate)}**`);
  if (gb.warehouseCost != null)
    financialLines.push(`Warehouse: **${fmtCost(gb.warehouseCost, rate)}**`);
  if (gb.shippingCost != null)
    financialLines.push(`Shipping: **${fmtCost(gb.shippingCost, rate)}**`);
  if (gb.customsCost != null)
    financialLines.push(`Customs: **${fmtCost(gb.customsCost, rate)}**`);
  if (gb.inrConversionRate != null)
    financialLines.push(`Rate: ¥1 = ₹${gb.inrConversionRate}`);
  if (gb.totalWeight != null)
    financialLines.push(`Total weight: ${gb.totalWeight.toLocaleString()}g`);

  if (financialLines.length > 0) {
    embed.addFields({ name: "Financials", value: financialLines.join("\n") });
  }

  // ── Tracking ────────────────────────────────────────────────────────────
  const trackingLines: string[] = [];
  if (gb.shippingTrackingNumber)
    trackingLines.push(`Tracking #: \`${gb.shippingTrackingNumber}\``);
  if (gb.shippingTrackingUrl)
    trackingLines.push(`[Shipping tracker](${gb.shippingTrackingUrl})`);
  if (gb.customsTrackingUrl)
    trackingLines.push(`[Customs tracker](${gb.customsTrackingUrl})`);

  if (trackingLines.length > 0) {
    embed.addFields({ name: "Tracking", value: trackingLines.join("\n") });
  }

  embed.addFields({
    name: "Your costs",
    value: "Run `/gb balance` to see your personal cost breakdown and payment status.",
  });

  embed.setFooter({ text: `GB ID: ${gb.id}` }).setTimestamp();
  return embed;
}

/**
 * Builds a personal cost breakdown embed for a single user's claims.
 * Shows per-kit costs, payment stage, and total owed in JPY + INR.
 *
 * Shown by /gb balance.
 */
export function buildBalanceEmbed(
  claims: ClaimCostBreakdown[],
  rate: number | null | undefined,
): EmbedBuilder {
  if (claims.length === 0) {
    return new EmbedBuilder()
      .setTitle("Your Balance")
      .setColor(COLORS.INFO)
      .setDescription("You have no active claims in this group buy.");
  }

  const embed = new EmbedBuilder()
    .setTitle("Your Balance")
    .setColor(COLORS.INFO);

  let grandTotal = 0;

  for (const c of claims) {
    const lines: string[] = [];

    const kitStatus = CLAIM_STATUS_LABEL[c.status] ?? c.status;
    lines.push(`**Status:** ${kitStatus}`);

    if (c.calculatedKitCost != null)
      lines.push(`Kit: ${fmtCost(c.calculatedKitCost, rate)}`);
    if (c.calculatedWarehouseCost != null)
      lines.push(`Warehouse: ${fmtCost(c.calculatedWarehouseCost, rate)}`);
    if (c.calculatedShippingCost != null)
      lines.push(`Shipping: ${fmtCost(c.calculatedShippingCost, rate)}`);
    if (c.calculatedCustomsCost != null)
      lines.push(`Customs: ${fmtCost(c.calculatedCustomsCost, rate)}`);

    if (c.totalJpy > 0) {
      lines.push(
        `**Total: ${fmtJpy(c.totalJpy)}${rate ? ` (${fmtInr(c.totalJpy * rate)})` : ""}**`,
      );
      grandTotal += c.totalJpy;
    } else {
      lines.push("_Costs not yet set by organiser._");
    }

    // Most recent payment event per stage
    const byStage = new Map<string, string>();
    for (const evt of c.paymentEvents) {
      byStage.set(evt.stage, `${evt.action}${evt.note ? ` — ${evt.note}` : ""}`);
    }
    if (byStage.size > 0) {
      lines.push(
        "\n**Payment log:**\n" +
          [...byStage.entries()]
            .map(([stage, action]) => `  ${stage}: ${action}`)
            .join("\n"),
      );
    }

    const title =
      claims.length > 1
        ? `${c.kitName} #${c.slotNumber}`
        : c.kitName;

    embed.addFields({ name: title, value: lines.join("\n") });
  }

  if (claims.length > 1 && grandTotal > 0) {
    embed.addFields({
      name: "Grand Total",
      value: `**${fmtJpy(grandTotal)}${rate ? ` (${fmtInr(grandTotal * rate)})` : ""}**`,
    });
  }

  return embed;
}

/**
 * Builds the organiser-facing payment summary embed (public, posted to thread).
 *
 * Shows each confirmed claimant with:
 * - Their kit(s)
 * - Itemised costs (kit / warehouse / shipping / customs)
 * - Total in JPY + INR
 * - Current payment status
 */
export function buildSummaryEmbed(
  gb: GroupBuyFull,
  summaries: ClaimCostBreakdown[],
): EmbedBuilder {
  const rate = gb.inrConversionRate;

  // Group by userId
  const byUser = new Map<string, ClaimCostBreakdown[]>();
  for (const s of summaries) {
    const existing = byUser.get(s.userId) ?? [];
    existing.push(s);
    byUser.set(s.userId, existing);
  }

  const embed = new EmbedBuilder()
    .setTitle("Payment Summary")
    .setColor(COLORS.SUCCESS);

  if (rate) {
    embed.setDescription(`Exchange rate: ¥1 = ₹${rate}`);
  }

  for (const [userId, claims] of byUser.entries()) {
    const kitTotal  = claims.reduce((s, c) => s + (c.calculatedKitCost ?? 0), 0);
    const whTotal   = claims.reduce((s, c) => s + (c.calculatedWarehouseCost ?? 0), 0);
    const shTotal   = claims.reduce((s, c) => s + (c.calculatedShippingCost ?? 0), 0);
    const cuTotal   = claims.reduce((s, c) => s + (c.calculatedCustomsCost ?? 0), 0);
    const grandJpy  = kitTotal + whTotal + shTotal + cuTotal;

    const lines: string[] = [];

    // Kit lines
    for (const c of claims) {
      const slotLabel =
        summaries.filter((s) => s.kitName === c.kitName).length > 1
          ? `${c.kitName} #${c.slotNumber}`
          : c.kitName;
      lines.push(`  · ${slotLabel} — ${CLAIM_STATUS_LABEL[c.status] ?? c.status}`);
    }

    // Cost breakdown
    const parts: string[] = [];
    if (kitTotal > 0)  parts.push(`Kit ${fmtJpy(kitTotal)}`);
    if (whTotal > 0)   parts.push(`Warehouse ${fmtJpy(whTotal)}`);
    if (shTotal > 0)   parts.push(`Shipping ${fmtJpy(shTotal)}`);
    if (cuTotal > 0)   parts.push(`Customs ${fmtJpy(cuTotal)}`);

    if (grandJpy > 0) {
      lines.push(
        `**Total: ${fmtJpy(grandJpy)}${rate ? ` (${fmtInr(grandJpy * rate)})` : ""}**` +
          (parts.length > 1 ? `\n  _${parts.join(" + ")}_` : ""),
      );
    } else {
      lines.push("_Costs not yet set._");
    }

    embed.addFields({ name: `<@${userId}>`, value: lines.join("\n") });
  }

  embed.setFooter({ text: `GB ID: ${gb.id}` }).setTimestamp();
  return embed;
}

/**
 * Builds the claim conflict resolution embed for /gb claims manage.
 * Shows contested slots (multiple claimants) with select menus to pick a winner.
 */
export function buildConflictEmbed(
  contested: { kitName: string; slotNumber: number; claims: { userId: string }[] }[],
  shown: number,
  total: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Claim Conflicts")
    .setColor(COLORS.WARNING)
    .setDescription(
      `${total} slot${total !== 1 ? "s have" : " has"} multiple claimants. ` +
        `Select one winner per slot — all others will be cancelled.\n\n` +
        contested
          .slice(0, shown)
          .map(
            (k) =>
              `**${k.kitName} #${k.slotNumber}** — ${k.claims.length} claimants: ` +
              k.claims.map((c) => `<@${c.userId}>`).join(", "),
          )
          .join("\n"),
    );

  if (total > shown) {
    embed.setFooter({
      text: `Showing ${shown} of ${total} conflicts. Run /gb claims manage again after resolving these.`,
    });
  }

  return embed;
}
