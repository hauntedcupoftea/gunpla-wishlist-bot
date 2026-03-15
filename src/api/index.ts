/**
 * @module api
 *
 * Elysia HTTP API server for Haro.
 *
 * Routes:
 *   /auth       — Discord OAuth2 login, logout, session info
 *   /kits       — Kit catalogue search (public)
 *   /wishlist   — Personal wishlist (authenticated)
 *   /groupbuys  — Group buy search, detail, summary, claims (authenticated)
 */

import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "../lib/env.ts";
import { authRoutes } from "./routes/auth.ts";
import { kitRoutes } from "./routes/kits.ts";
import { wishlistRoutes } from "./routes/wishlist.ts";
import { groupBuyRoutes } from "./routes/groupbuys.ts";

export function buildApp() {
  return new Elysia()
    .use(
      swagger({
        documentation: {
          info: {
            title: "Haro API",
            version: "1.0.0",
            description:
              "REST API for the Haro Gunpla group-buy Discord bot. " +
              "Authenticate via Discord OAuth2 at /auth/discord. " +
              "All monetary values are in JPY unless stated otherwise. " +
              "INR equivalents are computed from GroupBuy.inrConversionRate.",
          },
          tags: [
            { name: "Auth", description: "Discord OAuth2 session management" },
            { name: "Kits", description: "Kit catalogue — search and detail" },
            { name: "Wishlist", description: "Personal wishlist management" },
            {
              name: "GroupBuys",
              description: "Group buy search, detail, and payment summaries",
            },
            {
              name: "Claims",
              description: "Claim management and payment tracking",
            },
          ],
          components: {
            securitySchemes: {
              sessionCookie: {
                type: "apiKey",
                in: "cookie",
                name: "haro_session",
                description:
                  "JWT session cookie issued after Discord OAuth2 login",
              },
            },
          },
        },
        scalarConfig: { theme: "purple", layout: "modern" },
        path: "/docs",
      }),
    )
    // ── Unauthenticated ──────────────────────────────────────────────────────

    .get(
      "/",
      () => ({
        name: "Haro API",
        version: "1.0.0",
        docs: "/docs",
        health: "/health",
      }),
      {
        detail: {
          tags: ["Auth"],
          summary: "API root",
          description: "Returns API metadata and links.",
        },
      },
    )
    .get(
      "/health",
      () => ({ status: "ok", timestamp: new Date().toISOString() }),
      {
        detail: {
          tags: ["Auth"],
          summary: "Health check",
          description: "Returns 200 if the API server is running.",
        },
      },
    )
    // ── Routes ───────────────────────────────────────────────────────────────

    .use(authRoutes)
    .use(kitRoutes)
    .use(wishlistRoutes)
    .use(groupBuyRoutes)
    // ── Error handler ────────────────────────────────────────────────────────

    .onError(({ error, set }) => {
      const message = error instanceof Error
        ? error.message
        : "Internal server error.";
      if (!set.status || set.status === 200) set.status = 500;
      return { error: message };
    });
}

export function startApi(): Deno.HttpServer {
  const app = buildApp();

  return Deno.serve(
    {
      port: env.API_PORT,
      hostname: "0.0.0.0",
      onListen: ({ port, hostname }) => {
        console.log(`[api] Listening on http://${hostname}:${port}`);
        console.log(`[api] Docs available at http://${hostname}:${port}/docs`);
      },
      onError: (error) => {
        console.error("[api] Server error:", error);
        return new Response("Internal Server Error", { status: 500 });
      },
    },
    app.fetch,
  );
}
