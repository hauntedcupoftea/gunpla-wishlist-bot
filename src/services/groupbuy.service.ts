/**
 * @module groupbuy.service
 *
 * All database operations for GroupBuys, GroupBuyKits, GroupBuyClaims,
 * and ClaimPaymentEvents.
 *
 * ## Design principles
 *
 * - **All financial recalculation is global.** Whenever any financial field
 *   (costPrice, warehouseCost, shippingCost, customsCost) changes, ALL active
 *   claims are recalculated in a single transaction. This eliminates the
 *   "stale snapshot" bug where adding a new claim would make existing claims'
 *   proportions wrong.
 *
 * - **Shipping split uses claim weights, not shippingWeight.** GroupBuy
 *   .shippingWeight is the courier-weighed parcel weight (used for display /
 *   cost entry). The actual split denominator is the sum of each active
 *   claim's kit weight, so proportions always sum to 100%.
 *
 * - **MSRP-proportion splits** (kit cost, warehouse, customs) use the sum of
 *   jpy_price across all active confirmed+ claims — not all slots — so
 *   cancelled claims don't dilute the pool.
 */

import type {
  ClaimPaymentEvent,
  GroupBuy,
  GroupBuyKit,
  GroupBuyClaim,
  Kit,
} from "../../generated/models.ts";
import type {
  GroupBuyStatus,
  ClaimStatus,
  PaymentStage,
} from "../../generated/enums.ts";
import { prisma } from "../lib/prisma.ts";
import { kitNameFilter, CLAIM_STATUS_LABEL } from "../lib/util.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A GroupBuy with its full kit + claim tree attached. */
export type GroupBuyFull = GroupBuy & {
  kits: (GroupBuyKit & { kit: Kit; claims: GroupBuyClaim[] })[];
  claims: (GroupBuyClaim & {
    groupBuyKit: GroupBuyKit & { kit: Kit };
    paymentEvents: ClaimPaymentEvent[];
  })[];
};

/**
 * Per-claim cost breakdown shown to members and organisers.
 * All values are in JPY; INR equivalents are derived at the display layer
 * using GroupBuy.inrConversionRate.
 */
export interface ClaimCostBreakdown {
  claimId:                string;
  userId:                 string;
  kitName:                string;
  slotNumber:             number;
  status:                 string;
  calculatedKitCost:      number | null;
  calculatedWarehouseCost:number | null;
  calculatedShippingCost: number | null;
  calculatedCustomsCost:  number | null;
  /** Sum of all non-null calculated costs. */
  totalJpy:               number;
  /** Latest payment event for each stage, for status display. */
  paymentEvents:          ClaimPaymentEvent[];
}

export interface CreateGroupBuyInput {
  threadId: string;
  guildId:  string;
  ownerId:  string;
}

export interface AddKitInput {
  groupBuyId:  string;
  kitId:       string;
  weightGrams: number;
  quantity:    number;
}

export interface SetFinancialsInput {
  costPrice?:        number | null;
  warehouseCost?:    number | null;
  shippingCost?:     number | null;
  shippingWeight?:   number | null;
  customsCost?:      number | null;
  inrConversionRate?:number | null;
}

export interface SetTrackingInput {
  shippingTrackingNumber?: string | null;
  shippingTrackingUrl?:    string | null;
  customsTrackingUrl?:     string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetches all non-cancelled claims for a group buy, with their kit data.
 * This is the canonical "active claims" query used throughout the service.
 */
async function fetchActiveClaims(groupBuyId: string) {
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
 * Called after any financial field changes on the GroupBuy.
 * Uses the current DB state of the GroupBuy — callers should pass the
 * freshly-updated `gb` object.
 *
 * ### Split formulas
 * - Kit cost & customs & warehouse: proportional to kit MSRP (jpy_price)
 * - Shipping: proportional to kit weight (weight_grams on GroupBuyKit)
 *   — denominator is sum of active claim weights, NOT GroupBuy.shippingWeight
 */
async function recalculateAllClaims(gb: GroupBuy): Promise<void> {
  const claims = await fetchActiveClaims(gb.id);
  if (claims.length === 0) return;

  // MSRP-based denominator (kit cost, warehouse, customs)
  const totalMsrp = claims.reduce(
    (sum, c) => sum + c.groupBuyKit.kit.jpy_price,
    0,
  );

  // Weight-based denominator (shipping) — uses claim weights, not shippingWeight
  const totalClaimWeight = claims.reduce(
    (sum, c) => sum + c.groupBuyKit.weight_grams,
    0,
  );

  await prisma.$transaction(
    claims.map((claim) => {
      const msrpProportion =
        totalMsrp > 0 ? claim.groupBuyKit.kit.jpy_price / totalMsrp : 0;

      const weightProportion =
        totalClaimWeight > 0
          ? claim.groupBuyKit.weight_grams / totalClaimWeight
          : 0;

      return prisma.groupBuyClaim.update({
        where: { id: claim.id },
        data: {
          calculatedKitCost: gb.costPrice !== null
            ? Math.round(msrpProportion * gb.costPrice!)
            : null,
          calculatedWarehouseCost: gb.warehouseCost !== null
            ? Math.round(msrpProportion * gb.warehouseCost!)
            : null,
          calculatedShippingCost: gb.shippingCost !== null
            ? Math.round(weightProportion * gb.shippingCost!)
            : null,
          calculatedCustomsCost: gb.customsCost !== null
            ? Math.round(msrpProportion * gb.customsCost!)
            : null,
        },
      });
    }),
  );
}

// ─── Group Buy CRUD ───────────────────────────────────────────────────────────

/**
 * Creates a new group buy anchored to a Discord forum thread.
 *
 * @throws If a group buy already exists for this threadId.
 */
export async function createGroupBuy(
  input: CreateGroupBuyInput,
): Promise<GroupBuy> {
  return prisma.groupBuy.create({
    data: {
      threadId: input.threadId,
      guildId:  input.guildId,
      ownerId:  input.ownerId,
    },
  });
}

/**
 * Retrieves a group buy by its Discord thread ID, fully populated with
 * kits (and their claims) and top-level claims.
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
          claims: {
            where: { status: { not: "CANCELLED" } },
          },
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
  }) as GroupBuyFull | null;
}

/**
 * Retrieves a group buy by its internal UUID.
 */
export async function getGroupBuyById(
  id: string,
): Promise<GroupBuyFull | null> {
  return prisma.groupBuy.findUnique({
    where: { id },
    include: {
      kits: {
        include: { kit: true, claims: true },
        orderBy: [{ kitId: "asc" }, { slotNumber: "asc" }],
      },
      claims: {
        include: {
          groupBuyKit: { include: { kit: true } },
          paymentEvents: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  }) as GroupBuyFull | null;
}

/**
 * Returns all group buys in a guild, ordered newest-first.
 */
export async function listGroupBuysByGuild(guildId: string): Promise<GroupBuy[]> {
  return prisma.groupBuy.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Updates the group buy status.
 *
 * @returns The updated GroupBuy.
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
  return prisma.groupBuy.update({ where: { id }, data: { ownerId: newOwnerId } });
}

// ─── Financials ───────────────────────────────────────────────────────────────

/**
 * Updates one or more financial fields on a group buy and immediately
 * recalculates cost splits across ALL active claims.
 *
 * This is the single entry point for all financial mutations. By funnelling
 * every change through here, we guarantee claim snapshots are always
 * consistent.
 *
 * @param id     - GroupBuy UUID.
 * @param fields - Partial financial update (only provided fields are changed).
 */
export async function updateFinancials(
  id: string,
  fields: SetFinancialsInput,
): Promise<GroupBuy> {
  // Strip undefined keys so Prisma doesn't null them out unintentionally
  const data = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );

  const gb = await prisma.groupBuy.update({ where: { id }, data });
  await recalculateAllClaims(gb);
  return gb;
}

/**
 * Sets tracking details (shipping + customs) on a group buy.
 * Does not trigger claim recalculation (tracking is display-only).
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
 * Slot numbers are assigned sequentially starting after the highest existing
 * slot for this (groupBuyId, kitId) pair.
 *
 * After adding slots, `totalWeight` on the GroupBuy is updated.
 * If financials are already set, all claim costs are recalculated.
 *
 * @returns The newly created GroupBuyKit rows.
 */
export async function addKitToGroupBuy(
  input: AddKitInput,
): Promise<GroupBuyKit[]> {
  const { groupBuyId, kitId, weightGrams, quantity } = input;

  // Find next slot number for this kit in this GB
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

  // Recompute total weight
  const allSlots = await prisma.groupBuyKit.findMany({ where: { groupBuyId } });
  const totalWeight = allSlots.reduce((sum, s) => sum + s.weight_grams, 0);
  const gb = await prisma.groupBuy.update({
    where: { id: groupBuyId },
    data: { totalWeight },
  });

  // Recalculate if financials exist
  if (gb.costPrice || gb.shippingCost || gb.customsCost || gb.warehouseCost) {
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
 * @param groupBuyId - GroupBuy UUID.
 * @param kitId      - Kit UUID (the Kit model's id, NOT GroupBuyKit.id).
 * @param quantity   - Number of slots to remove (default: 1).
 * @returns Object with removed count and updated total weight.
 * @throws  If fewer unclaimed slots exist than requested.
 */
export async function removeKitFromGroupBuy(
  groupBuyId: string,
  kitId: string,
  quantity = 1,
): Promise<{ removed: number; totalWeight: number; kitName: string }> {
  // Find unclaimed slots — slots where no non-cancelled claim exists
  const unclaimed = await prisma.groupBuyKit.findMany({
    where: {
      groupBuyId,
      kitId, // ← This is Kit.id (UUID), NOT GroupBuyKit.id
      claims: { none: { status: { not: "CANCELLED" } } },
    },
    include: { kit: true },
    take: quantity,
  });

  if (unclaimed.length < quantity) {
    const total = await prisma.groupBuyKit.count({ where: { groupBuyId, kitId } });
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

  if (gb.costPrice || gb.shippingCost || gb.customsCost || gb.warehouseCost) {
    await recalculateAllClaims(gb);
  }

  return { removed: unclaimed.length, totalWeight, kitName };
}

/**
 * Returns autocomplete-friendly kit options for /gb removekit.
 * Only returns kits that actually have slots in this group buy.
 * Value is Kit.id (NOT GroupBuyKit.id) — this is what removeKitFromGroupBuy expects.
 */
export async function getRemovableKitsForGroupBuy(
  threadId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const slots = await prisma.groupBuyKit.findMany({
    where: {
      groupBuy: { threadId },
      kit: kitNameFilter(query),
    },
    include: { kit: true },
    take: 5,
  });

  // Deduplicate by Kit.id — return the Kit.id as the value
  const seen = new Set<string>();
  return slots
    .filter((s) => !seen.has(s.kitId) && seen.add(s.kitId))
    .map((s) => ({ name: s.kit.product_name, value: s.kitId }));
}

// ─── Claims ───────────────────────────────────────────────────────────────────

/**
 * Creates a claim for a user on the best available slot of a kit.
 *
 * "Best" is defined as the slot with the fewest active (non-cancelled) claims,
 * to distribute contention evenly. Ties are broken by slotNumber ascending.
 *
 * Immediately triggers a full recalculation of all claims for the group buy,
 * so the new claim and all existing claims have consistent cost splits.
 *
 * @returns The created claim.
 * @throws  If the kit is not in this group buy, or the user already has an
 *          active claim for any slot of this kit.
 */
export async function claimKit(
  groupBuyId: string,
  kitId: string,
  userId: string,
): Promise<GroupBuyClaim> {
  // Duplicate protection: one claim per user per kit (across all slots)
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

  // Load all slots for this kit with their active claim counts
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

  // Assign to slot with fewest pending claims; slotNumber tie-breaks
  const bestSlot = slots.reduce((best, slot) =>
    slot.claims.length < best.claims.length ? slot : best,
  );

  const claim = await prisma.groupBuyClaim.create({
    data: { groupBuyId, groupBuyKitId: bestSlot.id, userId },
  });

  // Recalculate ALL claims (including this new one) so proportions are consistent
  const gb = await prisma.groupBuy.findUnique({ where: { id: groupBuyId } });
  if (gb && (gb.costPrice || gb.shippingCost || gb.customsCost || gb.warehouseCost)) {
    await recalculateAllClaims(gb);
  }

  return claim;
}

/**
 * Cancels a claim (sets status to CANCELLED).
 * Triggers recalculation for remaining claims.
 *
 * @param claimId   - The claim UUID to cancel.
 * @param actorId   - Discord user ID performing the cancellation (for auth checks in caller).
 */
export async function cancelClaim(claimId: string): Promise<GroupBuyClaim> {
  const claim = await prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "CANCELLED" },
  });

  const gb = await prisma.groupBuy.findUnique({ where: { id: claim.groupBuyId } });
  if (gb && (gb.costPrice || gb.shippingCost || gb.customsCost || gb.warehouseCost)) {
    await recalculateAllClaims(gb);
  }

  return claim;
}

/**
 * Confirms a pending claim (organiser action).
 */
export async function confirmClaim(claimId: string): Promise<GroupBuyClaim> {
  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "CONFIRMED" },
  });
}

/**
 * Confirms all PENDING, uncontested claims in a group buy in a single
 * transaction. "Uncontested" means the slot has exactly one active claim.
 *
 * @returns Number of claims confirmed.
 */
export async function confirmUncontestedClaims(groupBuyId: string): Promise<number> {
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
 * that GroupBuyKit slot.
 *
 * @param groupBuyKitId    - The GroupBuyKit slot UUID (NOT Kit.id).
 * @param winnerClaimId    - The claim UUID to confirm.
 */
export async function resolveContestedSlot(
  groupBuyKitId: string,
  winnerClaimId: string,
): Promise<void> {
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
}

/**
 * Transfers an existing claim to a different user.
 * Performs a duplicate-protection check: the target user must not already
 * have an active claim for the same GroupBuyKit slot.
 *
 * @param claimId   - The claim UUID to transfer.
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

  // Duplicate protection on the transfer target
  const conflict = await prisma.groupBuyClaim.findFirst({
    where: {
      groupBuyKitId: claim.groupBuyKitId,
      userId: newUserId,
      status: { not: "CANCELLED" },
      id: { not: claimId },
    },
  });
  if (conflict) {
    throw new Error(
      `User already has an active claim for ${claim.groupBuyKit.kit.product_name}.`,
    );
  }

  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { userId: newUserId },
  });
}

/**
 * Advances a claim's status to the next payment stage.
 * This is an organiser action confirming a member's self-reported payment.
 *
 * The valid transitions are:
 *   CONFIRMED → KIT_PAID
 *   KIT_PAID → WAREHOUSE_PAID (only if GroupBuy.warehouseCost is set)
 *   KIT_PAID → SHIPPING_PAID (if no warehouse cost)
 *   WAREHOUSE_PAID → SHIPPING_PAID
 *   SHIPPING_PAID → CUSTOMS_PAID
 *   CUSTOMS_PAID → PAID_IN_FULL
 *
 * @param claimId       - Claim UUID to advance.
 * @param actorId       - Discord user ID of the organiser confirming.
 * @param stage         - Which payment stage is being confirmed.
 * @param note          - Optional note (e.g. UTR reference).
 */
export async function confirmPaymentStage(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<{ claim: GroupBuyClaim; event: ClaimPaymentEvent }> {
  const stageToStatus: Record<string, ClaimStatus> = {
    KIT:      "KIT_PAID",
    WAREHOUSE:"WAREHOUSE_PAID",
    SHIPPING: "SHIPPING_PAID",
    CUSTOMS:  "CUSTOMS_PAID",
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
 * Records a member's self-reported payment for a stage (does NOT advance status).
 * The organiser must subsequently call confirmPaymentStage to actually move
 * the claim forward.
 *
 * @param claimId - Claim UUID.
 * @param actorId - Discord user ID of the member reporting payment.
 * @param stage   - Which payment stage they're reporting.
 * @param note    - Optional note (e.g. UTR number, screenshot reference).
 */
export async function reportPayment(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<ClaimPaymentEvent> {
  return prisma.claimPaymentEvent.create({
    data: {
      claimId,
      stage,
      action: "REPORTED",
      actorId,
      note: note ?? null,
    },
  });
}

/**
 * Rejects a member's payment report (organiser action).
 * Records a REJECTED event — the claim status is unchanged, so the member
 * must re-report.
 */
export async function rejectPaymentReport(
  claimId: string,
  actorId: string,
  stage: PaymentStage,
  note?: string,
): Promise<ClaimPaymentEvent> {
  return prisma.claimPaymentEvent.create({
    data: {
      claimId,
      stage,
      action: "REJECTED",
      actorId,
      note: note ?? null,
    },
  });
}

/**
 * Advances a fully-paid claim to PAID_IN_FULL.
 * Should be called after CUSTOMS_PAID is confirmed (or SHIPPING_PAID if no
 * customs cost is set on the group buy).
 */
export async function markPaidInFull(claimId: string): Promise<GroupBuyClaim> {
  return prisma.groupBuyClaim.update({
    where: { id: claimId },
    data: { status: "PAID_IN_FULL" },
  });
}

// ─── Read / reporting ─────────────────────────────────────────────────────────

/**
 * Returns a full cost breakdown for every active claim in a group buy,
 * grouped and sorted by userId then slotNumber.
 *
 * This powers both /gb summary (Discord) and GET /groupbuys/:id/summary (API).
 */
export async function getGroupBuySummary(
  groupBuyId: string,
): Promise<ClaimCostBreakdown[]> {
  const claims = await fetchActiveClaims(groupBuyId);

  return claims
    .sort((a, b) => {
      if (a.userId < b.userId) return -1;
      if (a.userId > b.userId) return 1;
      return a.groupBuyKit.slotNumber - b.groupBuyKit.slotNumber;
    })
    .map((c) => {
      const kit = c.calculatedKitCost ?? 0;
      const wh  = c.calculatedWarehouseCost ?? 0;
      const sh  = c.calculatedShippingCost ?? 0;
      const cu  = c.calculatedCustomsCost ?? 0;

      return {
        claimId:                 c.id,
        userId:                  c.userId,
        kitName:                 c.groupBuyKit.kit.product_name,
        slotNumber:              c.groupBuyKit.slotNumber,
        status:                  c.status,
        calculatedKitCost:       c.calculatedKitCost,
        calculatedWarehouseCost: c.calculatedWarehouseCost,
        calculatedShippingCost:  c.calculatedShippingCost,
        calculatedCustomsCost:   c.calculatedCustomsCost,
        totalJpy:                kit + wh + sh + cu,
        paymentEvents:           c.paymentEvents,
      };
    });
}

/**
 * Returns all active claims for a specific user within a group buy.
 * Used by /gb claims view (member's own view) and GET /groupbuys/:id/claims?userId=.
 */
export async function getUserClaimsInGroupBuy(
  groupBuyId: string,
  userId: string,
): Promise<(GroupBuyClaim & {
  groupBuyKit: GroupBuyKit & { kit: Kit };
  paymentEvents: ClaimPaymentEvent[];
})[]> {
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
 * Used by /gb claims manage to identify contested vs uncontested vs unclaimed slots.
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
 * Returns autocomplete options for kits available to claim in a group buy
 * (excluding kits the user has already claimed).
 *
 * Result includes pending claim count vs total slots per kit for UX display.
 */
export async function getClaimableKitsForUser(
  threadId: string,
  userId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  // Kits the user already has an active claim for (exclude whole kit)
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
      kit: kitNameFilter(query),
      kitId: { notIn: excludedKitIds },
    },
    include: {
      kit: true,
      claims: { where: { status: { not: "CANCELLED" } } },
    },
  });

  // Aggregate by kitId
  const byKit = new Map<string, { name: string; total: number; pending: number }>();
  for (const slot of slots) {
    const entry = byKit.get(slot.kitId) ?? { name: slot.kit.product_name, total: 0, pending: 0 };
    entry.total++;
    entry.pending += slot.claims.length;
    byKit.set(slot.kitId, entry);
  }

  return [...byKit.entries()].slice(0, 5).map(([kitId, { name, total, pending }]) => ({
    name: `${name} (${pending} claimed / ${total} slot${total !== 1 ? "s" : ""})`,
    value: kitId,
  }));
}

/**
 * Returns autocomplete options for a user's active claims (for /gb claims unclaim).
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
      groupBuyKit: { kit: kitNameFilter(query) },
    },
    include: { groupBuyKit: { include: { kit: true } } },
    take: 5,
  });

  return results.map((c) => ({
    name: `${c.groupBuyKit.kit.product_name} — ${CLAIM_STATUS_LABEL[c.status] ?? c.status}`,
    value: c.id,
  }));
}

/**
 * Returns autocomplete options for ALL active claims in a group buy
 * (used by /gb claims transfer where the organiser picks any claim).
 *
 * Value is claim.id (NOT groupBuyKit.id or kit.id).
 */
export async function getAllClaimOptions(
  threadId: string,
  query: string,
): Promise<{ name: string; value: string }[]> {
  const results = await prisma.groupBuyClaim.findMany({
    where: {
      groupBuy: { threadId },
      status: { not: "CANCELLED" },
      groupBuyKit: { kit: kitNameFilter(query) },
    },
    include: { groupBuyKit: { include: { kit: true } } },
    take: 5,
  });

  // BUG FIX: value is claim.id — previously this incorrectly returned
  // groupBuyKit.id which caused transferClaim to look up the wrong record.
  return results.map((c) => ({
    name: `${c.groupBuyKit.kit.product_name} — <@${c.userId}>`,
    value: c.id,
  }));
}


