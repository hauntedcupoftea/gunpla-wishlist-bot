/**
 * @module tests/services/search.service.test
 *
 * Integration tests for search.service.ts.
 *
 * Run:  deno test tests/services/search.service.test.ts --allow-env
 */

import { assertEquals, assertExists } from "@std/assert";
import * as SearchService from "../../src/services/search.service.ts";
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

const T = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ name: "search:setup", ...T, fn: setupDb });
Deno.test({ name: "search:teardown", ...T, fn: teardownDb });

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

// ─── searchGroupBuysByUser ────────────────────────────────────────────────────

test("searchGroupBuysByUser: finds GB where user is organiser", async () => {
	const gb = await makeGb({ guildId: "g1", ownerId: "u1", threadId: "t1" });
	await makeGb({ guildId: "g1", ownerId: "u2", threadId: "t2" }); // another user

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "g1",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gb.id);
});

test("searchGroupBuysByUser: finds GB where user is buyer", async () => {
	const gb = await makeGb({ guildId: "g1", ownerId: "owner", threadId: "t3" });
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { buyerId: "u1" },
	});

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "g1",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gb.id);
});

test("searchGroupBuysByUser: finds GB where user is receiver", async () => {
	const gb = await makeGb({ guildId: "g1", ownerId: "owner", threadId: "t4" });
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { receiverId: "u1" },
	});

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "g1",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gb.id);
});

test("searchGroupBuysByUser: finds GB where user has an active claim", async () => {
	const { gb, slots } = await scaffoldGb(1);
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { guildId: "gS" },
	});
	await makeClaim(gb.id, slots[0].id, "u1");

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "gS",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gb.id);
});

test("searchGroupBuysByUser: excludes GB when user's only claim is CANCELLED", async () => {
	const { gb, slots } = await scaffoldGb(1);
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { guildId: "gC" },
	});
	await makeClaim(gb.id, slots[0].id, "u1", { status: "CANCELLED" });

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "gC",
	});
	assertEquals(results.length, 0);
});

test("searchGroupBuysByUser: filters by status", async () => {
	await makeGb({
		guildId: "g2",
		ownerId: "u1",
		threadId: "open1",
		status: "OPEN",
	});
	await makeGb({
		guildId: "g2",
		ownerId: "u1",
		threadId: "purchased1",
		status: "PURCHASED",
	});

	const openOnly = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "g2",
		statuses: ["OPEN"],
	});
	assertEquals(openOnly.length, 1);
	assertEquals(openOnly[0].status, "OPEN");
});

test("searchGroupBuysByUser: userRoles is populated correctly for organiser+claimant", async () => {
	const { gb, slots } = await scaffoldGb(1);
	await getDb().groupBuy.update({
		where: { id: gb.id },
		data: { ownerId: "u1", guildId: "gR" },
	});
	await makeClaim(gb.id, slots[0].id, "u1");

	const results = await SearchService.searchGroupBuysByUser({
		userId: "u1",
		guildId: "gR",
	});
	assertExists(results[0].userRoles);
	assertEquals(results[0].userRoles.includes("organiser"), true);
	assertEquals(results[0].userRoles.includes("claimant"), true);
});

test("searchGroupBuysByKit: finds GB containing kit by partial name", async () => {
	const kit = await makeKit({ product_name: "HG Unicorn Gundam" });
	const gb = await makeGb({ guildId: "g3", threadId: "ku1" });
	await makeSlot(gb.id, kit.id, 1);

	const results = await SearchService.searchGroupBuysByKit({
		query: "Unicorn",
		guildId: "g3",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gb.id);
});

test("searchGroupBuysByKit: AND-matches all words in query", async () => {
	const kitA = await makeKit({ product_name: "HG Unicorn Gundam" });
	const kitB = await makeKit({ product_name: "MG Sazabi" });
	const gbA = await makeGb({ guildId: "g3", threadId: "ku2" });
	const gbB = await makeGb({ guildId: "g3", threadId: "ku3" });
	await makeSlot(gbA.id, kitA.id, 1);
	await makeSlot(gbB.id, kitB.id, 1);

	// "HG Unicorn" should match kitA only
	const results = await SearchService.searchGroupBuysByKit({
		query: "HG Unicorn",
		guildId: "g3",
	});
	assertEquals(results.length, 1);
	assertEquals(results[0].id, gbA.id);
});

test("searchGroupBuysByKit: returns activeClaims count", async () => {
	const kit = await makeKit({ product_name: "MG Freedom" });
	const gb = await makeGb({ guildId: "g4", threadId: "kc1" });
	const s1 = await makeSlot(gb.id, kit.id, 1);
	const s2 = await makeSlot(gb.id, kit.id, 2);
	await makeClaim(gb.id, s1.id, "uA");
	await makeClaim(gb.id, s2.id, "uB");
	await makeClaim(gb.id, s1.id, "uC", { status: "CANCELLED" }); // should not count

	const results = await SearchService.searchGroupBuysByKit({
		query: "Freedom",
		guildId: "g4",
	});
	assertEquals(results[0].activeClaims, 2);
});

test("searchGroupBuysByKit: populates userClaims when userId provided", async () => {
	const kit = await makeKit({ product_name: "HGUC Zaku II" });
	const gb = await makeGb({ guildId: "g5", threadId: "kuc1" });
	const s = await makeSlot(gb.id, kit.id, 1);
	await makeClaim(gb.id, s.id, "u1");

	const results = await SearchService.searchGroupBuysByKit({
		query: "Zaku",
		guildId: "g5",
		userId: "u1",
	});
	assertExists(results[0].userClaims);
	assertEquals(results[0].userClaims.length, 1);
});

test("searchGroupBuysByKit: userClaims is empty when userId has no claims", async () => {
	const kit = await makeKit({ product_name: "HGUC Zaku II" });
	const gb = await makeGb({ guildId: "g5", threadId: "kuc2" });
	await makeSlot(gb.id, kit.id, 1);

	const results = await SearchService.searchGroupBuysByKit({
		query: "Zaku",
		guildId: "g5",
		userId: "stranger",
	});
	assertEquals(results[0].userClaims, []);
});

test("searchGroupBuysByKit: filters by status", async () => {
	const kit = await makeKit({ product_name: "HG Barbatos" });
	const gbO = await makeGb({ guildId: "g6", threadId: "ks1", status: "OPEN" });
	const gbP = await makeGb({
		guildId: "g6",
		threadId: "ks2",
		status: "PURCHASED",
	});
	await makeSlot(gbO.id, kit.id, 1);
	await makeSlot(gbP.id, kit.id, 1);

	const open = await SearchService.searchGroupBuysByKit({
		query: "Barbatos",
		guildId: "g6",
		statuses: ["OPEN"],
	});
	assertEquals(open.length, 1);
	assertEquals(open[0].status, "OPEN");
});

// ─── autocompleteGroupBuys ────────────────────────────────────────────────────

test("autocompleteGroupBuys: returns { name, value } pairs with threadId as value", async () => {
	const kit = await makeKit({ product_name: "RG Exia" });
	const gb = await makeGb({ guildId: "g7", threadId: "ac1" });
	await makeSlot(gb.id, kit.id, 1);

	const opts = await SearchService.autocompleteGroupBuys("Exia", "g7");
	assertEquals(opts.length, 1);
	assertEquals(opts[0].value, "ac1"); // value = threadId
	assertExists(opts[0].name);
});

test("autocompleteGroupBuys: empty query returns recent GBs (up to 5)", async () => {
	for (let i = 0; i < 7; i++) {
		await makeGb({ guildId: "g8", threadId: `ac_recent_${i}` });
	}
	const opts = await SearchService.autocompleteGroupBuys("", "g8");
	assertEquals(opts.length <= 5, true);
});

test("autocompleteGroupBuys: empty query with userId returns user's GBs", async () => {
	const gbMine = await makeGb({
		guildId: "g9",
		ownerId: "u1",
		threadId: "ac_mine",
	});
	await makeGb({ guildId: "g9", ownerId: "u2", threadId: "ac_theirs" });

	const opts = await SearchService.autocompleteGroupBuys("", "g9", "u1");
	assertEquals(
		opts.every((o) => o.value !== "ac_theirs"),
		true,
	);
});

// ─── searchGroupBuysByUserWithCount ───────────────────────────────────────────

test("searchGroupBuysByUserWithCount: returns results and total count", async () => {
	await makeGb({ guildId: "gCount", ownerId: "u1", threadId: "cnt1" });
	await makeGb({ guildId: "gCount", ownerId: "u1", threadId: "cnt2" });
	await makeGb({ guildId: "gCount", ownerId: "u1", threadId: "cnt3" });

	const { results, total } = await SearchService.searchGroupBuysByUserWithCount(
		{
			userId: "u1",
			guildId: "gCount",
			limit: 2,
			offset: 0,
		},
	);

	assertEquals(total, 3); // total ignores pagination
	assertEquals(results.length, 2); // limit is respected
});

test("searchGroupBuysByUserWithCount: offset skips correctly", async () => {
	for (let i = 0; i < 4; i++) {
		await makeGb({ guildId: "gOff", ownerId: "u1", threadId: `off_${i}` });
	}
	const { results } = await SearchService.searchGroupBuysByUserWithCount({
		userId: "u1",
		guildId: "gOff",
		limit: 2,
		offset: 2,
	});
	assertEquals(results.length, 2);
});

// ─── searchGroupBuysByKitWithCount ────────────────────────────────────────────

test("searchGroupBuysByKitWithCount: returns results and total count", async () => {
	const kit = await makeKit({ product_name: "HG Wing Zero" });
	for (let i = 0; i < 3; i++) {
		const gb = await makeGb({ guildId: "gKC", threadId: `wz_${i}` });
		await makeSlot(gb.id, kit.id, 1);
	}

	const { results, total } = await SearchService.searchGroupBuysByKitWithCount({
		query: "Wing Zero",
		guildId: "gKC",
		limit: 2,
		offset: 0,
	});

	assertEquals(total, 3);
	assertEquals(results.length, 2);
});
