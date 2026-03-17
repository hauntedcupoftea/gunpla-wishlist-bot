/**
 * @module api/middleware/auth
 *
 * JWT session management + Discord role checking for the Haro REST API.
 *
 * ## Session flow
 * Sessions are issued as HttpOnly cookies after Discord OAuth2 login.
 * The JWT contains only userId + username — no role info, since roles are
 * checked live against Discord on every admin-gated request.
 *
 * ## Admin checking
 * isGuildAdmin() calls the Discord API using the bot token to fetch the
 * user's current guild roles, then checks for the Administrator permission.
 * Results are cached in-process for 60 seconds per userId so rapid requests
 * don't hammer Discord, but role changes propagate within a minute.
 *
 * ## Elysia plugins
 * - requireAuth  — verifies session cookie, injects `session` into context
 * - requireAdmin — extends requireAuth, additionally checks guild admin role
 */

import { SignJWT, jwtVerify } from "jose";
import Elysia from "elysia";
import { env } from "../../lib/env.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const COOKIE_NAME = "haro_session";
const JWT_EXPIRY = "7d";
const ADMIN_CACHE_TTL_MS = 60_000; // 60 seconds

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionPayload {
  userId: string;
  username: string;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function getSecret(): Uint8Array {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set.");
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  if (!payload.sub || typeof payload["username"] !== "string") {
    throw new Error("Invalid session payload.");
  }
  return { userId: payload.sub, username: payload["username"] as string };
}

// ─── Guild admin check ────────────────────────────────────────────────────────

// Discord permission bit for Administrator
const ADMINISTRATOR_BIT = 0x8n;

interface AdminCacheEntry {
  isAdmin: boolean;
  cachedAt: number;
}

const adminCache = new Map<string, AdminCacheEntry>();

/**
 * Checks whether a Discord user currently has the Administrator permission
 * in the configured guild. Uses the bot token so no user OAuth token is
 * needed after login.
 *
 * Results are cached in-process for 60 seconds to avoid hammering Discord
 * while still propagating role changes promptly.
 */
export async function isGuildAdmin(userId: string): Promise<boolean> {
  // Check cache first
  const cached = adminCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < ADMIN_CACHE_TTL_MS) {
    return cached.isAdmin;
  }

  const guildId = env.GUILD_ID;
  if (!guildId) {
    // No guild configured — nobody is an admin via this check
    return false;
  }

  try {
    // Fetch the member's current roles from Discord using the bot token
    const memberRes = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      {
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
      },
    );

    if (!memberRes.ok) {
      // User not in guild or API error — not an admin
      adminCache.set(userId, { isAdmin: false, cachedAt: Date.now() });
      return false;
    }

    const member = (await memberRes.json()) as { roles: string[] };

    // Fetch the guild's role list to find which roles have Administrator
    const rolesRes = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/roles`,
      {
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
      },
    );

    if (!rolesRes.ok) {
      adminCache.set(userId, { isAdmin: false, cachedAt: Date.now() });
      return false;
    }

    const roles = (await rolesRes.json()) as { id: string; permissions: string }[];

    // Check if any of the member's roles have the Administrator bit set
    const adminRoleIds = new Set(
      roles
        .filter((r) => (BigInt(r.permissions) & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT)
        .map((r) => r.id),
    );

    const isAdmin = member.roles.some((roleId) => adminRoleIds.has(roleId));

    adminCache.set(userId, { isAdmin, cachedAt: Date.now() });
    return isAdmin;
  } catch {
    // Network error etc — fail closed (not an admin)
    adminCache.set(userId, { isAdmin: false, cachedAt: Date.now() });
    return false;
  }
}

/**
 * Evicts a user from the admin cache. Call this if you want to force a
 * fresh role check on the next request (e.g. after a known role change).
 */
export function invalidateAdminCache(userId: string): void {
  adminCache.delete(userId);
}

// ─── Elysia plugins ───────────────────────────────────────────────────────────

/**
 * Verifies the session cookie and injects `session` into handler context.
 * Returns 401 if the cookie is missing or the JWT is invalid/expired.
 */
export const requireAuth = new Elysia({ name: "requireAuth" })
  .derive({ as: "scoped" }, async ({ cookie, set }) => {
    const token = cookie[COOKIE_NAME]?.value;
    if (!token) {
      set.status = 401;
      throw new Error("Not authenticated.");
    }
    try {
      const session = await verifySession(token);
      return { session };
    } catch {
      set.status = 401;
      throw new Error("Invalid or expired session.");
    }
  });

/**
 * Extends requireAuth — additionally checks that the authenticated user
 * currently has the Administrator permission in the configured guild.
 * Returns 403 if they don't.
 *
 * Admin status is checked live against Discord (cached 60s in-process).
 */
export const requireAdmin = new Elysia({ name: "requireAdmin" })
  .use(requireAuth)
  .derive({ as: "scoped" }, async ({ session, set }) => {
    const admin = await isGuildAdmin(session.userId);
    if (!admin) {
      set.status = 403;
      throw new Error("Administrator permission required.");
    }
  });

export { COOKIE_NAME };
