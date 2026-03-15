/**
 * @module api/routes/groupbuys
 *
 * Group buy discovery and read endpoints. All routes require authentication.
 *
 * GET /groupbuys                        — search GBs (by kit name or by user)
 * GET /groupbuys/:threadId              — full GB detail
 * GET /groupbuys/:threadId/summary      — payment summary for all claims
 * GET /groupbuys/:threadId/claims       — the authenticated user's claims in a GB
 */

import { Elysia, t } from "elysia";
import type { GroupBuyStatus } from "../../../generated/enums.ts";
import { requireAuth } from "../middleware/auth.ts";
import * as GbService from "../../services/groupbuy.service.ts";
import * as SearchService from "../../services/search.service.ts";

export const groupBuyRoutes = new Elysia({ prefix: "/groupbuys" })
  .use(requireAuth)
  // GET /groupbuys
  .get(
    "/",
    async ({ session, query, set }) => {
      const {
        q,
        guildId,
        statuses,
        mode = "user",
        limit = 20,
        offset = 0,
      } = query;

      // Parse statuses from comma-separated string if provided
      const parsedStatuses = statuses
        ? (statuses.split(",").filter(Boolean) as GroupBuyStatus[])
        : undefined;

      if (mode === "kit") {
        if (!q?.trim()) {
          set.status = 400;
          return { error: "Query parameter 'q' is required when mode=kit." };
        }
        const { results, total } = await SearchService
          .searchGroupBuysByKitWithCount({
            query: q,
            guildId,
            statuses: parsedStatuses,
            userId: session.userId,
            limit,
            offset,
          });
        return { results, total, limit, offset };
      }

      // mode === "user" (default)
      const { results, total } = await SearchService
        .searchGroupBuysByUserWithCount({
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
        q: t.Optional(
          t.String({
            description: "Kit name search query (required when mode=kit)",
          }),
        ),
        guildId: t.Optional(
          t.String({ description: "Filter to a specific guild" }),
        ),
        statuses: t.Optional(
          t.String({
            description: "Comma-separated list of GroupBuyStatus values",
          }),
        ),
        mode: t.Optional(t.Union([t.Literal("user"), t.Literal("kit")], {
          description:
            "'user' returns GBs you're involved in. 'kit' searches by kit name.",
          default: "user",
        })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
        offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Search group buys",
        description: "Search group buys in two modes:\n\n" +
          "- **user** (default): returns all GBs you're involved in as organiser, " +
          "buyer, receiver, or claimant.\n" +
          "- **kit**: searches GBs by kit name. Pass `q` with the kit name.",
        security: [{ sessionCookie: [] }],
      },
    },
  )
  // GET /groupbuys/:threadId
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
        summary: "Get group buy detail",
        description:
          "Returns a fully populated group buy including all kits and claims.",
        security: [{ sessionCookie: [] }],
      },
    },
  )
  // GET /groupbuys/:threadId/summary
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
        rate: t.Optional(t.Numeric({
          description:
            "JPY→INR conversion rate override. Defaults to the GB's stored rate.",
        })),
      }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Get payment summary",
        description:
          "Returns the full cost breakdown for every active claim in the group buy, " +
          "sorted by payment progress (least paid first). Mirrors the spreadsheet layout.",
        security: [{ sessionCookie: [] }],
      },
    },
  )
  // GET /groupbuys/:threadId/claims
  .get(
    "/:threadId/claims",
    async ({ params, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) {
        set.status = 404;
        return { error: "Group buy not found." };
      }

      const claims = await GbService.getUserClaimsInGroupBuy(
        gb.id,
        session.userId,
      );
      return { results: claims, total: claims.length };
    },
    {
      params: t.Object({ threadId: t.String() }),
      detail: {
        tags: ["GroupBuys"],
        summary: "Get your claims in a group buy",
        description:
          "Returns all active claims the authenticated user holds in this group buy, " +
          "including calculated cost breakdowns and full payment event history.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
