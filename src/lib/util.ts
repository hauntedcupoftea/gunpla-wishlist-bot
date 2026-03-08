import { env } from "./env.ts";

// ─── Database helpers ─────────────────────────────────────────────────────────

/**
 * Returns a Prisma `contains` filter that is case-insensitive on PostgreSQL
 * and case-sensitive on SQLite (which lacks native insensitive mode).
 */
export function icontains(value: string): {
  contains: string;
  mode?: "insensitive";
} {
  return env.DB_PROVIDER === "sqlite"
    ? { contains: value }
    : { contains: value, mode: "insensitive" as const };
}

/**
 * Builds a Prisma `where` fragment that matches kits whose product_name
 * contains ALL whitespace-separated words in `query` (AND semantics).
 *
 * Example: "HG unicorn" → AND [ contains("HG"), contains("unicorn") ]
 */
export function kitNameFilter(query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return {};

  const conditions = words.map((word) =>
    env.DB_PROVIDER === "sqlite"
      ? { product_name: { contains: word } }
      : { product_name: { contains: word, mode: "insensitive" as const } },
  );

  return conditions.length === 1 ? conditions[0] : { AND: conditions };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Formats a JPY integer for display (e.g. 12500 → "¥12,500").
 */
export function fmtJpy(amount: number): string {
  return `¥${amount.toLocaleString("en-IN")}`;
}

/**
 * Formats an INR integer for display (e.g. 7125 → "₹7,125").
 */
export function fmtInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

/**
 * Converts a JPY amount to INR using the group buy's conversion rate.
 * Returns null if the rate is not set.
 */
export function toInr(
  jpyAmount: number,
  rate: number | null | undefined,
): number | null {
  if (!rate) return null;
  return Math.round(jpyAmount * rate);
}

/**
 * Formats a cost line showing JPY and, if a rate is available, INR too.
 *
 * Example: fmtCost(12500, 0.57) → "¥12,500 (₹7,125)"
 * Example: fmtCost(12500, null) → "¥12,500"
 */
export function fmtCost(
  jpyAmount: number,
  rate: number | null | undefined,
): string {
  const inr = toInr(jpyAmount, rate);
  return inr !== null ? `${fmtJpy(jpyAmount)} (${fmtInr(inr)})` : fmtJpy(jpyAmount);
}

/**
 * Human-readable label for each ClaimStatus, including its stage number.
 * Used in Discord embeds and API responses.
 */
export const CLAIM_STATUS_LABEL: Record<string, string> = {
  PENDING:       "⏳ Stage 0 — Pending confirmation",
  CONFIRMED:     "✅ Stage 1 — Confirmed",
  KIT_PAID:      "💴 Stage 2 — Kit payment confirmed",
  WAREHOUSE_PAID:"📦 Stage 3 — Warehouse fee confirmed",
  SHIPPING_PAID: "🚢 Stage 4 — Shipping confirmed",
  CUSTOMS_PAID:  "🛃 Stage 5 — Customs confirmed",
  PAID_IN_FULL:  "🎉 Stage 6 — Paid in full",
  CANCELLED:     "❌ Cancelled",
};

/**
 * Returns the next expected ClaimStatus after the given one, accounting
 * for whether a warehouse fee exists on this group buy.
 * Returns null if the status is terminal (PAID_IN_FULL or CANCELLED).
 */
export function nextClaimStatus(
  current: string,
  hasWarehouseCost: boolean,
): string | null {
  const flow: string[] = [
    "PENDING",
    "CONFIRMED",
    "KIT_PAID",
    ...(hasWarehouseCost ? ["WAREHOUSE_PAID"] : []),
    "SHIPPING_PAID",
    "CUSTOMS_PAID",
    "PAID_IN_FULL",
  ];
  const idx = flow.indexOf(current);
  if (idx === -1 || idx === flow.length - 1) return null;
  return flow[idx + 1];
}

/**
 * Appends an admin-override notice to a message string when applicable.
 * Keeps command response logic DRY.
 */
export function withOverrideNote(content: string, adminOverride: boolean): string {
  return adminOverride ? `${content}\n-# ⚠️ Admin override used.` : content;
}
