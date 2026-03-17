/**
 * @module api
 *
 * Elysia HTTP API server for Haro.
 *
 * Routes:
 *   /auth           — Discord OAuth2 login, logout, session info
 *   /kits           — Kit catalogue (public reads, authenticated writes)
 *   /wishlist       — Personal wishlist (authenticated)
 *   /groupbuys      — Group buy lifecycle (authenticated)
 *   /groupbuys/*/kits    — Kit slot management (organiser)
 *   /groupbuys/*/claims  — Claim lifecycle and payment tracking (members + organiser)
 */

import { swagger } from "@elysiajs/swagger";
import Elysia from "elysia";
import { env } from "../lib/env.ts";
import { authRoutes } from "./routes/auth.ts";
import { kitRoutes } from "./routes/kits.ts";
import { wishlistRoutes } from "./routes/wishlist.ts";
import { groupBuyRoutes } from "./routes/groupbuys.ts";
import { slotRoutes } from "./routes/slots.ts";
import { claimRoutes } from "./routes/claims.ts";

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
              "All monetary values are in JPY unless stated otherwise.",
          },
          tags: [
            { name: "Auth", description: "Discord OAuth2 session management" },
            { name: "Kits", description: "Kit catalogue — search, add, update" },
            { name: "Wishlist", description: "Personal wishlist management" },
            { name: "GroupBuys", description: "Group buy lifecycle and financials" },
            { name: "Claims", description: "Claim management and payment tracking" },
          ],
          components: {
            securitySchemes: {
              sessionCookie: {
                type: "apiKey",
                in: "cookie",
                name: "haro_session",
                description: "JWT session cookie issued after Discord OAuth2 login",
              },
            },
          },
        },
        scalarConfig: { theme: "purple", layout: "modern" },
        path: "/docs",
      }),
    )

    .get("/", () => ({ name: "Haro API", version: "1.0.0", docs: "/docs", health: "/health" }), {
      detail: { tags: ["Auth"], summary: "API root" },
    })
    .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }), {
      detail: { tags: ["Auth"], summary: "Health check" },
    })

    .use(authRoutes)
    .use(kitRoutes)
    .use(wishlistRoutes)
    .use(groupBuyRoutes)
    .use(slotRoutes)
    .use(claimRoutes)

    .onError(({ error, set }) => {
      const message = error instanceof Error ? error.message : "Internal server error.";
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
        console.log(`[api] Docs at http://${hostname}:${port}/docs`);
      },
      onError: (error) => {
        console.error("[api] Server error:", error);
        return new Response("Internal Server Error", { status: 500 });
      },
    },
    app.fetch,
  );
}
