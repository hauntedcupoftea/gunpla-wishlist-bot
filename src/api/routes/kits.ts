/**
 * @module api/routes/kits
 *
 * Kit catalogue endpoints.
 *
 * GET /kits        — search kits by name (no auth required — catalogue is public)
 * GET /kits/:id    — kit detail with wishlist count
 */

import { Elysia, t } from "elysia";
import * as KitService from "../../services/kit.service.ts";

export const kitRoutes = new Elysia({ prefix: "/kits" })
  .get(
    "/",
    async ({ query, set }) => {
      const { q, limit } = query;
      if (!q?.trim()) {
        set.status = 400;
        return { error: "Query parameter 'q' is required." };
      }
      const kits = await KitService.searchKits(q, limit ?? 20);
      return { results: kits, total: kits.length };
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      }),
      detail: {
        tags: ["Kits"],
        summary: "Search kits",
        description:
          "Full-text search across the kit catalogue. All whitespace-separated " +
          "words in 'q' must appear in the kit name (AND semantics).",
      },
    },
  )
  .get(
    "/:id",
    async ({ params, set }) => {
      const kit = await KitService.getKitById(params.id);
      if (!kit) {
        set.status = 404;
        return { error: "Kit not found." };
      }
      return kit;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Kits"],
        summary: "Get kit by ID",
        description: "Returns a single kit with its current wishlist count.",
      },
    },
  );
