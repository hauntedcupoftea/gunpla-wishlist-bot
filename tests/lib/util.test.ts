/**
 * @module tests/lib/util.test
 *
 * Unit tests for src/lib/util.ts.
 * All functions are pure / synchronous — no DB or async I/O needed.
 *
 * Run:  deno test tests/lib/util.test.ts
 */

import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert";
import {
  CLAIM_STATUS_LABEL,
  fmtCost,
  fmtInr,
  fmtJpy,
  fmtPct,
  kitNameFilter,
  nextClaimStatus,
  toInr,
  withOverrideNote,
} from "../../src/lib/util.ts";

// fmtJpy

Deno.test("fmtJpy: formats zero", () => {
  assertEquals(fmtJpy(0), "¥0");
});

Deno.test("fmtJpy: formats four-digit amount", () => {
  assertEquals(fmtJpy(2200), "¥2,200");
});

Deno.test("fmtJpy: formats five-digit amount", () => {
  assertEquals(fmtJpy(12500), "¥12,500");
});

Deno.test("fmtJpy: always starts with ¥", () => {
  assertMatch(fmtJpy(999), /^¥/);
});

// fmtInr

Deno.test("fmtInr: formats zero", () => {
  assertEquals(fmtInr(0), "₹0");
});

Deno.test("fmtInr: rounds fractional amounts up", () => {
  assertMatch(fmtInr(7125.7), /₹7,126/);
});

Deno.test("fmtInr: always starts with ₹", () => {
  assertMatch(fmtInr(500), /^₹/);
});

// fmtPct

Deno.test("fmtPct: always shows exactly 2 decimal places", () => {
  assertEquals(fmtPct(0.1036), "10.36%");
  assertEquals(fmtPct(1.0), "100.00%");
  assertEquals(fmtPct(0.0), "0.00%");
});

Deno.test("fmtPct: one-third rounds to 33.33%", () => {
  assertEquals(fmtPct(1 / 3), "33.33%");
});

Deno.test("fmtPct: always ends with %", () => {
  assertMatch(fmtPct(0.5), /%$/);
});

// toInr

Deno.test("toInr: converts at given rate and rounds", () => {
  assertEquals(toInr(10000, 0.51), 5100);
  assertEquals(toInr(3300, 0.51), 1683); // 3300 * 0.51 = 1683.0 exactly
});

Deno.test("toInr: returns null when rate is null", () => {
  assertEquals(toInr(5000, null), null);
});

Deno.test("toInr: returns null when rate is undefined", () => {
  assertEquals(toInr(5000, undefined), null);
});

Deno.test("toInr: returns null when rate is 0 (falsy guard)", () => {
  assertEquals(toInr(5000, 0), null);
});

// fmtCost

Deno.test("fmtCost: shows only JPY when no rate", () => {
  assertEquals(fmtCost(12500, null), "¥12,500");
  assertEquals(fmtCost(12500, undefined), "¥12,500");
});

Deno.test("fmtCost: appends INR in parentheses when rate given", () => {
  assertEquals(fmtCost(10000, 0.61), "¥10,000 (₹6,100)");
});

Deno.test("fmtCost: INR is rounded in output", () => {
  assertMatch(fmtCost(3300, 0.51), /₹1,683/);
});

// nextClaimStatus

Deno.test("nextClaimStatus: full flow WITHOUT domestic shipping", () => {
  const cases: [string, string | null][] = [
    ["PENDING", "CONFIRMED"],
    ["CONFIRMED", "KIT_PAID"],
    ["KIT_PAID", "SHIPPING_PAID"], // skips DOMESTIC_SHIPPING_PAID
    ["SHIPPING_PAID", "CUSTOMS_PAID"],
    ["CUSTOMS_PAID", "PAID_IN_FULL"],
    ["PAID_IN_FULL", null],
  ];
  for (const [from, to] of cases) {
    assertEquals(nextClaimStatus(from, false), to, `${from} → ${String(to)}`);
  }
});

Deno.test("nextClaimStatus: full flow WITH domestic shipping", () => {
  const cases: [string, string | null][] = [
    ["PENDING", "CONFIRMED"],
    ["CONFIRMED", "KIT_PAID"],
    ["KIT_PAID", "DOMESTIC_SHIPPING_PAID"],
    ["DOMESTIC_SHIPPING_PAID", "SHIPPING_PAID"],
    ["SHIPPING_PAID", "CUSTOMS_PAID"],
    ["CUSTOMS_PAID", "PAID_IN_FULL"],
    ["PAID_IN_FULL", null],
  ];
  for (const [from, to] of cases) {
    assertEquals(nextClaimStatus(from, true), to, `${from} → ${String(to)}`);
  }
});

Deno.test("nextClaimStatus: CANCELLED is terminal regardless of flag", () => {
  assertEquals(nextClaimStatus("CANCELLED", false), null);
  assertEquals(nextClaimStatus("CANCELLED", true), null);
});

Deno.test("nextClaimStatus: WAREHOUSE_PAID is gone — returns null (not in flow)", () => {
  assertEquals(nextClaimStatus("WAREHOUSE_PAID", false), null);
});

Deno.test("nextClaimStatus: unknown status returns null", () => {
  assertEquals(nextClaimStatus("NONSENSE", false), null);
});

// withOverrideNote

Deno.test("withOverrideNote: no change when adminOverride=false", () => {
  assertEquals(withOverrideNote("Kit added.", false), "Kit added.");
});

Deno.test("withOverrideNote: appends notice on a new line when adminOverride=true", () => {
  const result = withOverrideNote("Done.", true);
  assertEquals(result.startsWith("Done.\n"), true);
  assertMatch(result, /Admin override/);
});

Deno.test("withOverrideNote: original content is preserved", () => {
  const msg = "Transfer complete.";
  assertMatch(withOverrideNote(msg, true), new RegExp(msg));
});

// CLAIM_STATUS_LABEL

const ALL_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "KIT_PAID",
  "DOMESTIC_SHIPPING_PAID",
  "SHIPPING_PAID",
  "CUSTOMS_PAID",
  "PAID_IN_FULL",
  "CANCELLED",
] as const;

Deno.test("CLAIM_STATUS_LABEL: every ClaimStatus has a label", () => {
  for (const s of ALL_STATUSES) {
    assertNotEquals(CLAIM_STATUS_LABEL[s], undefined, `Missing label for ${s}`);
  }
});

Deno.test("CLAIM_STATUS_LABEL: WAREHOUSE_PAID is absent (renamed)", () => {
  assertEquals(CLAIM_STATUS_LABEL["WAREHOUSE_PAID"], undefined);
});

Deno.test("CLAIM_STATUS_LABEL: stage numbers are sequential 0-6", () => {
  assertMatch(CLAIM_STATUS_LABEL["PENDING"], /Stage 0/);
  assertMatch(CLAIM_STATUS_LABEL["CONFIRMED"], /Stage 1/);
  assertMatch(CLAIM_STATUS_LABEL["KIT_PAID"], /Stage 2/);
  assertMatch(CLAIM_STATUS_LABEL["DOMESTIC_SHIPPING_PAID"], /Stage 3/);
  assertMatch(CLAIM_STATUS_LABEL["SHIPPING_PAID"], /Stage 4/);
  assertMatch(CLAIM_STATUS_LABEL["CUSTOMS_PAID"], /Stage 5/);
  assertMatch(CLAIM_STATUS_LABEL["PAID_IN_FULL"], /Stage 6/);
});

// kitNameFilter

Deno.test("kitNameFilter: empty string returns empty object (no filter)", () => {
  assertEquals(kitNameFilter(""), {});
});

Deno.test("kitNameFilter: whitespace-only returns empty object", () => {
  assertEquals(kitNameFilter("   "), {});
});

Deno.test("kitNameFilter: single word — no AND wrapper", () => {
  const result = kitNameFilter("unicorn") as Record<string, unknown>;
  assertEquals("AND" in result, false);
  assertEquals(JSON.stringify(result).includes("unicorn"), true);
  assertEquals(JSON.stringify(result).includes("contains"), true);
});

Deno.test("kitNameFilter: two words — AND wrapper with both conditions", () => {
  const result = kitNameFilter("HG unicorn") as Record<string, unknown>;
  assertEquals("AND" in result, true);
  const str = JSON.stringify(result);
  assertEquals(str.includes("HG"), true);
  assertEquals(str.includes("unicorn"), true);
});

Deno.test("kitNameFilter: extra whitespace is normalised", () => {
  assertEquals(
    JSON.stringify(kitNameFilter("HG unicorn")),
    JSON.stringify(kitNameFilter("HG  unicorn")),
  );
});

Deno.test("kitNameFilter: three words → three AND conditions", () => {
  const result = kitNameFilter("MG RX-78 ver.ka") as { AND: unknown[] };
  assertEquals(Array.isArray(result.AND), true);
  assertEquals(result.AND.length, 3);
});
