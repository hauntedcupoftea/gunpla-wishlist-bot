/**
 * @module api/routes/groupbuys
 *
 * Group buy endpoints — reads and writes. All routes require authentication.
 *
 * ## Reads
 * GET  /groupbuys                         — search (by user or by kit)
 * GET  /groupbuys/:threadId               — full detail
 * GET  /groupbuys/:threadId/summary       — payment summary
 *
 * ## Writes
 * POST   /groupbuys                       — create a group buy
 * PATCH  /groupbuys/:threadId/status      — update status
 * PATCH  /groupbuys/:threadId/financials  — set costPrice, shipping etc.
 * PATCH  /groupbuys/:threadId/tracking    — set tracking numbers/URLs
 * PATCH  /groupbuys/:threadId/buyer       — set buyer
 * PATCH  /groupbuys/:threadId/receiver    — set receiver
 * PATCH  /groupbuys/:threadId/owner       — transfer ownership
 *
 * ## Permission model
 * - Any authenticated guild member can read.
 * - Create: any authenticated guild member.
 * - Organiser-only mutations: status, addkit, removekit, transfer ownership.
 * - Organiser OR buyer: financials, tracking, buyer, receiver.
 * - Guild admin can perform any organiser action (checked live via Discord API).
 */

import Elysia, { t } from "elysia";
import type { GroupBuyStatus } from "../../../generated/enums.ts";
import { isGuildAdmin, requireAuth } from "../middleware/auth.ts";
import * as GbService from "../../services/groupbuy.service.ts";
import * as SearchService from "../../services/search.service.ts";

// ─── Permission helpers ───────────────────────────────────────────────────────

async function checkOwner(
  gb: { ownerId: string },
  userId: string,
): Promise<{ allowed: boolean; adminOverride: boolean }> {
  if (gb.ownerId === userId) return { allowed: true, adminOverride: false };
  const admin = await isGuildAdmin(userId);
  return { allowed: admin, adminOverride: admin };
}

async function checkOwnerOrBuyer(
  gb: { ownerId: string; buyerId: string | null },
  userId: string,
): Promise<{ allowed: boolean; adminOverride: boolean }> {
  if (gb.ownerId === userId || gb.buyerId === userId) {
    return { allowed: true, adminOverride: false };
  }
  const admin = await isGuildAdmin(userId);
  return { allowed: admin, adminOverride: admin };
}

// ─── Route helpers ────────────────────────────────────────────────────────────

const STATUS_VALUES = [
  "OPEN", "CLAIMED", "LOCKED", "PURCHASED",
  "AT_WAREHOUSE", "SHIPPED", "AT_CUSTOMS", "CLEARED_CUSTOMS",
  "AT_RECEIVER", "COMPLETED", "CANCELLED",
] as const;

// ─── Routes ───────────────────────────────────────────────────────────────────

export const groupBuyRoutes = new Elysia({ prefix: "/groupbuys" })
  .use(requireAuth)

  // ── GET /groupbuys ─────────────────────────────────────────────────────────
  .get(
    "/",
    async ({ session, query, set }) => {
      const { q, guildId, statuses, mode = "user", limit = 20, offset = 0 } = query;

      const parsedStatuses = statuses
        ? (statuses.split(",").filter(Boolean) as GroupBuyStatus[])
        : undefined;

      if (mode === "kit") {
        if (!q?.trim()) {
          set.status = 400;
          return { error: "Query parameter 'q' is required when mode=kit." };
        }
        const { results, total } = await SearchService.searchGroupBuysByKitWithCount({
          query: q,
          guildId,
          statuses: parsedStatuses,
          userId: session.userId,
          limit,
          offset,
        });
        return { results, total, limit, offset };
      }

      const { results, total } = await SearchService.searchGroupBuysByUserWithCount({
        userId: session.userId,
        guildId,
        statuses: parsedStatuses,
        limit,
        offset,
      });
      return { results, total, limit, offset };
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        guildId: t.Optional(t.String()),
        statuses: t.Optional(t.String({ description: "Comma-separated GroupBuyStatus values" })),
        mode: t.Optional(t.Union([t.Literal("user"), t.Literal("kit")], { default: "user" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
        offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Search group buys",
        description:
          "Search in two modes:\n\n" +
          "- **user** (default): GBs you're involved in as organiser, buyer, receiver, or claimant.\n" +
          "- **kit**: GBs containing a kit matching the query `q`.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── POST /groupbuys ────────────────────────────────────────────────────────
  .post(
    "/",
    async ({ session, body, set }) => {
      const existing = await GbService.getGroupBuyByThread(body.threadId);
      if (existing) {
        set.status = 409;
        return { error: "A group buy already exists for this thread." };
      }
      const gb = await GbService.createGroupBuy({
        threadId: body.threadId,
        guildId: body.guildId,
        ownerId: session.userId,
      });
      set.status = 201;
      return gb;
    },
    {
      body: t.Object({
        threadId: t.String({ description: "Discord forum thread snowflake ID" }),
        guildId: t.String({ description: "Discord guild snowflake ID" }),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Create group buy",
        description: "Creates a new group buy anchored to a Discord forum thread. The caller becomes the organiser.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── GET /groupbuys/:threadId ───────────────────────────────────────────────
  .get(
    "/:threadId",
    async ({ params, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) {
        set.status = 404;
        return { error: "Group buy not found." };
      }
      return gb;
    },
    {
      params: t.Object({ threadId: t.String() }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Get group buy",
        description: "Returns a fully populated group buy including all kits and claims.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── GET /groupbuys/:threadId/summary ──────────────────────────────────────
  .get(
    "/:threadId/summary",
    async ({ params, query, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) {
        set.status = 404;
        return { error: "Group buy not found." };
      }
      const rate = query.rate ? Number(query.rate) : undefined;
      const summary = await GbService.getGroupBuySummary(gb.id, rate);
      return { results: summary, total: summary.length };
    },
    {
      params: t.Object({ threadId: t.String() }),
      query: t.Object({
        rate: t.Optional(t.Numeric({ description: "JPY→INR rate override" })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Get payment summary",
        description: "Full cost breakdown for every active claim, sorted by payment progress.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/status ─────────────────────────────────────
  .patch(
    "/:threadId/status",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      // LOCKED status can only be set/unset by a guild admin
      const isLockOp = body.status === "LOCKED" || gb.status === "LOCKED";
      if (isLockOp && !await isGuildAdmin(session.userId)) {
        set.status = 403;
        return { error: "Only a guild administrator can lock or unlock a group buy." };
      }

      const { allowed } = await checkOwner(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser can change the status." }; }

      const updated = await GbService.setGroupBuyStatus(gb.id, body.status as GroupBuyStatus);
      return updated;
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({
        status: t.Union(STATUS_VALUES.map((s) => t.Literal(s)) as any),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Update status",
        description: "Updates the group buy lifecycle status. LOCKED requires guild admin.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/financials ─────────────────────────────────
  .patch(
    "/:threadId/financials",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const { allowed } = await checkOwnerOrBuyer(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser or buyer can update financials." }; }

      const updated = await GbService.updateFinancials(gb.id, {
        costPrice: body.costPrice,
        domesticShippingCost: body.domesticShippingCost,
        shippingCost: body.shippingCost,
        shippingWeight: body.shippingWeight,
        customsCost: body.customsCost,
        inrConversionRate: body.inrConversionRate,
      });
      return updated;
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({
        costPrice: t.Optional(t.Nullable(t.Integer({ description: "Total deal price in JPY" }))),
        domesticShippingCost: t.Optional(t.Nullable(t.Integer({ description: "Domestic shipping in JPY. Pass null to clear." }))),
        shippingCost: t.Optional(t.Nullable(t.Integer({ description: "International shipping in JPY" }))),
        shippingWeight: t.Optional(t.Nullable(t.Integer({ description: "Actual parcel weight in grams (for records only)" }))),
        customsCost: t.Optional(t.Nullable(t.Integer({ description: "Customs/import duties in JPY" }))),
        inrConversionRate: t.Optional(t.Nullable(t.Number({ description: "JPY→INR conversion rate e.g. 0.57" }))),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Update financials",
        description:
          "Updates one or more financial fields and immediately recalculates cost splits " +
          "across all active claims. Pass `null` to clear a field.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/tracking ───────────────────────────────────
  .patch(
    "/:threadId/tracking",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const { allowed } = await checkOwnerOrBuyer(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser or buyer can update tracking." }; }

      const updated = await GbService.updateTracking(gb.id, {
        shippingTrackingNumber: body.shippingTrackingNumber ?? undefined,
        shippingTrackingUrl: body.shippingTrackingUrl ?? undefined,
        customsTrackingUrl: body.customsTrackingUrl ?? undefined,
      });
      return updated;
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({
        shippingTrackingNumber: t.Optional(t.Nullable(t.String())),
        shippingTrackingUrl: t.Optional(t.Nullable(t.String())),
        customsTrackingUrl: t.Optional(t.Nullable(t.String())),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Update tracking",
        description: "Sets shipping and customs tracking numbers and URLs.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/buyer ──────────────────────────────────────
  .patch(
    "/:threadId/buyer",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const { allowed } = await checkOwner(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser can set the buyer." }; }

      return GbService.setGroupBuyBuyer(gb.id, body.userId);
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({ userId: t.String({ description: "Discord user ID of the new buyer" }) }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Set buyer",
        description: "Sets the payment aggregator for the group buy.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/receiver ───────────────────────────────────
  .patch(
    "/:threadId/receiver",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const { allowed } = await checkOwner(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser can set the receiver." }; }

      return GbService.setGroupBuyReceiver(gb.id, body.userId);
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({ userId: t.String({ description: "Discord user ID of the parcel receiver" }) }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Set receiver",
        description: "Sets the parcel receiver for the group buy.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/owner ──────────────────────────────────────
  .patch(
    "/:threadId/owner",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const { allowed } = await checkOwner(gb, session.userId);
      if (!allowed) { set.status = 403; return { error: "Only the organiser can transfer ownership." }; }

      return GbService.transferGroupBuyOwnership(gb.id, body.userId);
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({ userId: t.String({ description: "Discord user ID of the new organiser" }) }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Transfer ownership",
        description: "Transfers organiser ownership to another guild member.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
