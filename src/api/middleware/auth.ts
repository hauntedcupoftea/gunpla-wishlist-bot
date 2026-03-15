/**
 * @module api/middleware/auth
 *
 * JWT session management for the Haro REST API.
 *
 * Sessions are issued as HttpOnly cookies after Discord OAuth2 login.
 * All authenticated routes use the `requireAuth` Elysia plugin which
 * reads and verifies the cookie, then injects `userId` and `username`
 * into the handler context.
 *
 * JWT payload:
 *   { sub: userId, username, iat, exp }
 *
 * Cookie name: haro_session
 * Expiry: 7 days
 */

import { SignJWT, jwtVerify } from "jose";
import Elysia from "elysia";
import { env } from "../../lib/env.ts";

const COOKIE_NAME = "haro_session";
const EXPIRY = "7d";

export interface SessionPayload {
  userId: string;
  username: string;
}

function getSecret(): Uint8Array {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set.");
  return new TextEncoder().encode(secret);
}

/**
 * Signs a new JWT session token and returns it as a string.
 */
export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(getSecret());
}

/**
 * Verifies a JWT session token and returns the payload.
 * Throws if the token is invalid or expired.
 */
export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  if (!payload.sub || typeof payload["username"] !== "string") {
    throw new Error("Invalid session payload.");
  }
  return { userId: payload.sub, username: payload["username"] as string };
}

/**
 * Elysia plugin — reads the session cookie and injects `session` into context.
 * Returns 401 if the cookie is missing or the token is invalid/expired.
 *
 * Usage:
 *   app.use(requireAuth).get("/protected", ({ session }) => session.userId)
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

export { COOKIE_NAME };
