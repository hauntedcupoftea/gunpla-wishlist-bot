/**
 * @module api/routes/wishlist
 *
 * Personal wishlist management. All routes require authentication.
 *
 * GET    /wishlist          — list your wishlist
 * POST   /wishlist          — add a kit to your wishlist
 * DELETE /wishlist/:kitId   — remove a kit from your wishlist
 */

import { Elysia, t } from "elysia";
import { requireAuth } from "../middleware/auth.ts";
import * as KitService from "../../services/kit.service.ts";

export const wishlistRoutes = new Elysia({ prefix: "/wishlist" })
  .use(requireAuth)
  .get(
    "/",
    async ({ session }) => {
      const wishlist = await KitService.getUserWishlist(session.userId);
      return { results: wishlist, total: wishlist.length };
    },
    {
      detail: {
        tags: ["Wishlist"],
        summary: "Get your wishlist",
        description: "Returns all kits on the authenticated user's wishlist.",
        security: [{ sessionCookie: [] }],
      },
    },
  )
  .post(
    "/",
    async ({ session, body, set }) => {
      const kit = await KitService.getKitById(body.kitId);
      if (!kit) {
        set.status = 404;
        return { error: "Kit not found." };
      }

      try {
        const entry = await KitService.addToWishlist(
          session.userId,
          body.kitId,
          body.note,
        );
        set.status = 201;
        return entry;
      } catch {
        set.status = 409;
        return { error: "That kit is already on your wishlist." };
      }
    },
    {
      body: t.Object({
        kitId: t.String(),
        note: t.Optional(t.String()),
      }),
      detail: {
        tags: ["Wishlist"],
        summary: "Add kit to wishlist",
        description: "Adds a kit to the authenticated user's wishlist.",
        security: [{ sessionCookie: [] }],
      },
    },
  )
  .delete(
    "/:kitId",
    async ({ session, params, set }) => {
      const removed = await KitService.removeFromWishlist(
        session.userId,
        params.kitId,
      );
      if (!removed) {
        set.status = 404;
        return { error: "That kit is not on your wishlist." };
      }
      set.status = 204;
      return;
    },
    {
      params: t.Object({ kitId: t.String() }),
      detail: {
        tags: ["Wishlist"],
        summary: "Remove kit from wishlist",
        description: "Removes a kit from the authenticated user's wishlist.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
