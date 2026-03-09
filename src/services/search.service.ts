/**
 * @module search.service
 *
 * Discovery and search queries for group buys and kits.
 *
 * Two primary search modes:
 *
 * 1. **User-centric** (`searchGroupBuysByUser`):
 *    Every GB a user is involved in — as organiser, buyer, receiver, or
 *    claimant — with optional status and role filtering.
 *
 * 2. **Kit-centric** (`searchGroupBuysByKit`):
 *    GBs that contain a specific kit (partial name or item code match),
 *    with optional status filtering.
 *
 * Both return `GroupBuySearchResult`, a lightweight projection suited for
 * list views and autocomplete. Full detail views should use
 * `getGroupBuyByThread` / `getGroupBuyById` from groupbuy.service.
 */

import type { GroupBuyStatus } from "../../generated/enums.ts";
import type {
  EnumClaimStatusFilter,
  SortOrder,
} from "../../generated/internal/prismaNamespace.ts";
import { prisma } from "../lib/prisma.ts";
import { kitNameFilter } from "../lib/util.ts";

export interface GroupBuyKitSummary {
  kitId: string;
  kitName: string;
  itemCode: string;
  /** Total number of slots added for this kit in this GB. */
  totalSlots: number;
  /** MSRP in JPY — used for percentage display only. */
  msrpJpy: number;
  /**
   * This kit's share of the total MSRP across all active claims, as a
   * fraction 0–1. Null until costPrice is set (no active claims yet).
   *
   * Matches the "Percentage" column in the spreadsheet.
   */
  msrpFraction: number | null;
  /**
   * Proportioned deal price for this kit (costPrice × msrpFraction).
   * Null until costPrice is set on the GB.
   *
   * Matches the "Deal Price YEN" column in the spreadsheet.
   */
  dealPriceJpy: number | null;
}

/** Lightweight summary of one of the current user's claims within a result. */
export interface UserClaimSummary {
  claimId: string;
  kitName: string;
  slotNumber: number;
  status: string;
  /**
   * This claim's proportioned deal price total in JPY (kit + domestic shipping +
   * shipping + customs). Null if costPrice not yet set.
   */
  totalJpy: number | null;
  /** INR equivalent at the GB's conversion rate. Null if rate not set. */
  totalInr: number | null;
}

/** Roles a user can hold in a group buy. */
export type GbRole = "organiser" | "buyer" | "receiver" | "claimant";

/** A group buy result from either search mode. */
export interface GroupBuySearchResult {
  id: string;
  threadId: string;
  guildId: string;
  ownerId: string;
  buyerId: string | null;
  receiverId: string | null;
  status: GroupBuyStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Financial summary fields (may be null if not yet set). */
  costPrice: number | null;
  domesticShippingCost: number | null;
  shippingCost: number | null;
  customsCost: number | null;
  inrConversionRate: number | null;
  totalWeight: number | null;
  shippingTrackingNumber: string | null;
  shippingTrackingUrl: string | null;
  customsTrackingUrl: string | null;
  /** Deduplicated kit summaries with percentage + deal price. */
  kits: GroupBuyKitSummary[];
  /** Total active (non-cancelled) claim count across all slots. */
  activeClaims: number;
  /** The requesting user's claims in this GB (empty if userId not passed). */
  userClaims: UserClaimSummary[];
  /** Roles the requesting user holds in this GB (empty if userId not passed). */
  userRoles: GbRole[];
}

export interface SearchGroupBuysByUserOptions {
  userId: string;
  guildId?: string;
  /** Filter to specific statuses. Omit for all. */
  statuses?: GroupBuyStatus[];
  /** Restrict to specific roles. Omit for all. */
  roles?: GbRole[];
  /** Defaults to 20. */
  limit?: number;
  /** Defaults to 0. */
  offset?: number;
}

export interface SearchGroupBuysByKitOptions {
  /**
   * Partial kit name or item code. Whitespace-separated words are ANDed.
   * E.g. "HG unicorn" matches "1/144 HG Unicorn Gundam".
   */
  query: string;
  guildId?: string;
  /** Filter to specific statuses. Omit for all. */
  statuses?: GroupBuyStatus[];
  /**
   * If provided, the result's `userClaims` and `userRoles` fields are
   * populated for this user.
   */
  userId?: string;
  /** Defaults to 20. */
  limit?: number;
  /** Defaults to 0. */
  offset?: number;
}

/**
 * Given a raw GroupBuy row plus its included kits + claims, compute the
 * full `GroupBuySearchResult` including percentage and deal price columns.
 *
 * The percentage split uses ALL slots as the denominator (proxy-buy model):
 * each slot's share = slot.kit.jpy_price / sum(ALL slots' kit.jpy_price).
 * This matches recalculateAllClaims — the organiser buys the full listing
 * regardless of how many slots are claimed.
 */
function toSearchResult(gb: any, userId?: string): GroupBuySearchResult {
  const activeClaims: any[] = (gb.claims ?? []).filter(
    (c: any) => c.status !== "CANCELLED",
  );

  // Denominator = ALL slots in the listing (not just claimed ones)
  const allSlots: any[] = gb.kits ?? [];
  const totalMsrp = allSlots.reduce(
    (sum: number, s: any) => sum + (s.kit?.jpy_price ?? 0),
    0,
  );

  const kitMap = new Map<string, GroupBuyKitSummary>();
  for (const gbk of allSlots) {
    if (kitMap.has(gbk.kitId)) {
      // biome-ignore lint/style/noNonNullAssertion: false positive
      const obj = kitMap.get(gbk.kitId)!;
      obj.totalSlots++;
      continue;
    }

    // Each slot's fraction of the total listing price
    const fraction = totalMsrp > 0 && gbk.kit.jpy_price > 0
      ? gbk.kit.jpy_price / totalMsrp
      : null;

    const dealPriceJpy = fraction !== null && gb.costPrice != null
      ? Math.round(fraction * gb.costPrice)
      : null;

    kitMap.set(gbk.kitId, {
      kitId: gbk.kitId,
      kitName: gbk.kit.product_name,
      itemCode: gbk.kit.item_code,
      totalSlots: 1,
      msrpJpy: gbk.kit.jpy_price,
      msrpFraction: fraction,
      dealPriceJpy,
    });
  }

  // User-specific claims
  const userClaims: UserClaimSummary[] = [];
  const userRoles: GbRole[] = [];

  if (userId) {
    if (gb.ownerId === userId) userRoles.push("organiser");
    if (gb.buyerId === userId) userRoles.push("buyer");
    if (gb.receiverId === userId) userRoles.push("receiver");

    for (const c of activeClaims) {
      if (c.userId !== userId) continue;

      userRoles.includes("claimant") || userRoles.push("claimant");

      const kit = c.calculatedKitCost ?? 0;
      const wh = c.calculatedDomesticShippingCost ?? 0;
      const sh = c.calculatedShippingCost ?? 0;
      const cu = c.calculatedCustomsCost ?? 0;
      const hasAny = kit > 0 || wh > 0 || sh > 0 || cu > 0;

      const totalJpy = hasAny ? kit + wh + sh + cu : null;
      const totalInr = totalJpy !== null && gb.inrConversionRate
        ? Math.round(totalJpy * gb.inrConversionRate)
        : null;

      userClaims.push({
        claimId: c.id,
        kitName: c.groupBuyKit?.kit?.product_name ?? "Unknown",
        slotNumber: c.groupBuyKit?.slotNumber ?? 0,
        status: c.status,
        totalJpy,
        totalInr,
      });
    }
  }

  return {
    id: gb.id,
    threadId: gb.threadId,
    guildId: gb.guildId,
    ownerId: gb.ownerId,
    buyerId: gb.buyerId,
    receiverId: gb.receiverId,
    status: gb.status,
    createdAt: gb.createdAt,
    updatedAt: gb.updatedAt,
    costPrice: gb.costPrice,
    domesticShippingCost: gb.domesticShippingCost,
    shippingCost: gb.shippingCost,
    customsCost: gb.customsCost,
    inrConversionRate: gb.inrConversionRate,
    totalWeight: gb.totalWeight,
    shippingTrackingNumber: gb.shippingTrackingNumber,
    shippingTrackingUrl: gb.shippingTrackingUrl,
    customsTrackingUrl: gb.customsTrackingUrl,
    kits: [...kitMap.values()],
    activeClaims: activeClaims.length,
    userClaims,
    userRoles,
  };
}

/**
 * The expensive include block used by both search functions.
 * Fetches everything needed to compute summaries in one query.
 */
const GB_SEARCH_INCLUDE = {
  kits: {
    include: { kit: true },
    orderBy: [
      { kitId: "asc" as SortOrder },
      { slotNumber: "asc" as SortOrder },
    ],
  },
  claims: {
    where: { status: { not: "CANCELLED" as EnumClaimStatusFilter } },
    include: {
      groupBuyKit: { include: { kit: true } },
    },
  },
};

/**
 * Returns all group buys a user is involved in, across any role.
 *
 * Roles checked:
 * - `organiser` — user is `GroupBuy.ownerId`
 * - `buyer`     — user is `GroupBuy.buyerId`
 * - `receiver`  — user is `GroupBuy.receiverId`
 * - `claimant`  — user has at least one active `GroupBuyClaim`
 *
 * Results are ordered by most recently updated first.
 *
 * @example
 * // All GBs the user is part of, in any open/in-progress state
 * searchGroupBuysByUser({
 *   userId: "123456789",
 *   statuses: ["OPEN", "CLAIMED", "PURCHASED", "AT_WAREHOUSE", "SHIPPED", "AT_CUSTOMS", "CLEARED_CUSTOMS", "AT_RECEIVER"],
 * });
 */
export async function searchGroupBuysByUser(
  opts: SearchGroupBuysByUserOptions,
): Promise<GroupBuySearchResult[]> {
  const { userId, guildId, statuses, roles, limit = 20, offset = 0 } = opts;

  const activeRoles: GbRole[] = roles ?? [
    "organiser",
    "buyer",
    "receiver",
    "claimant",
  ];

  const roleConditions: any[] = [];

  if (activeRoles.includes("organiser")) {
    roleConditions.push({ ownerId: userId });
  }
  if (activeRoles.includes("buyer")) {
    roleConditions.push({ buyerId: userId });
  }
  if (activeRoles.includes("receiver")) {
    roleConditions.push({ receiverId: userId });
  }
  if (activeRoles.includes("claimant")) {
    roleConditions.push({
      claims: {
        some: { userId, status: { not: "CANCELLED" } },
      },
    });
  }

  if (roleConditions.length === 0) return [];

  const rows = await prisma.groupBuy.findMany({
    where: {
      ...(guildId ? { guildId } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      OR: roleConditions,
    },
    include: GB_SEARCH_INCLUDE,
    orderBy: { updatedAt: "desc" },
    take: limit,
    skip: offset,
  });

  return rows.map((gb) => toSearchResult(gb, userId));
}

/**
 * Returns group buys containing a kit whose name or item code matches `query`.
 *
 * All whitespace-separated words in `query` must appear in the kit name
 * (case-insensitive on PostgreSQL, case-sensitive on SQLite).
 * An item code exact-match is also checked as a fallback.
 *
 * Results are ordered by most recently updated first.
 *
 * @example
 * // Find in-progress GBs containing an HG Unicorn kit
 * searchGroupBuysByKit({
 *   query: "HG unicorn",
 *   statuses: ["OPEN", "CLAIMED", "PURCHASED"],
 *   userId: "123456789",
 * });
 */
export async function searchGroupBuysByKit(
  opts: SearchGroupBuysByKitOptions,
): Promise<GroupBuySearchResult[]> {
  const { query, guildId, statuses, userId, limit = 20, offset = 0 } = opts;

  if (!query.trim()) return [];

  const kitWhere = {
    OR: [
      kitNameFilter(query),
      { item_code: { equals: query.trim().toUpperCase() } },
    ],
  };

  const rows = await prisma.groupBuy.findMany({
    where: {
      ...(guildId ? { guildId } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      kits: { some: { kit: kitWhere } },
    },
    include: GB_SEARCH_INCLUDE,
    orderBy: { updatedAt: "desc" },
    take: limit,
    skip: offset,
  });

  return rows.map((gb) => toSearchResult(gb, userId));
}

/**
 * Returns autocomplete-friendly options for Discord slash commands.
 * Searches group buys by kit name within a specific guild, returning
 * options formatted as `{ name, value }` pairs where `value` is the threadId.
 *
 * Suitable for commands that need to reference a GB by thread.
 */
export async function autocompleteGroupBuys(
  query: string,
  guildId: string,
  userId?: string,
  statuses?: GroupBuyStatus[],
): Promise<{ name: string; value: string }[]> {
  if (!query.trim()) {
    // No query: return the user's own GBs or recent GBs
    const recent = await prisma.groupBuy.findMany({
      where: {
        guildId,
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        ...(userId
          ? {
            OR: [
              { ownerId: userId },
              { buyerId: userId },
              { receiverId: userId },
              { claims: { some: { userId, status: { not: "CANCELLED" } } } },
            ],
          }
          : {}),
      },
      include: { kits: { include: { kit: true }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });

    return recent.map((gb) => ({
      name: `[${gb.status}] ${gb.kits[0]?.kit.product_name ?? "Empty GB"} (+${
        gb.kits.length - 1
      } more)`,
      value: gb.threadId,
    }));
  }

  // Query: search by kit name
  const results = await searchGroupBuysByKit({
    query,
    guildId,
    statuses,
    userId,
    limit: 5,
  });

  return results.map((gb) => {
    const firstKit = gb.kits[0];
    const label = gb.kits.length === 1
      ? (firstKit?.kitName ?? "Unknown kit")
      : `${firstKit?.kitName ?? "Unknown"} (+${gb.kits.length - 1} more)`;
    return {
      name: `[${gb.status}] ${label}`,
      value: gb.threadId,
    };
  });
}

/**
 * Returns a paginated count alongside results for API list endpoints.
 */
export async function searchGroupBuysByUserWithCount(
  opts: SearchGroupBuysByUserOptions,
): Promise<{ results: GroupBuySearchResult[]; total: number }> {
  const { userId, guildId, statuses, roles } = opts;

  const activeRoles: GbRole[] = roles ?? [
    "organiser",
    "buyer",
    "receiver",
    "claimant",
  ];

  const roleConditions: any[] = [];
  if (activeRoles.includes("organiser")) {
    roleConditions.push({ ownerId: userId });
  }
  if (activeRoles.includes("buyer")) roleConditions.push({ buyerId: userId });
  if (activeRoles.includes("receiver")) {
    roleConditions.push({ receiverId: userId });
  }
  if (activeRoles.includes("claimant")) {
    roleConditions.push({
      claims: { some: { userId, status: { not: "CANCELLED" } } },
    });
  }

  if (roleConditions.length === 0) return { results: [], total: 0 };

  const where = {
    ...(guildId ? { guildId } : {}),
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    OR: roleConditions,
  };

  const [results, total] = await Promise.all([
    searchGroupBuysByUser(opts),
    prisma.groupBuy.count({ where }),
  ]);

  return { results, total };
}

/**
 * Returns a paginated count alongside results for API list endpoints.
 */
export async function searchGroupBuysByKitWithCount(
  opts: SearchGroupBuysByKitOptions,
): Promise<{ results: GroupBuySearchResult[]; total: number }> {
  const { query, guildId, statuses } = opts;
  if (!query.trim()) return { results: [], total: 0 };

  const kitWhere = {
    OR: [
      kitNameFilter(query),
      { item_code: { equals: query.trim().toUpperCase() } },
    ],
  };

  const where = {
    ...(guildId ? { guildId } : {}),
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    kits: { some: { kit: kitWhere } },
  };

  const [results, total] = await Promise.all([
    searchGroupBuysByKit(opts),
    prisma.groupBuy.count({ where }),
  ]);

  return { results, total };
}
