/**
 * @module api/routes/slots
 *
 * Kit slot management within a group buy.
 *
 * POST   /groupbuys/:threadId/kits           — add kit slots
 * DELETE /groupbuys/:threadId/kits/:kitId    — remove unclaimed slots
 *
 * Both are organiser-only (or guild admin override).
 */

import Elysia, { t } from "elysia";
import { isGuildAdmin, requireAuth } from "../middleware/auth.ts";
import * as GbService from "../../services/groupbuy.service.ts";

export const slotRoutes = new Elysia({ prefix: "/groupbuys" })
  .use(requireAuth)

  // ── POST /groupbuys/:threadId/kits ────────────────────────────────────────
  .post(
    "/:threadId/kits",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can add kits." };
      }

      try {
        const slots = await GbService.addKitToGroupBuy({
          groupBuyId: gb.id,
          kitId: body.kitId,
          weightGrams: body.weightGrams,
          quantity: body.quantity ?? 1,
        });
        set.status = 201;
        return { slots, count: slots.length };
      } catch (err: any) {
        set.status = 400;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({
        kitId: t.String({ description: "Kit UUID to add" }),
        weightGrams: t.Integer({ minimum: 1, description: "Per-unit weight in grams (used for shipping split)" }),
        quantity: t.Optional(t.Integer({ minimum: 1, maximum: 20, default: 1, description: "Number of slots to add" })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Add kit slots",
        description:
          "Adds one or more slots of a kit to the group buy. Slot numbers are " +
          "assigned sequentially. Updates totalWeight and recalculates claim costs.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── DELETE /groupbuys/:threadId/kits/:kitId ───────────────────────────────
  .delete(
    "/:threadId/kits/:kitId",
    async ({ params, query, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can remove kits." };
      }

      const quantity = query.quantity ? Number(query.quantity) : 1;

      try {
        const result = await GbService.removeKitFromGroupBuy(
          gb.id,
          params.kitId,
          quantity,
        );
        return result;
      } catch (err: any) {
        set.status = 400;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ threadId: t.String(), kitId: t.String() }),
      query: t.Object({
        quantity: t.Optional(t.Numeric({ minimum: 1, maximum: 20, default: 1, description: "Number of slots to remove" })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Remove kit slots",
        description:
          "Removes unclaimed slots for a kit (highest slot numbers first). " +
          "Throws if fewer unclaimed slots exist than requested.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
