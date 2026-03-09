/**
 * @module tests/helpers
 *
 * Shared DB lifecycle + typed test-data factories for all service tests.
 *
 * Each test FILE gets a fresh in-memory SQLite database.
 * Each test CASE calls clearDb() in a beforeEach hook to wipe rows.
 *
 * Usage:
 *
 *   import { setupDb, clearDb, teardownDb, makeKit, makeGb, makeSlot, makeClaim } from "../helpers/mod.ts";
 *
 *   Deno.test({ name: "...", fn: ..., sanitizeResources: false });
 */

import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../generated/client.ts";
import type { ClaimStatus, GroupBuyStatus } from "../../generated/enums.ts";

let _client: PrismaClient | null = null;

export function getDb(): PrismaClient {
	if (_client) return _client;
	const adapter = new PrismaLibSql({ url: ":memory:" });
	_client = new PrismaClient({ adapter });
	return _client;
}

export async function setupDb(): Promise<void> {
	const db = getDb();
	await db.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);

	await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Kit" (
      "id"           TEXT PRIMARY KEY,
      "item_code"    TEXT UNIQUE NOT NULL,
      "release_date" TEXT,
      "jpy_price"    INTEGER NOT NULL,
      "weight_grams" INTEGER,
      "availability" TEXT NOT NULL,
      "stock_status" TEXT,
      "product_name" TEXT NOT NULL
    )`);

	await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GroupBuy" (
      "id"                    TEXT PRIMARY KEY,
      "threadId"              TEXT UNIQUE NOT NULL,
      "guildId"               TEXT NOT NULL,
      "ownerId"               TEXT NOT NULL,
      "buyerId"               TEXT,
      "receiverId"            TEXT,
      "status"                TEXT NOT NULL DEFAULT 'OPEN',
      "costPrice"             INTEGER,
      "domesticShippingCost"  INTEGER,
      "shippingCost"          INTEGER,
      "customsCost"           INTEGER,
      "totalWeight"           INTEGER,
      "shippingWeight"        INTEGER,
      "inrConversionRate"     REAL,
      "shippingTrackingNumber" TEXT,
      "shippingTrackingUrl"   TEXT,
      "customsTrackingUrl"    TEXT,
      "createdAt"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

	await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GroupBuyKit" (
      "id"           TEXT PRIMARY KEY,
      "groupBuyId"   TEXT NOT NULL REFERENCES "GroupBuy"("id"),
      "kitId"        TEXT NOT NULL REFERENCES "Kit"("id"),
      "weight_grams" INTEGER NOT NULL,
      "slotNumber"   INTEGER NOT NULL
    )`);

	await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GroupBuyClaim" (
      "id"                             TEXT PRIMARY KEY,
      "groupBuyId"                     TEXT NOT NULL REFERENCES "GroupBuy"("id"),
      "groupBuyKitId"                  TEXT NOT NULL REFERENCES "GroupBuyKit"("id"),
      "userId"                         TEXT NOT NULL,
      "status"                         TEXT NOT NULL DEFAULT 'PENDING',
      "calculatedKitCost"              INTEGER,
      "calculatedDomesticShippingCost" INTEGER,
      "calculatedShippingCost"         INTEGER,
      "calculatedCustomsCost"          INTEGER,
      "createdAt"                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

	await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ClaimPaymentEvent" (
      "id"        TEXT PRIMARY KEY,
      "claimId"   TEXT NOT NULL REFERENCES "GroupBuyClaim"("id"),
      "stage"     TEXT NOT NULL,
      "action"    TEXT NOT NULL,
      "actorId"   TEXT NOT NULL,
      "note"      TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
}

export async function clearDb(): Promise<void> {
	const db = getDb();
	await db.claimPaymentEvent.deleteMany();
	await db.groupBuyClaim.deleteMany();
	await db.groupBuyKit.deleteMany();
	await db.groupBuy.deleteMany();
	await db.kit.deleteMany();
}

export async function teardownDb(): Promise<void> {
	await _client?.$disconnect();
	_client = null;
}

// ─── Sequence counter for unique identifiers ──────────────────────────────────

let _seq = 0;
export function nextId(): string {
	return `test_${String(++_seq).padStart(6, "0")}`;
}
export function resetSeq(): void {
	_seq = 0;
}

// ─── Factories ────────────────────────────────────────────────────────────────

export interface KitOpts {
	product_name?: string;
	item_code?: string;
	jpy_price?: number;
	weight_grams?: number;
	availability?: string;
}

export function makeKit(opts: KitOpts = {}) {
	const id = nextId();
	return getDb().kit.create({
		data: {
			id,
			product_name: opts.product_name ?? `Test Kit ${id}`,
			item_code: opts.item_code ?? `TC-${id}`,
			jpy_price: opts.jpy_price ?? 2200,
			weight_grams: opts.weight_grams ?? 300,
			availability: opts.availability ?? "HLJ",
		},
	});
}

export interface GbOpts {
	threadId?: string;
	guildId?: string;
	ownerId?: string;
	status?: string;
	costPrice?: number | null;
	domesticShippingCost?: number | null;
	shippingCost?: number | null;
	customsCost?: number | null;
	inrConversionRate?: number | null;
	totalWeight?: number | null;
}

export function makeGb(opts: GbOpts = {}) {
	const id = nextId();
	return getDb().groupBuy.create({
		data: {
			id,
			threadId: opts.threadId ?? `thread_${id}`,
			guildId: opts.guildId ?? "guild_001",
			ownerId: opts.ownerId ?? "owner_001",
			status: (opts.status ?? "OPEN") as GroupBuyStatus,
			costPrice: opts.costPrice ?? null,
			domesticShippingCost: opts.domesticShippingCost ?? null,
			shippingCost: opts.shippingCost ?? null,
			customsCost: opts.customsCost ?? null,
			inrConversionRate: opts.inrConversionRate ?? null,
			totalWeight: opts.totalWeight ?? null,
		},
	});
}

export function makeSlot(
	groupBuyId: string,
	kitId: string,
	slotNumber: number,
	weight_grams = 300,
) {
	return getDb().groupBuyKit.create({
		data: { id: nextId(), groupBuyId, kitId, slotNumber, weight_grams },
	});
}

export interface ClaimOpts {
	status?: string;
	calculatedKitCost?: number | null;
	calculatedDomesticShippingCost?: number | null;
	calculatedShippingCost?: number | null;
	calculatedCustomsCost?: number | null;
}

export function makeClaim(
	groupBuyId: string,
	groupBuyKitId: string,
	userId: string,
	opts: ClaimOpts = {},
) {
	return getDb().groupBuyClaim.create({
		data: {
			id: nextId(),
			groupBuyId,
			groupBuyKitId,
			userId,
			status: (opts.status ?? "PENDING") as ClaimStatus,
			calculatedKitCost: opts.calculatedKitCost ?? null,
			calculatedDomesticShippingCost:
				opts.calculatedDomesticShippingCost ?? null,
			calculatedShippingCost: opts.calculatedShippingCost ?? null,
			calculatedCustomsCost: opts.calculatedCustomsCost ?? null,
		},
	});
}

/**
 * Scaffold: GB + one Kit + N slots (same kit, same weight).
 * Also sets totalWeight on the GB row.
 */
export async function scaffoldGb(
	slotCount: number,
	opts: { jpy_price?: number; weight_grams?: number; gbOpts?: GbOpts } = {},
) {
	const kit = await makeKit({
		jpy_price: opts.jpy_price ?? 3300,
		weight_grams: opts.weight_grams ?? 600,
	});
	const gb = await makeGb(opts.gbOpts);

	const slots = [];
	for (let i = 1; i <= slotCount; i++) {
		slots.push(await makeSlot(gb.id, kit.id, i, opts.weight_grams ?? 600));
	}

	const totalWeight = slotCount * (opts.weight_grams ?? 600);
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { totalWeight },
	});

	const updatedGb = await getDb().groupBuy.findUniqueOrThrow({
		where: { id: gb.id },
	});
	return { gb: updatedGb, kit, slots };
}
