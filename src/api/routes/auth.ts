/**
 * @module api/routes/auth
 *
 * Discord OAuth2 authentication routes.
 *
 * Flow:
 *   GET /auth/discord         → redirect to Discord consent page
 *   GET /auth/discord/callback → exchange code, verify guild membership,
 *                                issue JWT session cookie, redirect to /
 *   POST /auth/logout          → clear session cookie
 *   GET /auth/me               → return current session info (authenticated)
 *
 * Guild check: if GUILD_ID is set in env, the user must be a member of that
 * guild. If not, they get a 403 and no session is issued.
 */

import Elysia, { t } from "elysia";
import { env } from "../../lib/env.ts";
import { COOKIE_NAME, requireAuth, signSession } from "../middleware/auth.ts";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.API_BASE_URL?.startsWith("https") ?? false,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
};

export const authRoutes = new Elysia({ prefix: "/auth" })
  // ── GET /auth/discord ──────────────────────────────────────────────────────
  .get(
    "/discord",
    ({ redirect }) => {
      const params = new URLSearchParams({
        client_id: env.APPLICATION_ID,
        redirect_uri: `${env.API_BASE_URL}/auth/discord/callback`,
        response_type: "code",
        scope: "identify guilds.members.read",
      });
      return redirect(`https://discord.com/oauth2/authorize?${params}`);
    },
    {
      detail: {
        tags: ["Auth"],
        summary: "Start Discord OAuth2 login",
        description:
          "Redirects the user to Discord's consent page. " +
          "After authorising, Discord sends them to /auth/discord/callback.",
      },
    },
  )

  // ── GET /auth/discord/callback ─────────────────────────────────────────────
  .get(
    "/discord/callback",
    async ({ query, cookie, set, redirect }) => {
      const { code } = query;
      if (!code) {
        set.status = 400;
        return { error: "Missing OAuth2 code." };
      }

      // 1. Exchange code for Discord access token
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.APPLICATION_ID,
          client_secret: env.DISCORD_CLIENT_SECRET!,
          grant_type: "authorization_code",
          code,
          redirect_uri: `${env.API_BASE_URL}/auth/discord/callback`,
        }),
      });

      if (!tokenRes.ok) {
        set.status = 401;
        return { error: "Failed to exchange OAuth2 code." };
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
      };

      // 2. Fetch Discord user profile
      const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) {
        set.status = 401;
        return { error: "Failed to fetch Discord user." };
      }

      const user = (await userRes.json()) as {
        id: string;
        username: string;
        global_name: string | null;
      };

      // 3. Guild membership check (if GUILD_ID is configured)
      if (env.GUILD_ID) {
        const memberRes = await fetch(
          `https://discord.com/api/users/@me/guilds/${env.GUILD_ID}/member`,
          { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
        );

        if (!memberRes.ok) {
          set.status = 403;
          return {
            error: "You must be a member of the server to use this API.",
          };
        }
      }

      // 4. Issue JWT session cookie
      const token = await signSession({
        userId: user.id,
        username: user.global_name ?? user.username,
      });

      cookie[COOKIE_NAME].set({
        value: token,
        ...COOKIE_OPTIONS,
      });

      set.status = 200;
      return {
        message: "Authenticated successfully.",
        userId: user.id,
        username: user.global_name ?? user.username,
      };
    },
    {
      query: t.Object({ code: t.Optional(t.String()) }),
      detail: {
        tags: ["Auth"],
        summary: "Discord OAuth2 callback",
        description:
          "Exchanges the authorisation code for a Discord access token, " +
          "verifies guild membership if GUILD_ID is set, and issues a " +
          "signed HttpOnly JWT session cookie valid for 7 days.",
      },
    },
  )

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  .post(
    "/logout",
    ({ cookie, set }) => {
      cookie[COOKIE_NAME].set({
        value: "",
        maxAge: 0,
        path: "/",
      });
      set.status = 200;
      return { message: "Logged out." };
    },
    {
      detail: {
        tags: ["Auth"],
        summary: "Log out",
        description: "Clears the session cookie.",
      },
    },
  )

  // ── GET /auth/me ───────────────────────────────────────────────────────────
  .use(requireAuth)
  .get(
    "/me",
    ({ session }) => ({
      userId: session.userId,
      username: session.username,
    }),
    {
      detail: {
        tags: ["Auth"],
        summary: "Get current user",
        description: "Returns the authenticated user's Discord ID and username.",
        security: [{ sessionCookie: [] }],
      },
    },
  );
