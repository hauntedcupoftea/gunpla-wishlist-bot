/**
 * @module kit.service
 *
 * All database operations for Kits and Wishlists.
 * Neither the Discord bot nor the API should query Prisma directly for these
 * entities — route all reads and writes through this service.
 */

import type { Kit, Wishlist } from "../../generated/models.ts";
import { prisma } from "../lib/prisma.ts";
import { kitNameFilter } from "../lib/util.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateKitInput {
  product_name: string;
  jpy_price: number;
  weight_grams?: number;
  availability: string;
  item_code?: string;
  release_date?: string | null;
  stock_status?: string | null;
}

/**
 * A Kit enriched with its current wishlist count.
 * Explicitly typed (rather than `extends Kit`) to avoid TS inference issues
 * with Prisma's generated type aliases in some configurations.
 */
export interface KitSearchResult {
  id:           string;
  item_code:    string;
  release_date: string | null;
  jpy_price:    number;
  weight_grams: number | null;
  availability: string;
  stock_status: string | null;
  product_name: string;
  wishlistCount: number;
}

// ─── Kit CRUD ─────────────────────────────────────────────────────────────────

/**
 * Searches kits whose product_name contains ALL words in `query`.
 * Returns up to `limit` results ordered by name.
 *
 * @param query  - Whitespace-separated search terms (AND semantics).
 * @param limit  - Maximum results to return (default: 10).
 */
export async function searchKits(
  query: string,
  limit = 10,
): Promise<Kit[]> {
  return prisma.kit.findMany({
    where: kitNameFilter(query),
    orderBy: { product_name: "asc" },
    take: limit,
  });
}

/**
 * Retrieves a single kit by its internal UUID, including the number of
 * wishlist entries that reference it.
 *
 * @returns The kit with wishlistCount, or null if not found.
 */
export async function getKitById(id: string): Promise<KitSearchResult | null> {
  const kit = await prisma.kit.findUnique({ where: { id } });
  if (!kit) return null;

  const wishlistCount = await prisma.wishlist.count({ where: { kitId: id } });
  return { ...kit, wishlistCount };
}

/**
 * Retrieves a single kit by its supplier item code (e.g. "BAN123456").
 */
export async function getKitByItemCode(itemCode: string): Promise<Kit | null> {
  return prisma.kit.findUnique({ where: { item_code: itemCode } });
}

/**
 * Creates a new kit in the catalogue.
 * item_code defaults to product_name if omitted (for manually entered kits
 * without a known supplier code).
 *
 * @throws Prisma unique-constraint error if item_code already exists.
 */
export async function createKit(input: CreateKitInput): Promise<Kit> {
  return prisma.kit.create({
    data: {
      product_name:  input.product_name,
      jpy_price:     input.jpy_price,
      weight_grams:  input.weight_grams,
      availability:  input.availability,
      item_code:     input.item_code ?? input.product_name,
      release_date:  input.release_date ?? null,
      stock_status:  input.stock_status ?? null,
    },
  });
}

/**
 * Updates mutable fields on an existing kit.
 * Only provided fields are changed; omitted fields remain as-is.
 *
 * @returns The updated kit, or null if the kit does not exist.
 */
export async function updateKit(
  id: string,
  patch: Partial<Omit<CreateKitInput, "item_code">>,
): Promise<Kit | null> {
  const existing = await prisma.kit.findUnique({ where: { id } });
  if (!existing) return null;

  return prisma.kit.update({ where: { id }, data: patch });
}

// ─── Wishlist ─────────────────────────────────────────────────────────────────

/**
 * Retrieves all wishlist entries for a user, ordered by date added.
 * Includes the full Kit object for each entry.
 */
export async function getUserWishlist(
  userId: string,
): Promise<(Wishlist & { kit: Kit })[]> {
  return prisma.wishlist.findMany({
    where: { userId },
    include: { kit: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Retrieves all users who have wishlisted a given kit.
 *
 * @returns Array of Wishlist rows (userId is the Discord snowflake).
 */
export async function getKitWishlisters(kitId: string): Promise<Wishlist[]> {
  return prisma.wishlist.findMany({ where: { kitId } });
}

/**
 * Adds a kit to a user's wishlist.
 *
 * @throws Prisma unique-constraint error if the entry already exists.
 */
export async function addToWishlist(
  userId: string,
  kitId: string,
  note?: string,
): Promise<Wishlist> {
  return prisma.wishlist.create({
    data: { userId, kitId, note: note ?? null },
  });
}

/**
 * Removes a kit from a user's wishlist.
 *
 * @returns true if a row was deleted, false if the entry did not exist.
 */
export async function removeFromWishlist(
  userId: string,
  kitId: string,
): Promise<boolean> {
  const result = await prisma.wishlist.deleteMany({
    where: { userId, kitId },
  });
  return result.count > 0;
}
