/**
 * @module tests/helpers
 *
 * Shared DB lifecycle + typed test-data factories for all service tests.
 *
 * Uses testPrisma from ./prisma.ts — a dedicated client that reads
 * TEST_DATABASE_URL and has nothing to do with the app's .env or singleton.
 */

import type { ClaimStatus, GroupBuyStatus } from "../../generated/enums.ts";
import { testPrisma } from "./prisma.ts";

export function getDb() {
  return testPrisma;
}

export async function setupDb(): Promise<void> {
  await testPrisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
}

export async function clearDb(): Promise<void> {
  await testPrisma.$transaction([
    testPrisma.claimPaymentEvent.deleteMany(),
    testPrisma.groupBuyClaim.deleteMany(),
    testPrisma.groupBuyKit.deleteMany(),
    testPrisma.groupBuy.deleteMany(),
    testPrisma.kit.deleteMany(),
  ]);
}

export async function teardownDb(): Promise<void> {
  await testPrisma.$disconnect();
}

// Sequence counter

let _seq = 0;
export function nextId(): string {
  return `test_${String(++_seq).padStart(6, "0")}`;
}

// Factories

export interface KitOpts {
  product_name?: string;
  item_code?: string;
  jpy_price?: number;
  weight_grams?: number;
  availability?: string;
}

export function makeKit(opts: KitOpts = {}) {
  const id = nextId();
  return testPrisma.kit.create({
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
  return testPrisma.groupBuy.create({
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
  return testPrisma.groupBuyKit.create({
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
  return testPrisma.groupBuyClaim.create({
    data: {
      id: nextId(),
      groupBuyId,
      groupBuyKitId,
      userId,
      status: (opts.status ?? "PENDING") as ClaimStatus,
      calculatedKitCost: opts.calculatedKitCost ?? null,
      calculatedDomesticShippingCost: opts.calculatedDomesticShippingCost ??
        null,
      calculatedShippingCost: opts.calculatedShippingCost ?? null,
      calculatedCustomsCost: opts.calculatedCustomsCost ?? null,
    },
  });
}

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

  await testPrisma.groupBuy.update({
    where: { id: gb.id },
    data: { totalWeight: slotCount * (opts.weight_grams ?? 600) },
  });

  const updatedGb = await testPrisma.groupBuy.findUniqueOrThrow({
    where: { id: gb.id },
  });
  return { gb: updatedGb, kit, slots };
}
