/**
 * @module tests/services/groupbuy.service.test
 *
 * Integration tests for groupbuy.service.ts.
 * Uses an in-memory SQLite DB via libsql — no mocking, real Prisma queries.
 *
 * Run:  deno test tests/services/groupbuy.service.test.ts --allow-env
 *
 * Note: { sanitizeResources: false, sanitizeOps: false } suppresses Deno's
 * async resource leak warnings from the libsql connection (expected for a
 * persistent in-memory DB shared across tests).
 */

import {
  assertEquals,
  assertExists,
  type assertGreater,
  assertRejects,
} from "jsr:@std/assert";
import {
  clearDb,
  getDb,
  makeClaim,
  makeGb,
  makeKit,
  makeSlot,
  scaffoldGb,
  setupDb,
  teardownDb,
} from "../helpers/mod.ts";
import * as GbService from "../../src/services/groupbuy.service.ts";

const T = { sanitizeResources: false, sanitizeOps: false };

// ─── Lifecycle ────────────────────────────────────────────────────────────────

Deno.test({ name: "setup", ...T, fn: setupDb });
Deno.test({ name: "teardown", ...T, fn: teardownDb });

// Each test clears the DB. Wrap suites in a group function for readability.
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ...T,
    fn: async () => {
      await clearDb();
      await fn();
    },
  });
}

// ─── createGroupBuy ───────────────────────────────────────────────────────────

test("createGroupBuy: creates a GB with OPEN status", async () => {
  const gb = await GbService.createGroupBuy({
    threadId: "t1",
    guildId: "g1",
    ownerId: "u1",
  });
  assertEquals(gb.threadId, "t1");
  assertEquals(gb.status, "OPEN");
  assertEquals(gb.costPrice, null);
});

test("createGroupBuy: duplicate threadId throws", async () => {
  await GbService.createGroupBuy({
    threadId: "dup",
    guildId: "g1",
    ownerId: "u1",
  });
  await assertRejects(
    () =>
      GbService.createGroupBuy({
        threadId: "dup",
        guildId: "g1",
        ownerId: "u2",
      }),
  );
});

// ─── getGroupBuyByThread ──────────────────────────────────────────────────────

test("getGroupBuyByThread: returns null for unknown thread", async () => {
  const result = await GbService.getGroupBuyByThread("nope");
  assertEquals(result, null);
});

test("getGroupBuyByThread: returns full GB with empty kits and claims", async () => {
  await GbService.createGroupBuy({
    threadId: "t2",
    guildId: "g1",
    ownerId: "u1",
  });
  const gb = await GbService.getGroupBuyByThread("t2");
  assertExists(gb);
  assertEquals(gb.kits, []);
  assertEquals(gb.claims, []);
});

// ─── setGroupBuyStatus ────────────────────────────────────────────────────────

test("setGroupBuyStatus: persists new status", async () => {
  const gb = await makeGb();
  const updated = await GbService.setGroupBuyStatus(gb.id, "PURCHASED");
  assertEquals(updated.status, "PURCHASED");
});

// ─── transferGroupBuyOwnership ────────────────────────────────────────────────

test("transferGroupBuyOwnership: changes ownerId", async () => {
  const gb = await makeGb({ ownerId: "u1" });
  const updated = await GbService.transferGroupBuyOwnership(gb.id, "u2");
  assertEquals(updated.ownerId, "u2");
});

// ─── updateFinancials + recalculation ─────────────────────────────────────────

test("updateFinancials: sets costPrice and recalculates single claim", async () => {
  // 3-slot GB, only one claimed. Claimant should get 1/3 of costPrice
  // because denominator = ALL slots (proxy-buy model).
  const { gb, slots } = await scaffoldGb(3, {
    jpy_price: 3300,
    gbOpts: { ownerId: "u1" },
  });
  const claim = await makeClaim(gb.id, slots[0].id, "u2");

  await GbService.updateFinancials(gb.id, { costPrice: 9900 });

  const updated = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: claim.id },
  });
  // fraction = 3300 / (3300*3) = 1/3 → 9900 * 1/3 = 3300
  assertEquals(updated.calculatedKitCost, 3300);
});

test("updateFinancials: all 3 claimants get equal splits for equal MSRP slots", async () => {
  const { gb, slots } = await scaffoldGb(3, { jpy_price: 3300 });
  for (let i = 0; i < 3; i++) await makeClaim(gb.id, slots[i].id, `u${i}`);

  await GbService.updateFinancials(gb.id, { costPrice: 9900 });

  const claims = await getDb().groupBuyClaim.findMany({
    where: { groupBuyId: gb.id },
  });
  for (const c of claims) {
    assertEquals(c.calculatedKitCost, 3300, "Each claimant should get ¥3,300");
  }
});

test("updateFinancials: null costPrice clears calculatedKitCost on all claims", async () => {
  const { gb, slots } = await scaffoldGb(2);
  const c1 = await makeClaim(gb.id, slots[0].id, "u1", {
    calculatedKitCost: 5000,
  });
  await GbService.updateFinancials(gb.id, { costPrice: null });

  const updated = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: c1.id },
  });
  assertEquals(updated.calculatedKitCost, null);
});

test("updateFinancials: shipping split uses weight denominator (all slots)", async () => {
  // Kit A: 2 slots × 400g. Kit B: 1 slot × 200g. Total weight = 1000g.
  const kitA = await makeKit({ weight_grams: 400, jpy_price: 3000 });
  const kitB = await makeKit({ weight_grams: 200, jpy_price: 3000 });
  const gb = await makeGb();

  const slotA1 = await makeSlot(gb.id, kitA.id, 1, 400);
  const slotA2 = await makeSlot(gb.id, kitA.id, 2, 400);
  const slotB = await makeSlot(gb.id, kitB.id, 1, 200);

  await getDb().groupBuy.update({
    where: { id: gb.id },
    data: { totalWeight: 1000 },
  });

  // Claim slot A1 and slot B
  const cA = await makeClaim(gb.id, slotA1.id, "uA");
  const cB = await makeClaim(gb.id, slotB.id, "uB");
  // slotA2 is unclaimed — still part of denominator

  await GbService.updateFinancials(gb.id, { shippingCost: 1000 });

  const updA = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: cA.id },
  });
  const updB = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: cB.id },
  });

  // A: 400 / 1000 × 1000 = 400
  // B: 200 / 1000 × 1000 = 200
  assertEquals(updA.calculatedShippingCost, 400);
  assertEquals(updB.calculatedShippingCost, 200);
});

test("updateFinancials: domesticShippingCost uses MSRP proportion (same as kit cost)", async () => {
  const kitA = await makeKit({ jpy_price: 6000 });
  const kitB = await makeKit({ jpy_price: 3000 });
  const gb = await makeGb();
  const slotA = await makeSlot(gb.id, kitA.id, 1, 600);
  const slotB = await makeSlot(gb.id, kitB.id, 1, 600);
  await getDb().groupBuy.update({
    where: { id: gb.id },
    data: { totalWeight: 1200 },
  });

  const cA = await makeClaim(gb.id, slotA.id, "uA");
  const cB = await makeClaim(gb.id, slotB.id, "uB");

  await GbService.updateFinancials(gb.id, { domesticShippingCost: 900 });

  const updA = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: cA.id },
  });
  const updB = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: cB.id },
  });

  // A: 6000/9000 × 900 = 600; B: 3000/9000 × 900 = 300
  assertEquals(updA.calculatedDomesticShippingCost, 600);
  assertEquals(updB.calculatedDomesticShippingCost, 300);
});

// ─── addKitToGroupBuy ─────────────────────────────────────────────────────────

test("addKitToGroupBuy: creates correct number of slots with sequential numbers", async () => {
  const kit = await makeKit();
  const gb = await makeGb();

  const slots = await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 400,
    quantity: 3,
  });

  assertEquals(slots.length, 3);
  assertEquals(slots.map((s) => s.slotNumber), [1, 2, 3]);
});

test("addKitToGroupBuy: second batch continues numbering from last slot", async () => {
  const kit = await makeKit();
  const gb = await makeGb();
  await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 400,
    quantity: 2,
  });
  const second = await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 400,
    quantity: 2,
  });

  assertEquals(second.map((s) => s.slotNumber), [3, 4]);
});

test("addKitToGroupBuy: updates totalWeight on GB", async () => {
  const kit = await makeKit({ weight_grams: 500 });
  const gb = await makeGb();
  await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 500,
    quantity: 2,
  });

  const updated = await getDb().groupBuy.findUniqueOrThrow({
    where: { id: gb.id },
  });
  assertEquals(updated.totalWeight, 1000);
});

// ─── removeKitFromGroupBuy ────────────────────────────────────────────────────

test("removeKitFromGroupBuy: removes highest-numbered unclaimed slot first (LIFO)", async () => {
  const kit = await makeKit();
  const gb = await makeGb();
  const slots = await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 300,
    quantity: 3,
  });
  // Claim slot 1; slots 2 and 3 are unclaimed
  await makeClaim(gb.id, slots[0].id, "u1");

  await GbService.removeKitFromGroupBuy(gb.id, kit.id, 1);

  const remaining = await getDb().groupBuyKit.findMany({
    where: { groupBuyId: gb.id },
  });
  const remainingSlots = remaining.map((s) => s.slotNumber).sort();
  // Slot 3 (highest unclaimed) should be removed; slots 1 and 2 remain
  assertEquals(remainingSlots, [1, 2]);
});

test("removeKitFromGroupBuy: throws when trying to remove more slots than available", async () => {
  const kit = await makeKit();
  const gb = await makeGb();
  const slots = await GbService.addKitToGroupBuy({
    groupBuyId: gb.id,
    kitId: kit.id,
    weightGrams: 300,
    quantity: 2,
  });
  await makeClaim(gb.id, slots[0].id, "u1");
  await makeClaim(gb.id, slots[1].id, "u2");

  await assertRejects(() => GbService.removeKitFromGroupBuy(gb.id, kit.id, 1));
});

// ─── claimKit ─────────────────────────────────────────────────────────────────

test("claimKit: creates a PENDING claim on the best slot", async () => {
  const { gb, kit } = await scaffoldGb(2);
  const claim = await GbService.claimKit(gb.id, kit.id, "u1");
  assertEquals(claim.status, "PENDING");
  assertExists(claim.groupBuyKitId);
});

test("claimKit: throws when user already has an active claim for this kit", async () => {
  const { gb, kit } = await scaffoldGb(2);
  await GbService.claimKit(gb.id, kit.id, "u1");
  await assertRejects(() => GbService.claimKit(gb.id, kit.id, "u1"));
});

test("claimKit: distributes to least-claimed slot (contested slot logic)", async () => {
  const { gb, kit, slots } = await scaffoldGb(2);
  // Put 2 claims on slot 1, 1 claim on slot 2
  await makeClaim(gb.id, slots[0].id, "uA");
  await makeClaim(gb.id, slots[0].id, "uB");
  await makeClaim(gb.id, slots[1].id, "uC");

  // Next claim should prefer slot 2 (fewer claims)
  const claim = await GbService.claimKit(gb.id, kit.id, "uD");
  assertEquals(claim.groupBuyKitId, slots[1].id);
});

test("claimKit: throws when kit has no slots in this GB", async () => {
  const gb = await makeGb();
  const kit = await makeKit();
  await assertRejects(() => GbService.claimKit(gb.id, kit.id, "u1"));
});

// ─── cancelClaim ─────────────────────────────────────────────────────────────

test("cancelClaim: sets status to CANCELLED", async () => {
  const { gb, slots } = await scaffoldGb(1);
  const claim = await makeClaim(gb.id, slots[0].id, "u1");
  const result = await GbService.cancelClaim(claim.id);
  assertEquals(result.status, "CANCELLED");
});

// ─── confirmClaim ─────────────────────────────────────────────────────────────

test("confirmClaim: advances status from PENDING to CONFIRMED", async () => {
  const { gb, slots } = await scaffoldGb(1);
  const claim = await makeClaim(gb.id, slots[0].id, "u1");
  const result = await GbService.confirmClaim(claim.id);
  assertEquals(result.status, "CONFIRMED");
});

// ─── confirmUncontestedClaims ─────────────────────────────────────────────────

test("confirmUncontestedClaims: confirms only single-claimant PENDING slots", async () => {
  const { gb, slots } = await scaffoldGb(3);
  const c1 = await makeClaim(gb.id, slots[0].id, "uA"); // uncontested
  const c2 = await makeClaim(gb.id, slots[1].id, "uB"); // contested
  const c3 = await makeClaim(gb.id, slots[1].id, "uC"); // contested
  await makeClaim(gb.id, slots[2].id, "uD"); // uncontested

  const count = await GbService.confirmUncontestedClaims(gb.id);
  assertEquals(count, 2); // slots[0] and slots[2]

  const updated1 = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: c1.id },
  });
  const updated2 = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: c2.id },
  });
  const updated3 = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: c3.id },
  });
  assertEquals(updated1.status, "CONFIRMED");
  assertEquals(updated2.status, "PENDING"); // contested, untouched
  assertEquals(updated3.status, "PENDING"); // contested, untouched
});

// ─── resolveContestedSlot ─────────────────────────────────────────────────────

test("resolveContestedSlot: confirms winner, cancels losers", async () => {
  const { gb, slots } = await scaffoldGb(1);
  const winner = await makeClaim(gb.id, slots[0].id, "uA");
  const loser1 = await makeClaim(gb.id, slots[0].id, "uB");
  const loser2 = await makeClaim(gb.id, slots[0].id, "uC");

  await GbService.resolveContestedSlot(slots[0].id, winner.id);

  const w = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: winner.id },
  });
  const l1 = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: loser1.id },
  });
  const l2 = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: loser2.id },
  });
  assertEquals(w.status, "CONFIRMED");
  assertEquals(l1.status, "CANCELLED");
  assertEquals(l2.status, "CANCELLED");
});

// ─── transferClaim ────────────────────────────────────────────────────────────

test("transferClaim: changes userId on the claim", async () => {
  const { gb, slots } = await scaffoldGb(1);
  const claim = await makeClaim(gb.id, slots[0].id, "uA");
  const result = await GbService.transferClaim(claim.id, "uB");
  assertEquals(result.userId, "uB");
});

test("transferClaim: throws when target already has an active claim for same kit", async () => {
  const { gb, kit, slots } = await scaffoldGb(2);
  const c1 = await makeClaim(gb.id, slots[0].id, "uA");
  await makeClaim(gb.id, slots[1].id, "uB"); // uB already claimed

  await assertRejects(() => GbService.transferClaim(c1.id, "uB"));
});

// ─── reportPayment ────────────────────────────────────────────────────────────

test("reportPayment: creates REPORTED event when stage is open", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CONFIRMED",
  });

  const event = await GbService.reportPayment(claim.id, "u1", "KIT");
  assertEquals(event.action, "REPORTED");
  assertEquals(event.stage, "KIT");
});

test("reportPayment: throws when costPrice not set (stage not open)", async () => {
  const { gb, slots } = await scaffoldGb(1); // no costPrice
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CONFIRMED",
  });

  await assertRejects(() => GbService.reportPayment(claim.id, "u1", "KIT"));
});

test("reportPayment: throws when reporting domestic shipping with no domesticShippingCost set", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 3300 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "KIT_PAID",
  });

  await assertRejects(() =>
    GbService.reportPayment(claim.id, "u1", "DOMESTIC_SHIPPING")
  );
});

test("reportPayment: throws when already confirmed for that stage", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "KIT_PAID",
  });

  // Confirm directly via payment event
  await getDb().claimPaymentEvent.create({
    data: {
      id: `evt_${Date.now()}`,
      claimId: claim.id,
      stage: "KIT",
      action: "CONFIRMED",
      actorId: "org",
    },
  });

  await assertRejects(() => GbService.reportPayment(claim.id, "u1", "KIT"));
});

// ─── confirmPaymentStage ─────────────────────────────────────────────────────

test("confirmPaymentStage: advances claim status to KIT_PAID", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CONFIRMED",
  });
  await GbService.reportPayment(claim.id, "u1", "KIT");

  const { claim: updated } = await GbService.confirmPaymentStage(
    claim.id,
    "org",
    "KIT",
  );
  assertEquals(updated.status, "KIT_PAID");
});

test("confirmPaymentStage: advances to DOMESTIC_SHIPPING_PAID", async () => {
  const { gb, slots } = await scaffoldGb(1, {
    gbOpts: { costPrice: 9900, domesticShippingCost: 500 },
  });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "KIT_PAID",
  });
  await GbService.reportPayment(claim.id, "u1", "DOMESTIC_SHIPPING");

  const { claim: updated } = await GbService.confirmPaymentStage(
    claim.id,
    "org",
    "DOMESTIC_SHIPPING",
  );
  assertEquals(updated.status, "DOMESTIC_SHIPPING_PAID");
});

test("confirmPaymentStage: throws when member has not reported yet", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  await makeClaim(gb.id, slots[0].id, "u1", { status: "CONFIRMED" });
  const claims = await getDb().groupBuyClaim.findMany({
    where: { groupBuyId: gb.id },
  });

  await assertRejects(() =>
    GbService.confirmPaymentStage(claims[0].id, "org", "KIT")
  );
});

test("confirmPaymentStage: throws on double-confirm", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CONFIRMED",
  });
  await GbService.reportPayment(claim.id, "u1", "KIT");
  await GbService.confirmPaymentStage(claim.id, "org", "KIT");

  await assertRejects(() =>
    GbService.confirmPaymentStage(claim.id, "org", "KIT")
  );
});

// ─── rejectPaymentReport ─────────────────────────────────────────────────────

test("rejectPaymentReport: creates REJECTED event without changing claim status", async () => {
  const { gb, slots } = await scaffoldGb(1, { gbOpts: { costPrice: 9900 } });
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CONFIRMED",
  });
  await GbService.reportPayment(claim.id, "u1", "KIT");

  const event = await GbService.rejectPaymentReport(
    claim.id,
    "org",
    "KIT",
    "Wrong amount",
  );
  assertEquals(event.action, "REJECTED");

  const unchanged = await getDb().groupBuyClaim.findUniqueOrThrow({
    where: { id: claim.id },
  });
  assertEquals(unchanged.status, "CONFIRMED");
});

// ─── markPaidInFull ───────────────────────────────────────────────────────────

test("markPaidInFull: sets status to PAID_IN_FULL", async () => {
  const { gb, slots } = await scaffoldGb(1);
  const claim = await makeClaim(gb.id, slots[0].id, "u1", {
    status: "CUSTOMS_PAID",
  });
  const result = await GbService.markPaidInFull(claim.id);
  assertEquals(result.status, "PAID_IN_FULL");
});

// ─── getGroupBuySummary ───────────────────────────────────────────────────────

test("getGroupBuySummary: returns empty array when no claims", async () => {
  const { gb } = await scaffoldGb(2);
  const summary = await GbService.getGroupBuySummary(gb.id);
  assertEquals(summary, []);
});

test("getGroupBuySummary: msrpFraction uses ALL slots as denominator", async () => {
  // 3 identical slots, only 1 claimed — fraction should be 1/3, not 1/1
  const { gb, slots } = await scaffoldGb(3, { jpy_price: 3300 });
  await makeClaim(gb.id, slots[0].id, "u1");
  await GbService.updateFinancials(gb.id, { costPrice: 9900 });

  const [row] = await GbService.getGroupBuySummary(gb.id);
  assertEquals(row.msrpFraction, 1 / 3);
  assertEquals(row.calculatedKitCost, 3300);
});

test("getGroupBuySummary: totalJpy sums all calculated cost components", async () => {
  const { gb, slots } = await scaffoldGb(1);
  await makeClaim(gb.id, slots[0].id, "u1", {
    calculatedKitCost: 3300,
    calculatedDomesticShippingCost: 200,
    calculatedShippingCost: 500,
    calculatedCustomsCost: 100,
  });

  const [row] = await GbService.getGroupBuySummary(gb.id);
  assertEquals(row.totalJpy, 4100);
});

test("getGroupBuySummary: computes totalInr from stored conversion rate", async () => {
  const { gb, slots } = await scaffoldGb(1, {
    gbOpts: { inrConversionRate: 0.61 },
  });
  await makeClaim(gb.id, slots[0].id, "u1", { calculatedKitCost: 10000 });

  const [row] = await GbService.getGroupBuySummary(gb.id);
  assertEquals(row.totalInr, 6100);
});

test("getGroupBuySummary: totalInr is null when no conversion rate set", async () => {
  const { gb, slots } = await scaffoldGb(1); // no inrConversionRate
  await makeClaim(gb.id, slots[0].id, "u1", { calculatedKitCost: 3300 });

  const [row] = await GbService.getGroupBuySummary(gb.id);
  assertEquals(row.totalInr, null);
});

test("getGroupBuySummary: sort order puts least-paid first (CONFIRMED before KIT_PAID)", async () => {
  const { gb, kit } = await scaffoldGb(3);
  const [s1, s2, s3] = await getDb().groupBuyKit.findMany({
    where: { groupBuyId: gb.id },
  });

  await makeClaim(gb.id, s1.id, "uA", { status: "KIT_PAID" });
  await makeClaim(gb.id, s2.id, "uB", { status: "CONFIRMED" });
  await makeClaim(gb.id, s3.id, "uC", { status: "SHIPPING_PAID" });

  const summary = await GbService.getGroupBuySummary(gb.id);
  assertEquals(summary[0].status, "CONFIRMED");
  assertEquals(summary[1].status, "KIT_PAID");
  assertEquals(summary[2].status, "SHIPPING_PAID");
});

test("getGroupBuySummary: cancelled claims are excluded", async () => {
  const { gb, slots } = await scaffoldGb(2);
  await makeClaim(gb.id, slots[0].id, "uA", { status: "CANCELLED" });
  await makeClaim(gb.id, slots[1].id, "uB");

  const summary = await GbService.getGroupBuySummary(gb.id);
  assertEquals(summary.length, 1);
  assertEquals(summary[0].userId, "uB");
});

test("getGroupBuySummary: rate parameter overrides stored conversion rate", async () => {
  const { gb, slots } = await scaffoldGb(1, {
    gbOpts: { inrConversionRate: 0.50 },
  });
  await makeClaim(gb.id, slots[0].id, "u1", { calculatedKitCost: 10000 });

  const [row] = await GbService.getGroupBuySummary(gb.id, 0.65);
  assertEquals(row.totalInr, 6500); // uses 0.65, not 0.50
});

// ─── getClaimableKitsForUser ──────────────────────────────────────────────────

test("getClaimableKitsForUser: excludes kits the user has already claimed", async () => {
  const kitA = await makeKit({ product_name: "Kit Alpha" });
  const kitB = await makeKit({ product_name: "Kit Beta" });
  const gb = await makeGb({ threadId: "threadX" });
  const sA = await makeSlot(gb.id, kitA.id, 1);
  const sB = await makeSlot(gb.id, kitB.id, 1);
  await makeClaim(gb.id, sA.id, "u1"); // u1 claimed Kit Alpha

  const opts = await GbService.getClaimableKitsForUser("threadX", "u1", "");
  const names = opts.map((o) => o.name);
  assertEquals(names.some((n) => n.includes("Alpha")), false);
  assertEquals(names.some((n) => n.includes("Beta")), true);
});

// ─── getUserClaimOptions ──────────────────────────────────────────────────────

test("getUserClaimOptions: returns only that user's active claims", async () => {
  const { gb, slots } = await scaffoldGb(2);
  await getDb().groupBuy.update({
    where: { id: gb.id },
    data: { threadId: "threadY" },
  });
  await makeClaim(gb.id, slots[0].id, "u1");
  await makeClaim(gb.id, slots[1].id, "u2"); // different user

  const opts = await GbService.getUserClaimOptions("threadY", "u1", "");
  assertEquals(opts.length, 1);
});

// ─── getAllClaimOptions ───────────────────────────────────────────────────────

test("getAllClaimOptions: returns all active claims across all users", async () => {
  const { gb, slots } = await scaffoldGb(2);
  await getDb().groupBuy.update({
    where: { id: gb.id },
    data: { threadId: "threadZ" },
  });
  await makeClaim(gb.id, slots[0].id, "u1");
  await makeClaim(gb.id, slots[1].id, "u2");

  const opts = await GbService.getAllClaimOptions("threadZ", "");
  assertEquals(opts.length, 2);
});

test("getAllClaimOptions: excludes CANCELLED claims", async () => {
  const { gb, slots } = await scaffoldGb(2);
  await getDb().groupBuy.update({
    where: { id: gb.id },
    data: { threadId: "threadQ" },
  });
  await makeClaim(gb.id, slots[0].id, "u1", { status: "CANCELLED" });
  await makeClaim(gb.id, slots[1].id, "u2");

  const opts = await GbService.getAllClaimOptions("threadQ", "");
  assertEquals(opts.length, 1);
});

// ─── listGroupBuysByGuild ─────────────────────────────────────────────────────

test("listGroupBuysByGuild: returns only GBs in specified guild", async () => {
  await makeGb({ guildId: "g1", threadId: "t-g1-1" });
  await makeGb({ guildId: "g1", threadId: "t-g1-2" });
  await makeGb({ guildId: "g2", threadId: "t-g2-1" });

  const results = await GbService.listGroupBuysByGuild("g1");
  assertEquals(results.length, 2);
  assertEquals(results.every((g) => g.guildId === "g1"), true);
});
