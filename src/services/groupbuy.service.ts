/**
 * @module groupbuy.service
 *
 * All database operations for GroupBuys, GroupBuyKits, GroupBuyClaims,
 * and ClaimPaymentEvents.
 *
 * ## Design principles
 *
 * - **All financial recalculation is global.** Whenever any financial field
 *   (costPrice, domesticShippingCost, shippingCost, customsCost) changes, ALL active
 *   claims are recalculated in a single transaction. This ensures claim splits
 *   are always internally consistent — no stale proportions.
 *
 * - **Shipping split uses claim weights, not shippingWeight.** GroupBuy
 *   .shippingWeight is the courier-weighed parcel weight stored for display /
 *   cost entry only. The split denominator is the sum of each active claim's
 *   kit weight, so proportions always sum to 100% regardless of packaging
 *   overage.
 *
 * - **MSRP-proportion splits** (kit cost, domestic shipping, customs) use the sum of
 *   jpy_price across ALL slots in the group buy — not just claimed slots.
 *   This reflects the proxy-buy model: the organiser purchases the entire
 *   listing regardless of how many slots are claimed, so every slot's MSRP
 *   is part of the cost pool. A claimant's share is always
 *   `their kit MSRP / total listing MSRP`, regardless of other claims.
 *
 * - **Shipping and weight splits** likewise use ALL slots' weight as the
 *   denominator, since the full parcel is shipped regardless of claim count.
 *
 * - **Summary views prioritise the deal price** (calculatedKitCost etc.) over
 *   raw MSRP, matching the spreadsheet: Percentage → Deal Price YEN → INR.
 *
 * - **Payment stage validation** prevents out-of-order confirmations and blocks
 *   reporting on stages that haven't been unlocked by the organiser yet.
 */

import type {
  ClaimPaymentEvent,
  GroupBuy,
  GroupBuyClaim,
  GroupBuyKit,
  Kit,
} from "../../generated/client.ts";
import type {
  ClaimStatus,
  GroupBuyStatus,
  PaymentStage,
} from "../../generated/enums.ts";
import { prisma } from "../lib/prisma.ts";
import { CLAIM_STATUS_LABEL, kitNameFilter } from "../lib/util.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type GroupBuyFull = GroupBuy & {
  kits: (GroupBuyKit & { kit: Kit; claims: GroupBuyClaim[] })[];
  claims: (GroupBuyClaim & {
    groupBuyKit: GroupBuyKit & { kit: Kit };
    paymentEvents: ClaimPaymentEvent[];
  })[];
};

/**
 * One row of the payment summary — mirrors the spreadsheet columns:
 *
 * | Kit name | MSRP | % of total MSRP | Deal Price YEN | INR |
 *
 * The `calculated*` fields are the deal-price splits (not MSRP).
 * `msrpFraction` is the percentage column.
 * `dealPriceJpy` is the sum of all calculated costs (= "Deal Price YEN" column
 * for a single-kit claimant, or the per-kit portion for multi-kit organisers).
 */
export interface ClaimCostBreakdown {
  claimId: string;
  userId: string;
  kitName: string;
  itemCode: string;
  slotNumber: number;
  status: ClaimStatus;
  /** Kit MSRP in JPY — the "MSRP" column. */
  msrpJpy: number;
  /**
   * This claim's kit MSRP as a fraction of total active-claim MSRP.
   * Multiply by 100 for the "Percentage" column (e.g. 0.1036 → "10.36%").
   * Null when no active claims exist (edge case).
   */
  msrpFraction: number | null;
  /** This claim's share of kit cost (from costPrice). "Deal Price YEN" component. */
  calculatedKitCost: number | null;
  /** This claim's share of domestic shipping cost. */
  calculatedDomesticShippingCost: number | null;
  /** This claim's share of shipping cost. */
  calculatedShippingCost: number | null;
  /** This claim's share of customs cost. */
  calculatedCustomsCost: number | null;
  /**
   * Sum of all non-null calculated costs — the "Deal Price YEN" total for
   * this claim. 0 if no financial fields are set yet.
   */
  totalJpy: number;
  /**
   * INR equivalent: totalJpy × GroupBuy.inrConversionRate.
   * Null if conversion rate not set.
   */
  totalInr: number | null;
  /** Full ordered payment event log for this claim. */
  paymentEvents: ClaimPaymentEvent[];
}

export interface CreateGroupBuyInput {
  threadId: string;
  guildId: string;
  ownerId: string;
}

export interface AddKitInput {
  groupBuyId: string;
  kitId: string;
  weightGrams: number;
  quantity: number;
}

export interface SetFinancialsInput {
  costPrice?: number | null;
  domesticShippingCost?: number | null;
  shippingCost?: number | null;
  shippingWeight?: number | null;
  customsCost?: number | null;
  inrConversionRate?: number | null;
}

export interface SetTrackingInput {
  shippingTrackingNumber?: string | null;
  shippingTrackingUrl?: string | null;
  customsTrackingUrl?: string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function fetchActiveClaims(groupBuyId: string) {
  return prisma.groupBuyClaim.findMany({
    where: {
      groupBuyId,
      status: { not: "CANCELLED" },
    },
    include: {
      groupBuyKit: { include: { kit: true } },
      paymentEvents: { orderBy: { createdAt: "asc" } },
    },
  });
}

/**
 * Recalculates and persists cost splits for ALL active claims in a group buy.
 *
 * Called inside a transaction after any financial mutation.
 *
 * ### Split formulas
 *
 * The denominator is ALWAYS the full listing — all slots — because the
 * organiser purchases the entire proxy listing regardless of how many slots
 * have claimants. Each slot's share of the deal price is fixed by its MSRP
 * relative to the total listing MSRP.
 *
 * - Kit cost, domestic shipping, customs:
 *     fraction = slot.kit.jpy_price / sum(ALL slots' kit.jpy_price)
 *
 * - Shipping:
 *     fraction = slot.weight_grams / sum(ALL slots' weight_grams)
 *
 * A null GB financial field results in null on ALL claims for that component.
 */
async function recalculateAllClaims(gb: GroupBuy): Promise<void> {
  const claims = await fetchActiveClaims(gb.id);
  if (claims.length === 0) return;

  // Denominator = ALL slots in the GB (full listing), not just claimed ones
  const allSlots = await prisma.groupBuyKit.findMany({
    where: { groupBuyId: gb.id },
    include: { kit: true },
  });

  const totalMsrp = allSlots.reduce((sum, s) => sum + s.kit.jpy_price, 0);
  const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);

  await prisma.$transaction(
    claims.map((claim) => {
      const msrpFraction = totalMsrp > 0
        ? claim.groupBuyKit.kit.jpy_price / totalMsrp
        : 0;
      const weightFraction = totalWeight > 0
        ? claim.groupBuyKit.weight_grams / totalWeight
        : 0;

      return prisma.groupBuyClaim.update({
        where: { id: claim.id },
        data: {
          calculatedKitCost: gb.costPrice != null
            ? Math.round(msrpFraction * gb.costPrice)
            : null,
          calculatedDomesticShippingCost: gb.domesticShippingCost != null
            ? Math.round(msrpFraction * gb.domesticShippingCost)
            : null,
          calculatedShippingCost: gb.shippingCost != null
            ? Math.round(weightFraction * gb.shippingCost)
            : null,
          calculatedCustomsCost: gb.customsCost != null
            ? Math.round(msrpFraction * gb.customsCost)
            : null,
        },
      });
    }),
  );
}

/**
 * Validates that the given payment stage can be reported on by a member
 * (i.e. the organiser has set the relevant financial field).
 *
 * @throws Error with a descriptive message if the stage is not yet open.
 */
function assertStageIsOpen(gb: GroupBuy, stage: PaymentStage): void {
  const stageChecks: Partial<Record<PaymentStage, boolean>> = {
    KIT: gb.costPrice != null,
    DOMESTIC_SHIPPING: gb.domesticShippingCost != null,
    SHIPPING: gb.shippingCost != null,
    CUSTOMS: gb.customsCost != null,
  };
  const stageNames: Record<string, string> = {
    KIT: "kit cost",
    DOMESTIC_SHIPPING: "domestic shipping",
    SHIPPING: "shipping cost",
    CUSTOMS: "customs cost",
  };

  if (!stageChecks[stage]) {
    throw new Error(
      `The ${
        stageNames[stage] ?? stage
      } has not been set by the organiser yet. ` +
        `Payment cannot be reported until the organiser enters this amount.`,
    );
  }
}

/**
 * Validates that the given payment stage can be confirmed by the organiser
 * (i.e. the member has actually reported payment for that stage).
 *
 * @throws Error if no pending REPORTED event exists for this stage.
 */
async function assertStageWasReported(
  claimId: string,
  stage: PaymentStage,
): Promise<void> {
  const lastEvent = await prisma.claimPaymentEvent.findFirst({
    where: { claimId, stage },
    orderBy: { createdAt: "desc" },
  });

  if (!lastEvent) {
    throw new Error(
      `No payment has been reported by the member for the ${stage} stage yet.`,
    );
  }
  if (lastEvent.action === "CONFIRMED") {
    throw new Error(`The ${stage} payment has already been confirmed.`);
  }
  if (lastEvent.action !== "REPORTED") {
    throw new Error(
      `The ${stage} payment was rejected. The member must re-report before you can confirm.`,
    );
  }
}

// ─── Group Buy CRUD ───────────────────────────────────────────────────────────

/**
 * Creates a new group buy anchored to a Discord forum thread.
 * @throws If a group buy already exists for this threadId (unique constraint).
 */
export async function createGroupBuy(
  input: CreateGroupBuyInput,
): Promise<GroupBuy> {
  return prisma.groupBuy.create({
    data: {
      threadId: input.threadId,
      guildId: input.guildId,
      ownerId: input.ownerId,
    },
  });
}

/**
 * Retrieves a group buy by its Discord thread ID, fully populated with
 * kits (and their active claims) and top-level claims with payment events.
 *
 * @returns null if no group buy exists for this thread.
 */
export async function getGroupBuyByThread(
  threadId: string,
): Promise<GroupBuyFull | null> {
  return prisma.groupBuy.findUnique({
    where: { threadId },
    include: {
      kits: {
        include: {
          kit: true,
          claims: { where: { status: { not: "CANCELLED" } } },
        },
        orderBy: [{ kitId: "asc" }, { slotNumber: "asc" }],
      },
      claims: {
        include: {
          groupBuyKit: { include: { kit: true } },
          paymentEvents: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  }) as Promise<GroupBuyFull | null>;
}

/**
 * Retrieves a group buy by its internal UUID, fully populated.
 */
export async function getGroupBuyById(
  id: string,
): Promise<GroupBuyFull | null> {
  return prisma.groupBuy.findUnique({
    where: { id },
    include: {
      kits: {
        include: {
          kit: true,
          claims: { where: { status: { not: "CANCELLED" } } },
        },
        orderBy: [{ kitId: "asc" }, { slotNumber: "asc" }],
      },
      claims: {
        include: {
          groupBuyKit: { include: { kit: true } },
          paymentEvents: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  }) as Promise<GroupBuyFull | null>;
}

/**
 * Returns all group buys in a guild, ordered newest-first.
 */
export async function listGroupBuysByGuild(
  guildId: string,
): Promise<GroupBuy[]> {
  return prisma.groupBuy.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Updates the group buy status.
 */
export async function setGroupBuyStatus(
  id: string,
  status: GroupBuyStatus,
): Promise<GroupBuy> {
  return prisma.groupBuy.update({ where: { id }, data: { status } });
}

/**
 * Sets the buyer (payment aggregator) for a group buy.
 */
export async function setGroupBuyBuyer(
  id: string,
  buyerId: string,
): Promise<GroupBuy> {
  return prisma.groupBuy.update({ where: { id }, data: { buyerId } });
}

/**
 * Sets the receiver (parcel recipient) for a group buy.
 */
export async function setGroupBuyReceiver(
  id: string,
  receiverId: string,
): Promise<GroupBuy> {
  return prisma.groupBuy.update({ where: { id }, data: { receiverId } });
}

/**
 * Transfers organiser ownership of a group buy to a new user.
 */
export async function transferGroupBuyOwnership(
  id: string,
  newOwnerId: string,
): Promise<GroupBuy> {
  return prisma.groupBuy.update({
    where: { id },
    data: { ownerId: newOwnerId },
  });
}

// ─── Financials ───────────────────────────────────────────────────────────────

/**
 * Updates one or more financial fields on a group buy and immediately
 * recalculates cost splits across ALL active claims.
 *
 * This is the single entry point for all financial mutations. Every financial
 * change goes through here to guarantee claim snapshots are always consistent.
 *
 * Pass `null` explicitly to clear a field (e.g. `domesticShippingCost: null` to
 * remove the domestic shipping). Omitting a field leaves it unchanged.
 *
 * @param id     - GroupBuy UUID.
 * @param fields - Partial financial update.
 */
export async function updateFinancials(
  id: string,
  fields: SetFinancialsInput,
): Promise<GroupBuy> {
  // Strip `undefined` — only pass fields explicitly provided
  const data = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );

  const gb = await prisma.groupBuy.update({ where: { id }, data });
  await recalculateAllClaims(gb);
  return gb;
}

/**
 * Sets tracking details (shipping + customs) without triggering recalculation.
 */
export async function updateTracking(
  id: string,
  fields: SetTrackingInput,
): Promise<GroupBuy> {
  const data = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );
  return prisma.groupBuy.update({ where: { id }, data });
}

// ─── Kit slots ────────────────────────────────────────────────────────────────

/**
 * Adds one or more slots of the same kit to a group buy.
 *
 * Slot numbers are assigned sequentially after the highest existing slot for
 * this (groupBuyId, kitId) pair. After adding, `totalWeight` is updated and
 * all claim costs are recalculated if any financials are set.
 *
 * @returns The newly created GroupBuyKit rows.
 */
export async function addKitToGroupBuy(
  input: AddKitInput,
): Promise<GroupBuyKit[]> {
  const { groupBuyId, kitId, weightGrams, quantity } = input;

  const lastSlot = await prisma.groupBuyKit.findFirst({
    where: { groupBuyId, kitId },
    orderBy: { slotNumber: "desc" },
    select: { slotNumber: true },
  });
  const nextSlot = (lastSlot?.slotNumber ?? 0) + 1;

  await prisma.groupBuyKit.createMany({
    data: Array.from({ length: quantity }, (_, i) => ({
      groupBuyId,
      kitId,
      weight_grams: weightGrams,
      slotNumber: nextSlot + i,
    })),
  });

  const allSlots = await prisma.groupBuyKit.findMany({ where: { groupBuyId } });
  const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);
  const gb = await prisma.groupBuy.update({
    where: { id: groupBuyId },
    data: { totalWeight },
  });

  if (
    gb.costPrice != null || gb.shippingCost != null || gb.customsCost != null ||
    gb.domesticShippingCost != null
  ) {
    await recalculateAllClaims(gb);
  }

  return prisma.groupBuyKit.findMany({
    where: { groupBuyId, kitId, slotNumber: { gte: nextSlot } },
    orderBy: { slotNumber: "asc" },
  });
}

/**
 * Removes a specified number of unclaimed slots for a kit from a group buy.
 * Only slots with no active (non-cancelled) claims can be removed.
 *
 * Slots with the highest slot numbers are removed first (LIFO), to preserve
 * contiguous numbering for lower slots that may have claims.
 *
 * @param groupBuyId - GroupBuy UUID.
 * @param kitId      - Kit UUID (Kit.id, NOT GroupBuyKit.id).
 * @param quantity   - Number of slots to remove (default: 1).
 * @throws If fewer unclaimed slots exist than requested.
 */
export async function removeKitFromGroupBuy(
  groupBuyId: string,
  kitId: string,
  quantity = 1,
): Promise<{ removed: number; totalWeight: number; kitName: string }> {
  const unclaimed = await prisma.groupBuyKit.findMany({
    where: {
      groupBuyId,
      kitId,
      claims: { none: { status: { not: "CANCELLED" } } },
    },
    include: { kit: true },
    orderBy: { slotNumber: "desc" }, // Remove highest slots first (LIFO)
    take: quantity,
  });

  if (unclaimed.length < quantity) {
    const total = await prisma.groupBuyKit.count({
      where: { groupBuyId, kitId },
    });
    throw new Error(
      `Only ${unclaimed.length} of ${total} slot(s) are unclaimed — cannot remove ${quantity}.`,
    );
  }

  const kitName = unclaimed[0].kit.product_name;
  await prisma.groupBuyKit.deleteMany({
    where: { id: { in: unclaimed.map((s) => s.id) } },
  });

  const allSlots = await prisma.groupBuyKit.findMany({ where: { groupBuyId } });
  const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);
  const gb = await prisma.groupBuy.update({
    where: { id: groupBuyId },
    data: { totalWeight },
  });

  if (
    gb.costPrice != null || gb.shippingCost != null || gb.customsCost != null ||
    gb.domesticShippingCost != null
  ) {
    await recalculateAllClaims(gb);
  }

  return { removed: unclaimed.length, totalWeight, kitName };
}

/**
 * Returns autocomplete-friendly kit options for /gb removekit.
 * Value is Kit.id (NOT GroupBuyKit.id).
 */
export async function getRemovableKitsForGroupBuy(
  threadId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const slots = await prisma.groupBuyKit.findMany({
    where: {
      groupBuy: { threadId },
      ...(query ? { kit: kitNameFilter(query) } : {}),
    },
    include: {
      kit: true,
      claims: { where: { status: { not: "CANCELLED" } } },
    },
    take: 25,
  });

  // Aggregate by kitId — show unclaimed slot count to help the organiser
  const byKit = new Map<
    string,
    { name: string; total: number; unclaimed: number }
  >();
  for (const s of slots) {
    const entry = byKit.get(s.kitId) ?? {
      name: s.kit.product_name,
      total: 0,
      unclaimed: 0,
    };
    entry.total++;
    if (s.claims.length === 0) entry.unclaimed++;
    byKit.set(s.kitId, entry);
  }

  return [...byKit.entries()]
    .filter(([, v]) => v.unclaimed > 0)
    .slice(0, 5)
    .map(([kitId, { name, total, unclaimed }]) => ({
      name: `${name} (${unclaimed} unclaimed / ${total} slots)`,
      value: kitId,
    }));
}

// ─── Claims ───────────────────────────────────────────────────────────────────

/**
 * Creates a claim for a user on the best available slot of a kit.
 *
 * "Best" = slot with the fewest active claims, tie-broken by slotNumber asc.
 * This distributes contention evenly across slots when multiple people claim
 * the same kit.
 *
 * Immediately recalculates all active claim costs if any financials are set.
 *
 * @throws If the user already has an active claim for any slot of this kit.
 * @throws If the kit has no slots in this group buy.
 */
export async function claimKit(
  groupBuyId: string,
  kitId: string,
  userId: string,
): Promise<GroupBuyClaim> {
  const existing = await prisma.groupBuyClaim.findFirst({
    where: {
      groupBuyId,
      userId,
      status: { not: "CANCELLED" },
      groupBuyKit: { kitId },
    },
  });
  if (existing) {
    throw new Error("You already have an active claim for this kit.");
  }

  const slots = await prisma.groupBuyKit.findMany({
    where: { groupBuyId, kitId },
    include: {
      claims: { where: { status: { not: "CANCELLED" } } },
    },
    orderBy: { slotNumber: "asc" },
  });

  if (slots.length === 0) {
    throw new Error("This kit has no slots in the group buy.");
  }

  const bestSlot = slots.reduce((best, slot) =>
    slot.claims.length < best.claims.length ? slot : best
  );

  const claim = await prisma.groupBuyClaim.create({
    data: { groupBuyId, groupBuyKitId: bestSlot.id, userId },
  });

  const gb = await prisma.groupBuy.findUnique({ where: { id: groupBuyId } });
  if (
    gb &&
    (gb.costPrice != null || gb.shippingCost != null ||
      gb.customsCost != null || gb.domesticShippingCost != null)
  ) {
    await recalculateAllClaims(gb);
  }

  return claim;
}

/**
 * Cancels a claim. Recalculates remaining active claim costs.
 */
export async function cancelClaim(claimId: string): Promise<GroupBuyClaim> {
  const claim = await prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "CANCELLED" },
  });

  const gb = await prisma.groupBuy.findUnique({
    where: { id: claim.groupBuyId },
  });
  if (
    gb &&
    (gb.costPrice != null || gb.shippingCost != null ||
      gb.customsCost != null || gb.domesticShippingCost != null)
  ) {
    await recalculateAllClaims(gb);
  }

  return claim;
}

/**
 * Confirms a pending claim (organiser action). Does not affect payment stages.
 */
export async function confirmClaim(claimId: string): Promise<GroupBuyClaim> {
  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "CONFIRMED" },
  });
}

/**
 * Confirms all PENDING, uncontested claims in a group buy in one transaction.
 * "Uncontested" = the slot has exactly one active claim.
 *
 * @returns Number of claims confirmed.
 */
export async function confirmUncontestedClaims(
  groupBuyId: string,
): Promise<number> {
  const kits = await prisma.groupBuyKit.findMany({
    where: { groupBuyId },
    include: {
      claims: { where: { status: { not: "CANCELLED" } } },
    },
  });

  const uncontested = kits
    .filter((k) => k.claims.length === 1 && k.claims[0].status === "PENDING")
    .map((k) => k.claims[0].id);

  if (uncontested.length === 0) return 0;

  await prisma.groupBuyClaim.updateMany({
    where: { id: { in: uncontested } },
    data: { status: "CONFIRMED" },
  });

  return uncontested.length;
}

/**
 * Resolves a contested slot: confirms one claim, cancels all others for
 * that slot. Recalculates costs after cancellations.
 *
 * @param groupBuyKitId - The GroupBuyKit slot UUID (NOT Kit.id).
 * @param winnerClaimId - The claim UUID to confirm as winner.
 */
export async function resolveContestedSlot(
  groupBuyKitId: string,
  winnerClaimId: string,
): Promise<void> {
  // Get the groupBuyId for recalculation
  const gbk = await prisma.groupBuyKit.findUnique({
    where: { id: groupBuyKitId },
    select: { groupBuyId: true },
  });

  await prisma.$transaction([
    prisma.groupBuyClaim.update({
      where: { id: winnerClaimId },
      data: { status: "CONFIRMED" },
    }),
    prisma.groupBuyClaim.updateMany({
      where: {
        groupBuyKitId,
        id: { not: winnerClaimId },
        status: { not: "CANCELLED" },
      },
      data: { status: "CANCELLED" },
    }),
  ]);

  // Recalculate now that losers are cancelled
  if (gbk) {
    const gb = await prisma.groupBuy.findUnique({
      where: { id: gbk.groupBuyId },
    });
    if (
      gb &&
      (gb.costPrice != null || gb.shippingCost != null ||
        gb.customsCost != null || gb.domesticShippingCost != null)
    ) {
      await recalculateAllClaims(gb);
    }
  }
}

/**
 * Transfers an existing claim to a different user.
 *
 * Performs duplicate-protection: the target user must not already have an
 * active claim for the same kit in this group buy.
 *
 * @param claimId   - Claim UUID to transfer.
 * @param newUserId - Discord user ID of the new claimant.
 */
export async function transferClaim(
  claimId: string,
  newUserId: string,
): Promise<GroupBuyClaim> {
  const claim = await prisma.groupBuyClaim.findUnique({
    where: { id: claimId },
    include: { groupBuyKit: { include: { kit: true } } },
  });
  if (!claim) throw new Error("Claim not found.");

  const conflict = await prisma.groupBuyClaim.findFirst({
    where: {
      groupBuyId: claim.groupBuyId,
      userId: newUserId,
      status: { not: "CANCELLED" },
      groupBuyKit: { kitId: claim.groupBuyKit.kitId },
      id: { not: claimId },
    },
  });
  if (conflict) {
    throw new Error(
      `${newUserId} already has an active claim for ${claim.groupBuyKit.kit.product_name} in this group buy.`,
    );
  }

  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { userId: newUserId },
  });
}

// ─── Payment events ───────────────────────────────────────────────────────────

/**
 * Records a member's self-reported payment for a stage.
 *
 * Validates that:
 * 1. The stage is open (organiser has set the relevant financial field).
 * 2. The claim is in a state that allows reporting this stage.
 *
 * Does NOT advance the claim status — the organiser must confirm separately.
 *
 * @param claimId - Claim UUID.
 * @param actorId - Discord user ID of the member reporting payment.
 * @param stage   - Which payment stage they're reporting.
 * @param note    - Optional note (e.g. UTR number, screenshot link).
 */
export async function reportPayment(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<ClaimPaymentEvent> {
  // Fetch GB to validate stage is open
  const claim = await prisma.groupBuyClaim.findUnique({
    where: { id: claimId },
    include: { groupBuy: true },
  });
  if (!claim) throw new Error("Claim not found.");

  assertStageIsOpen(claim.groupBuy, stage);

  // Check for duplicate reporting (already confirmed)
  const lastEvent = await prisma.claimPaymentEvent.findFirst({
    where: { claimId, stage },
    orderBy: { createdAt: "desc" },
  });
  if (lastEvent?.action === "CONFIRMED") {
    throw new Error(`The ${stage} payment has already been confirmed.`);
  }

  return prisma.claimPaymentEvent.create({
    data: { claimId, stage, action: "REPORTED", actorId, note: note ?? null },
  });
}

/**
 * Confirms a member's reported payment (organiser action).
 *
 * Validates that:
 * 1. The stage has been reported by the member.
 * 2. The stage has not already been confirmed.
 *
 * Advances the claim status to the corresponding `*_PAID` state.
 *
 * @param claimId - Claim UUID to confirm payment on.
 * @param actorId - Discord user ID of the organiser confirming.
 * @param stage   - Which payment stage to confirm.
 * @param note    - Optional note.
 */
export async function confirmPaymentStage(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<{ claim: GroupBuyClaim; event: ClaimPaymentEvent }> {
  await assertStageWasReported(claimId, stage);

  const stageToStatus: Record<string, ClaimStatus> = {
    KIT: "KIT_PAID",
    DOMESTIC_SHIPPING: "DOMESTIC_SHIPPING_PAID",
    SHIPPING: "SHIPPING_PAID",
    CUSTOMS: "CUSTOMS_PAID",
  };

  const newStatus = stageToStatus[stage];
  if (!newStatus) throw new Error(`Unknown payment stage: ${stage}`);

  const [claim, event] = await prisma.$transaction([
    prisma.groupBuyClaim.update({
      where: { id: claimId },
      data: { status: newStatus },
    }),
    prisma.claimPaymentEvent.create({
      data: {
        claimId,
        stage,
        action: "CONFIRMED",
        actorId,
        note: note ?? null,
      },
    }),
  ]);

  return { claim, event };
}

/**
 * Rejects a member's payment report (organiser action).
 * Records a REJECTED event. Claim status is unchanged — the member must
 * re-report.
 */
export async function rejectPaymentReport(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<ClaimPaymentEvent> {
  return prisma.claimPaymentEvent.create({
    data: { claimId, stage, action: "REJECTED", actorId, note: note ?? null },
  });
}

/**
 * Marks a claim as PAID_IN_FULL (terminal success state).
 * Called automatically after the final payment stage is confirmed.
 */
export async function markPaidInFull(claimId: string): Promise<GroupBuyClaim> {
  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "PAID_IN_FULL" },
  });
}

// ─── Read / reporting ─────────────────────────────────────────────────────────

/**
 * Returns a full cost breakdown for every active claim in a group buy.
 *
 * This is the primary read model for both the bot's `/gb summary` and the
 * API's summary endpoint. It mirrors the spreadsheet structure:
 *
 * | Kit name | MSRP | Percentage | Deal Price YEN | INR |
 *
 * Results are ordered by:
 * 1. Payment status (least advanced first, so outstanding items surface early)
 * 2. userId (consistent grouping for per-user views)
 * 3. slotNumber (consistent ordering within a user's claims)
 *
 * @param groupBuyId - GroupBuy UUID.
 * @param rate       - JPY → INR conversion rate override. If null, uses the
 *                     GB's stored rate. Pass explicitly for display formatting.
 */
export async function getGroupBuySummary(
  groupBuyId: string,
  rate?: number | null,
): Promise<ClaimCostBreakdown[]> {
  const [claims, gb, allSlots] = await Promise.all([
    fetchActiveClaims(groupBuyId),
    prisma.groupBuy.findUnique({ where: { id: groupBuyId } }),
    // ALL slots — denominator for percentage column, matching the proxy-buy model
    prisma.groupBuyKit.findMany({
      where: { groupBuyId },
      include: { kit: true },
    }),
  ]);

  if (!gb) return [];

  const conversionRate = rate !== undefined ? rate : gb.inrConversionRate;

  // Denominator = full listing MSRP (all slots), NOT just claimed slots.
  // The organiser buys the whole listing; each slot's share is fixed by its
  // MSRP relative to the total listing price.
  const totalMsrp = allSlots.reduce((sum, s) => sum + s.kit.jpy_price, 0);

  // Status sort order — least advanced statuses bubble to top so organisers
  // see who still needs attention without scrolling
  const STATUS_ORDER: Record<string, number> = {
    CONFIRMED: 0,
    KIT_PAID: 1,
    DOMESTIC_SHIPPING_PAID: 2,
    SHIPPING_PAID: 3,
    CUSTOMS_PAID: 4,
    PAID_IN_FULL: 5,
    PENDING: 6, // Pending is last — shouldn't appear in a finalised summary
  };

  return claims
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      if (a.userId < b.userId) return -1;
      if (a.userId > b.userId) return 1;
      return a.groupBuyKit.slotNumber - b.groupBuyKit.slotNumber;
    })
    .map((c) => {
      const kitCost = c.calculatedKitCost ?? 0;
      const whCost = c.calculatedDomesticShippingCost ?? 0;
      const shCost = c.calculatedShippingCost ?? 0;
      const cuCost = c.calculatedCustomsCost ?? 0;
      const totalJpy = kitCost + whCost + shCost + cuCost;

      const msrpFraction = totalMsrp > 0
        ? c.groupBuyKit.kit.jpy_price / totalMsrp
        : null;

      const totalInr = totalJpy > 0 && conversionRate
        ? Math.round(totalJpy * conversionRate)
        : null;

      return {
        claimId: c.id,
        userId: c.userId,
        kitName: c.groupBuyKit.kit.product_name,
        itemCode: c.groupBuyKit.kit.item_code,
        slotNumber: c.groupBuyKit.slotNumber,
        status: c.status as ClaimStatus,
        msrpJpy: c.groupBuyKit.kit.jpy_price,
        msrpFraction,
        calculatedKitCost: c.calculatedKitCost,
        calculatedDomesticShippingCost: c.calculatedDomesticShippingCost,
        calculatedShippingCost: c.calculatedShippingCost,
        calculatedCustomsCost: c.calculatedCustomsCost,
        totalJpy,
        totalInr,
        paymentEvents: c.paymentEvents,
      };
    });
}

/**
 * Returns all active claims for a specific user within a group buy.
 * Used by `/gb claims view` (member view) and the API's user-claims endpoint.
 */
export async function getUserClaimsInGroupBuy(
  groupBuyId: string,
  userId: string,
): Promise<
  (GroupBuyClaim & {
    groupBuyKit: GroupBuyKit & { kit: Kit };
    paymentEvents: ClaimPaymentEvent[];
  })[]
> {
  return prisma.groupBuyClaim.findMany({
    where: { groupBuyId, userId, status: { not: "CANCELLED" } },
    include: {
      groupBuyKit: { include: { kit: true } },
      paymentEvents: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  }) as any;
}

/**
 * Returns all slots in a group buy with their claim counts.
 * Used by `/gb claims manage` to identify contested / uncontested / unclaimed slots.
 */
export async function getSlotsWithClaimCounts(groupBuyId: string) {
  return prisma.groupBuyKit.findMany({
    where: { groupBuyId },
    include: {
      kit: true,
      claims: {
        where: { status: { not: "CANCELLED" } },
        include: { paymentEvents: true },
      },
    },
    orderBy: [{ kitId: "asc" }, { slotNumber: "asc" }],
  });
}

/**
 * Returns autocomplete options for kits claimable by a user.
 * Excludes kits the user has already claimed.
 * Includes pending claim count vs total slots for UX context.
 */
export async function getClaimableKitsForUser(
  threadId: string,
  userId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const alreadyClaimed = await prisma.groupBuyClaim.findMany({
    where: {
      groupBuy: { threadId },
      userId,
      status: { not: "CANCELLED" },
    },
    include: { groupBuyKit: { select: { kitId: true } } },
  });
  const excludedKitIds = alreadyClaimed.map((c) => c.groupBuyKit.kitId);

  const slots = await prisma.groupBuyKit.findMany({
    where: {
      groupBuy: { threadId },
      ...(query ? { kit: kitNameFilter(query) } : {}),
      kitId: { notIn: excludedKitIds },
    },
    include: {
      kit: true,
      claims: { where: { status: { not: "CANCELLED" } } },
    },
  });

  const byKit = new Map<
    string,
    { name: string; total: number; claimed: number }
  >();
  for (const slot of slots) {
    const entry = byKit.get(slot.kitId) ?? {
      name: slot.kit.product_name,
      total: 0,
      claimed: 0,
    };
    entry.total++;
    entry.claimed += slot.claims.length;
    byKit.set(slot.kitId, entry);
  }

  return [...byKit.entries()]
    .slice(0, 5)
    .map(([kitId, { name, total, claimed }]) => ({
      name: `${name} (${claimed} claimed / ${total} slot${
        total !== 1 ? "s" : ""
      })`,
      value: kitId,
    }));
}

/**
 * Returns autocomplete options for a user's active claims.
 * Used by `/gb claims unclaim` and `/gb claims pay`.
 */
export async function getUserClaimOptions(
  threadId: string,
  userId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const results = await prisma.groupBuyClaim.findMany({
    where: {
      groupBuy: { threadId },
      userId,
      status: { not: "CANCELLED" },
      ...(query ? { groupBuyKit: { kit: kitNameFilter(query) } } : {}),
    },
    include: { groupBuyKit: { include: { kit: true } } },
    take: 5,
  });

  return results.map((c) => ({
    name: `${c.groupBuyKit.kit.product_name} — ${
      CLAIM_STATUS_LABEL[c.status] ?? c.status
    }`,
    value: c.id,
  }));
}

/**
 * Returns autocomplete options for ALL active claims in a group buy.
 * Used by `/gb claims transfer` and `/gb claims confirm` (organiser picks any claim).
 * Value is claim.id.
 */
export async function getAllClaimOptions(
  threadId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const results = await prisma.groupBuyClaim.findMany({
    where: {
      groupBuy: { threadId },
      status: { not: "CANCELLED" },
      ...(query ? { groupBuyKit: { kit: kitNameFilter(query) } } : {}),
    },
    include: { groupBuyKit: { include: { kit: true } } },
    take: 5,
  });

  return results.map((c) => ({
    name: `${c.groupBuyKit.kit.product_name} — <@${c.userId}> [${
      CLAIM_STATUS_LABEL[c.status] ?? c.status
    }]`,
    value: c.id,
  }));
}
