/**
 * @module api/routes/kits
 *
 * Kit catalogue endpoints.
 *
 * GET   /kits       — search (public)
 * GET   /kits/:id   — detail (public)
 * POST  /kits       — add kit (authenticated)
 * PATCH /kits/:id   — update kit (authenticated)
 */

import Elysia, { t } from "elysia";
import { requireAuth } from "../middleware/auth.ts";
import * as KitService from "../../services/kit.service.ts";

export const kitRoutes = new Elysia({ prefix: "/kits" })
  // ── Public reads ──────────────────────────────────────────────────────────
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
        q: t.Optional(t.String({ description: "Kit name search query (AND semantics)" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
      }),
      detail: {
        tags: ["Kits"],
        summary: "Search kits",
        description: "Searches the kit catalogue. All words in 'q' must appear in the kit name.",
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
        summary: "Get kit",
        description: "Returns a kit with its current wishlist count.",
      },
    },
  )

  // ── Authenticated writes ───────────────────────────────────────────────────
  .use(requireAuth)

  .post(
    "/",
    async ({ body, set }) => {
      try {
        const kit = await KitService.createKit({
          product_name: body.product_name,
          jpy_price: body.jpy_price,
          weight_grams: body.weight_grams ?? undefined,
          availability: body.availability,
          item_code: body.item_code ?? undefined,
          release_date: body.release_date ?? null,
          stock_status: body.stock_status ?? null,
        });
        set.status = 201;
        return kit;
      } catch (err: any) {
        const isDupe = err.message?.includes("Unique constraint");
        set.status = isDupe ? 409 : 400;
        return { error: isDupe ? "A kit with that item code already exists." : err.message };
      }
    },
    {
      body: t.Object({
        product_name: t.String(),
        jpy_price: t.Integer({ minimum: 0, description: "MSRP in JPY" }),
        weight_grams: t.Optional(t.Integer({ minimum: 1, description: "Kit weight in grams" })),
        availability: t.String({ description: "Source / availability e.g. HLJ" }),
        item_code: t.Optional(t.String({ description: "Supplier item code. Defaults to product_name." })),
        release_date: t.Optional(t.Nullable(t.String())),
        stock_status: t.Optional(t.Nullable(t.String())),
      }),
      detail: {
        tags: ["Kits"],
        summary: "Add kit",
        description: "Adds a new kit to the catalogue. Any authenticated user can add kits.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  .patch(
    "/:id",
    async ({ params, body, set }) => {
      const updated = await KitService.updateKit(params.id, {
        product_name: body.product_name ?? undefined,
        jpy_price: body.jpy_price ?? undefined,
        weight_grams: body.weight_grams ?? undefined,
        availability: body.availability ?? undefined,
        release_date: body.release_date ?? undefined,
        stock_status: body.stock_status ?? undefined,
      });
      if (!updated) {
        set.status = 404;
        return { error: "Kit not found." };
      }
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        product_name: t.Optional(t.String()),
        jpy_price: t.Optional(t.Integer({ minimum: 0 })),
        weight_grams: t.Optional(t.Integer({ minimum: 1 })),
        availability: t.Optional(t.String()),
        release_date: t.Optional(t.Nullable(t.String())),
        stock_status: t.Optional(t.Nullable(t.String())),
      }),
      detail: {
        tags: ["Kits"],
        summary: "Update kit",
        description: "Updates mutable fields on a kit. Only provided fields are changed.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
