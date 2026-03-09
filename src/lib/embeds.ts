/**
 * @module bot/lib/embeds
 *
 * Centralised Discord embed builders.
 *
 * All visual formatting lives here so command handlers stay thin.
 * The summary embeds mirror the real GB spreadsheet layout:
 *
 *   Kit name | MSRP | % of total | Deal Price ¥ | INR
 *
 * The "deal price" (what's actually owed) is emphasised over MSRP, which
 * is shown only as context for the percentage calculation.
 */

import { EmbedBuilder } from "discord.js";
import type { GroupBuyKit, Kit } from "../../generated/client.ts";
import { CLAIM_STATUS_LABEL, fmtInr, fmtJpy, fmtPct } from "../lib/util.ts";
import type {
  ClaimCostBreakdown,
  GroupBuyFull,
} from "../services/groupbuy.service.ts";

const STATUS_EMOJI: Record<string, string> = {
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

const COLORS = {
  INFO: 0x2b82cb,
  WARNING: 0xe67e22,
  SUCCESS: 0x2ecc71,
  DANGER: 0xe74c3c,
} as const;

export function buildGroupBuyEmbed(gb: GroupBuyFull): EmbedBuilder {
  const kitLines = gb.kits.length > 0
    ? gb.kits
      .map((gbk: GroupBuyKit & { kit: Kit; claims: unknown[] }) => {
        const claimCount = gbk.claims.length;
        const isMultiSlot = gb.kits.filter((k: GroupBuyKit) =>
          k.kitId === gbk.kitId
        ).length >
          1;
        const label = isMultiSlot
          ? `${gbk.kit.product_name} #${gbk.slotNumber}`
          : gbk.kit.product_name;
        return `- **${label}** — MSRP ${
          fmtJpy(gbk.kit.jpy_price)
        } · ${claimCount} claim${claimCount !== 1 ? "s" : ""}`;
      })
      .join("\n")
    : "_No kits added yet._";

  const embed = new EmbedBuilder()
    .setTitle("Group Buy Overview")
    .setColor(COLORS.INFO)
    .addFields(
      {
        name: "Status",
        value: `${STATUS_EMOJI[gb.status] ?? "❓"} **${
          gb.status.replace(/_/g, " ")
        }**`,
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
      {
        name: `Kits — ${gb.kits.length} slot${gb.kits.length !== 1 ? "s" : ""}`,
        value: kitLines,
      },
    );

  const rate = gb.inrConversionRate ?? undefined;
  const financialLines: string[] = [];

  if (gb.costPrice != null) {
    financialLines.push(
      `Deal price: **${fmtJpy(gb.costPrice)}**${
        rate
          ? ` (₹${
            (gb.costPrice * rate).toLocaleString("en-IN", {
              maximumFractionDigits: 0,
            })
          })`
          : ""
      }`,
    );
  }
  if (gb.domesticShippingCost != null) {
    financialLines.push(
      `Domestic ship: **${fmtJpy(gb.domesticShippingCost)}**`,
    );
  }
  if (gb.shippingCost != null) {
    const shippingLine = [`Shipping: **${fmtJpy(gb.shippingCost)}**`];
    if (gb.shippingWeight) {
      shippingLine.push(`(${gb.shippingWeight.toLocaleString()}g actual)`);
    }
    financialLines.push(shippingLine.join(" "));
  }
  if (gb.customsCost != null) {
    financialLines.push(`Customs: **${fmtJpy(gb.customsCost)}**`);
  }
  if (gb.inrConversionRate != null) {
    financialLines.push(`Rate: ¥1 = ₹${gb.inrConversionRate}`);
  }
  if (gb.totalWeight != null) {
    financialLines.push(`Total weight: ${gb.totalWeight.toLocaleString()}g`);
  }

  if (financialLines.length > 0) {
    embed.addFields({ name: "Financials", value: financialLines.join("\n") });
  }

  // ── Tracking ────────────────────────────────────────────────────────────
  const trackingLines: string[] = [];
  if (gb.shippingTrackingNumber) {
    trackingLines.push(`Tracking #: \`${gb.shippingTrackingNumber}\``);
  }
  if (gb.shippingTrackingUrl) {
    trackingLines.push(`[Shipping tracker](${gb.shippingTrackingUrl})`);
  }
  if (gb.customsTrackingUrl) {
    trackingLines.push(`[Customs tracker](${gb.customsTrackingUrl})`);
  }
  if (trackingLines.length > 0) {
    embed.addFields({ name: "Tracking", value: trackingLines.join("\n") });
  }

  embed.addFields({
    name: "💡 Your costs",
    value:
      "Run `/gb balance` to see your personal cost breakdown and payment status.",
  });

  embed.setFooter({ text: `GB ID: ${gb.id}` }).setTimestamp();
  return embed;
}

// ─── Balance embed (personal view) ───────────────────────────────────────────

/**
 * Builds a personal cost breakdown embed for a single user's claims.
 *
 * Mirrors the spreadsheet row structure:
 *   Kit name | MSRP | % | Deal Price ¥ | INR
 *
 * The deal price (what they actually owe) is shown prominently.
 * MSRP is shown only as "list price" context.
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
  let grandInr = 0;

  for (const c of claims) {
    const lines: string[] = [];
    const kitStatus = CLAIM_STATUS_LABEL[c.status] ?? c.status;
    lines.push(`**Status:** ${kitStatus}`);

    // MSRP context line
    lines.push(`List price (MSRP): ${fmtJpy(c.msrpJpy)}`);

    // Only show deal price breakdown if cost data is available
    const hasData = c.calculatedKitCost != null ||
      c.calculatedDomesticShippingCost != null ||
      c.calculatedShippingCost != null ||
      c.calculatedCustomsCost != null;

    if (hasData) {
      if (c.msrpFraction != null) {
        lines.push(`Your share: **${fmtPct(c.msrpFraction)}** of total MSRP`);
      }

      const costLines: string[] = [];
      if (c.calculatedKitCost != null) {
        costLines.push(`Kit: ${fmtJpy(c.calculatedKitCost)}`);
      }
      if (c.calculatedDomesticShippingCost != null) {
        costLines.push(
          `Domestic ship: ${fmtJpy(c.calculatedDomesticShippingCost)}`,
        );
      }
      if (c.calculatedShippingCost != null) {
        costLines.push(`Shipping: ${fmtJpy(c.calculatedShippingCost)}`);
      }
      if (c.calculatedCustomsCost != null) {
        costLines.push(`Customs: ${fmtJpy(c.calculatedCustomsCost)}`);
      }
      if (costLines.length > 0) {
        lines.push(costLines.join(" · "));
      }

      if (c.totalJpy > 0) {
        const inrStr = c.totalInr != null ? ` (${fmtInr(c.totalInr)})` : "";
        lines.push(`**Total: ${fmtJpy(c.totalJpy)}${inrStr}**`);
        grandTotal += c.totalJpy;
        if (c.totalInr) grandInr += c.totalInr;
      }
    } else {
      lines.push("_Deal price not yet set by organiser._");
    }

    // Payment event log (most recent per stage)
    const byStage = new Map<string, string>();
    for (const evt of c.paymentEvents) {
      byStage.set(
        evt.stage,
        `${evt.action}${evt.note ? ` — ${evt.note}` : ""}`,
      );
    }
    if (byStage.size > 0) {
      lines.push(
        "\n**Payments:**\n" +
          [...byStage.entries()]
            .map(([stage, action]) => `  ${stage}: ${action}`)
            .join("\n"),
      );
    }

    const title = claims.length > 1
      ? `${c.kitName} #${c.slotNumber}`
      : c.kitName;

    embed.addFields({ name: title, value: lines.join("\n") });
  }

  if (claims.length > 1 && grandTotal > 0) {
    const inrStr = grandInr > 0 ? ` (${fmtInr(grandInr)})` : "";
    embed.addFields({
      name: "Grand Total",
      value: `**${fmtJpy(grandTotal)}${inrStr}**`,
    });
  }

  return embed;
}

// ─── Summary embed (organiser payment table) ──────────────────────────────────

/**
 * Builds the organiser-facing payment summary (posted publicly to thread).
 *
 * Each user gets one field. Per-claim rows mirror the spreadsheet:
 *   Kit name — MSRP (X.XX%) → Deal Price ¥ · INR — Status
 *
 * Sorted by least payment progress first so outstanding members are visible
 * at the top without the organiser needing to scroll.
 */
export function buildSummaryEmbed(
  gb: GroupBuyFull,
  summaries: ClaimCostBreakdown[],
): EmbedBuilder {
  const rate = gb.inrConversionRate;

  // Group by userId, preserving the sorted order from getGroupBuySummary
  const byUser = new Map<string, ClaimCostBreakdown[]>();
  for (const s of summaries) {
    const existing = byUser.get(s.userId) ?? [];
    existing.push(s);
    byUser.set(s.userId, existing);
  }

  const embed = new EmbedBuilder()
    .setTitle("Payment Summary")
    .setColor(COLORS.SUCCESS);

  const headerParts: string[] = [];
  if (gb.costPrice != null) {
    headerParts.push(`Deal price: ${fmtJpy(gb.costPrice)}`);
  }
  if (rate) headerParts.push(`Rate: ¥1 = ₹${rate}`);
  if (gb.shippingCost != null) {
    headerParts.push(`Shipping: ${fmtJpy(gb.shippingCost)}`);
  }
  if (gb.customsCost != null) {
    headerParts.push(`Customs: ${fmtJpy(gb.customsCost)}`);
  }

  if (headerParts.length > 0) {
    embed.setDescription(headerParts.join(" · "));
  }

  for (const [userId, claims] of byUser.entries()) {
    const grandJpy = claims.reduce((s, c) => s + c.totalJpy, 0);
    const grandInr = rate && grandJpy ? Math.round(grandJpy * rate) : null;

    const lines: string[] = [];

    for (const c of claims) {
      // Kit line: Name — MSRP (X.XX%) → Deal ¥ · ₹INR
      const pct = c.msrpFraction != null ? ` (${fmtPct(c.msrpFraction)})` : "";
      const dealStr = c.totalJpy > 0 ? `→ **${fmtJpy(c.totalJpy)}**` : "";
      const inrStr = c.totalInr != null ? ` · ${fmtInr(c.totalInr)}` : "";
      const slotLabel = claims.filter((x) => x.kitName === c.kitName).length > 1
        ? `${c.kitName} #${c.slotNumber}`
        : c.kitName;

      lines.push(
        `**${slotLabel}** — ${fmtJpy(c.msrpJpy)}${pct} ${dealStr}${inrStr}`,
      );

      // Itemised breakdown on second line if multiple cost types
      const nonZeroCosts = [
        c.calculatedKitCost && `Kit ${fmtJpy(c.calculatedKitCost)}`,
        c.calculatedDomesticShippingCost &&
        `Dom ${fmtJpy(c.calculatedDomesticShippingCost)}`,
        c.calculatedShippingCost && `Ship ${fmtJpy(c.calculatedShippingCost)}`,
        c.calculatedCustomsCost && `Customs ${fmtJpy(c.calculatedCustomsCost)}`,
      ].filter(Boolean);

      if (nonZeroCosts.length > 1) {
        lines.push(`  _${nonZeroCosts.join(" + ")}_`);
      }

      lines.push(`  ${CLAIM_STATUS_LABEL[c.status] ?? c.status}`);
    }

    // Per-user grand total
    if (grandJpy > 0) {
      const inrStr = grandInr ? ` (${fmtInr(grandInr)})` : "";
      lines.push(`\n**Total: ${fmtJpy(grandJpy)}${inrStr}**`);
    }

    embed.addFields({ name: `<@${userId}>`, value: lines.join("\n") });
  }

  embed.setFooter({ text: `GB ID: ${gb.id}` }).setTimestamp();
  return embed;
}

// ─── Conflict resolution embed ────────────────────────────────────────────────

/**
 * Builds the claim conflict resolution embed for /gb claims manage.
 * Shows contested slots (multiple claimants) with select menus to pick a winner.
 */
export function buildConflictEmbed(
  contested: {
    kitName: string;
    slotNumber: number;
    claims: { userId: string }[];
  }[],
  shown: number,
  total: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Claim Conflicts")
    .setColor(COLORS.WARNING)
    .setDescription(
      `**${total} slot${
        total !== 1 ? "s have" : " has"
      } multiple claimants.** ` +
        `Use the dropdowns below to pick one winner per slot — all others will be cancelled.\n\n` +
        contested
          .slice(0, shown)
          .map(
            (k) =>
              `**${k.kitName}${
                k.slotNumber > 1 ? ` #${k.slotNumber}` : ""
              }** — ${k.claims.length} claimants: ` +
              k.claims.map((c) => `<@${c.userId}>`).join(", "),
          )
          .join("\n"),
    );

  if (total > shown) {
    embed.setFooter({
      text:
        `Showing ${shown} of ${total} conflicts. Run /gb claims manage again after resolving these.`,
    });
  }

  return embed;
}
