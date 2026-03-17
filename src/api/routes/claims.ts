/**
 * @module api/routes/claims
 *
 * Claim lifecycle and payment tracking.
 *
 * GET    /groupbuys/:threadId/claims                              — your claims in this GB
 * POST   /groupbuys/:threadId/claims                             — claim a kit
 * DELETE /groupbuys/:threadId/claims/:claimId                    — cancel a claim
 * PATCH  /groupbuys/:threadId/claims/:claimId/confirm            — confirm a claim (organiser)
 * POST   /groupbuys/:threadId/claims/confirm-uncontested         — bulk confirm uncontested (organiser)
 * PATCH  /groupbuys/:threadId/claims/:claimId/resolve            — resolve contested slot (organiser)
 * PATCH  /groupbuys/:threadId/claims/:claimId/transfer           — transfer claim to another user (organiser)
 *
 * ## Payment events
 * POST   /groupbuys/:threadId/claims/:claimId/payments           — report payment (member)
 * PATCH  /groupbuys/:threadId/claims/:claimId/payments/:stage/confirm — confirm payment (organiser/buyer)
 * PATCH  /groupbuys/:threadId/claims/:claimId/payments/:stage/reject  — reject payment (organiser/buyer)
 */

import Elysia, { t } from "elysia";
import type { PaymentStage } from "../../../generated/enums.ts";
import { isGuildAdmin, requireAuth } from "../middleware/auth.ts";
import * as GbService from "../../services/groupbuy.service.ts";
import { prisma } from "../../lib/prisma.ts";

const PAYMENT_STAGES = ["KIT", "DOMESTIC_SHIPPING", "SHIPPING", "CUSTOMS"] as const;

export const claimRoutes = new Elysia({ prefix: "/groupbuys" })
  .use(requireAuth)

  // ── GET /groupbuys/:threadId/claims ───────────────────────────────────────
  .get(
    "/:threadId/claims",
    async ({ params, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const claims = await GbService.getUserClaimsInGroupBuy(gb.id, session.userId);
      return { results: claims, total: claims.length };
    },
    {
      params: t.Object({ threadId: t.String() }),
      detail: {
        tags: ["Claims"],
        summary: "Get your claims",
        description: "Returns the authenticated user's active claims in this group buy, with cost breakdowns and payment history.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── POST /groupbuys/:threadId/claims ──────────────────────────────────────
  .post(
    "/:threadId/claims",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      if (gb.status !== "OPEN") {
        set.status = 409;
        return { error: `This group buy is ${gb.status} and is not accepting new claims.` };
      }

      try {
        const claim = await GbService.claimKit(gb.id, body.kitId, session.userId);
        set.status = 201;
        return claim;
      } catch (err: any) {
        set.status = 409;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({
        kitId: t.String({ description: "Kit UUID to claim a slot for" }),
      }),
      detail: {
        tags: ["Claims"],
        summary: "Claim a kit",
        description:
          "Claims the best available slot for a kit in this group buy. " +
          "'Best' = fewest active claims, tie-broken by slot number.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── DELETE /groupbuys/:threadId/claims/:claimId ───────────────────────────
  .delete(
    "/:threadId/claims/:claimId",
    async ({ params, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const claim = await prisma.groupBuyClaim.findUnique({
        where: { id: params.claimId },
      });
      if (!claim) { set.status = 404; return { error: "Claim not found." }; }

      // Member can cancel their own claim; organiser or admin can cancel any
      const isOwner = gb.ownerId === session.userId;
      const isClaimer = claim.userId === session.userId;
      const admin = (!isOwner && !isClaimer) ? await isGuildAdmin(session.userId) : false;

      if (!isOwner && !isClaimer && !admin) {
        set.status = 403;
        return { error: "You can only cancel your own claims." };
      }

      const cancelled = await GbService.cancelClaim(params.claimId);
      return cancelled;
    },
    {
      params: t.Object({ threadId: t.String(), claimId: t.String() }),
      detail: {
        tags: ["Claims"],
        summary: "Cancel a claim",
        description: "Cancels a claim. Members can cancel their own; organisers and admins can cancel any.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/claims/:claimId/confirm ────────────────────
  .patch(
    "/:threadId/claims/:claimId/confirm",
    async ({ params, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can confirm claims." };
      }

      const confirmed = await GbService.confirmClaim(params.claimId);
      return confirmed;
    },
    {
      params: t.Object({ threadId: t.String(), claimId: t.String() }),
      detail: {
        tags: ["Claims"],
        summary: "Confirm a claim",
        description: "Advances a PENDING claim to CONFIRMED. Organiser only.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── POST /groupbuys/:threadId/claims/confirm-uncontested ──────────────────
  .post(
    "/:threadId/claims/confirm-uncontested",
    async ({ params, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can confirm claims." };
      }

      const count = await GbService.confirmUncontestedClaims(gb.id);
      return { confirmed: count };
    },
    {
      params: t.Object({ threadId: t.String() }),
      detail: {
        tags: ["Claims"],
        summary: "Confirm all uncontested claims",
        description: "Bulk-confirms all PENDING claims on slots with exactly one claimant. Organiser only.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/claims/:claimId/resolve ────────────────────
  .patch(
    "/:threadId/claims/:claimId/resolve",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can resolve contested slots." };
      }

      // claimId here is the winning claim; groupBuyKitId comes from the claim
      const claim = await prisma.groupBuyClaim.findUnique({
        where: { id: params.claimId },
      });
      if (!claim) { set.status = 404; return { error: "Claim not found." }; }

      await GbService.resolveContestedSlot(claim.groupBuyKitId, params.claimId);
      return { resolved: true, winnerId: params.claimId };
    },
    {
      params: t.Object({ threadId: t.String(), claimId: t.String() }),
      body: t.Object({}), // empty body — winner is identified by the claimId param
      detail: {
        tags: ["Claims"],
        summary: "Resolve contested slot",
        description:
          "Confirms the specified claim as the winner for its slot and cancels all other claims on that slot. Organiser only.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/claims/:claimId/transfer ───────────────────
  .patch(
    "/:threadId/claims/:claimId/transfer",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwner = gb.ownerId === session.userId;
      const admin = isOwner ? false : await isGuildAdmin(session.userId);
      if (!isOwner && !admin) {
        set.status = 403;
        return { error: "Only the organiser can transfer claims." };
      }

      try {
        const claim = await GbService.transferClaim(params.claimId, body.userId);
        return claim;
      } catch (err: any) {
        set.status = 409;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ threadId: t.String(), claimId: t.String() }),
      body: t.Object({
        userId: t.String({ description: "Discord user ID of the new claimant" }),
      }),
      detail: {
        tags: ["Claims"],
        summary: "Transfer claim",
        description: "Transfers a claim to another user. Target must not already have an active claim for the same kit. Organiser only.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── POST /groupbuys/:threadId/claims/:claimId/payments ────────────────────
  .post(
    "/:threadId/claims/:claimId/payments",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const claim = await prisma.groupBuyClaim.findUnique({
        where: { id: params.claimId },
      });
      if (!claim) { set.status = 404; return { error: "Claim not found." }; }
      if (claim.userId !== session.userId) {
        set.status = 403;
        return { error: "You can only report payments for your own claims." };
      }

      try {
        const event = await GbService.reportPayment(
          params.claimId,
          session.userId,
          body.stage as PaymentStage,
          body.note ?? undefined,
        );
        set.status = 201;
        return event;
      } catch (err: any) {
        set.status = 409;
        return { error: err.message };
      }
    },
    {
      params: t.Object({ threadId: t.String(), claimId: t.String() }),
      body: t.Object({
        stage: t.Union(PAYMENT_STAGES.map((s) => t.Literal(s)) as any),
        note: t.Optional(t.String({ description: "Optional note e.g. UTR number or screenshot link" })),
      }),
      detail: {
        tags: ["Claims"],
        summary: "Report payment",
        description: "Records that the authenticated member has made a payment for a stage. The organiser must confirm separately.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/claims/:claimId/payments/:stage/confirm ────
  .patch(
    "/:threadId/claims/:claimId/payments/:stage/confirm",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwnerOrBuyer =
        gb.ownerId === session.userId || gb.buyerId === session.userId;
      const admin = isOwnerOrBuyer ? false : await isGuildAdmin(session.userId);
      if (!isOwnerOrBuyer && !admin) {
        set.status = 403;
        return { error: "Only the organiser or buyer can confirm payments." };
      }

      try {
        const { claim, event } = await GbService.confirmPaymentStage(
          params.claimId,
          session.userId,
          params.stage as PaymentStage,
          body.note ?? undefined,
        );

        // Auto-advance to PAID_IN_FULL after the last applicable stage
        const isLastStage =
          params.stage === "CUSTOMS" ||
          (params.stage === "SHIPPING" && gb.customsCost == null);
        if (isLastStage) {
          await GbService.markPaidInFull(params.claimId);
        }

        return { claim, event };
      } catch (err: any) {
        set.status = 409;
        return { error: err.message };
      }
    },
    {
      params: t.Object({
        threadId: t.String(),
        claimId: t.String(),
        stage: t.Union(PAYMENT_STAGES.map((s) => t.Literal(s)) as any),
      }),
      body: t.Object({
        note: t.Optional(t.String()),
      }),
      detail: {
        tags: ["Claims"],
        summary: "Confirm payment",
        description:
          "Confirms a member's reported payment for a stage and advances the claim status. " +
          "Auto-advances to PAID_IN_FULL after the final applicable stage. Organiser/buyer only.",
        security: [{ sessionCookie: [] }],
      },
    },
  )

  // ── PATCH /groupbuys/:threadId/claims/:claimId/payments/:stage/reject ─────
  .patch(
    "/:threadId/claims/:claimId/payments/:stage/reject",
    async ({ params, body, session, set }) => {
      const gb = await GbService.getGroupBuyByThread(params.threadId);
      if (!gb) { set.status = 404; return { error: "Group buy not found." }; }

      const isOwnerOrBuyer =
        gb.ownerId === session.userId || gb.buyerId === session.userId;
      const admin = isOwnerOrBuyer ? false : await isGuildAdmin(session.userId);
      if (!isOwnerOrBuyer && !admin) {
        set.status = 403;
        return { error: "Only the organiser or buyer can reject payments." };
      }

      const event = await GbService.rejectPaymentReport(
        params.claimId,
        session.userId,
        params.stage as PaymentStage,
        body.note ?? undefined,
      );
      return event;
    },
    {
      params: t.Object({
        threadId: t.String(),
        claimId: t.String(),
        stage: t.Union(PAYMENT_STAGES.map((s) => t.Literal(s)) as any),
      }),
      body: t.Object({
        note: t.Optional(t.String({ description: "Reason for rejection" })),
      }),
      detail: {
        tags: ["Claims"],
        summary: "Reject payment",
        description: "Rejects a member's payment report. Claim status is unchanged — the member must re-report. Organiser/buyer only.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
