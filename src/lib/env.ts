import "@std/dotenv/load";

/**
 * Reads a required environment variable, throwing a descriptive error at
 * startup if it is missing rather than failing silently at runtime.
 */
function requireEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/**
 * Reads an optional environment variable. Returns undefined if not set.
 * API-specific vars use this so the bot can start without them set.
 * The API server validates these at its own startup in src/api/index.ts.
 */
function optionalEnv(key: string): string | undefined {
  return Deno.env.get(key) ?? undefined;
}

export const env = {
  // ── Bot (required) ────────────────────────────────────────────────────────
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  APPLICATION_ID: requireEnv("APPLICATION_ID"),
  /// If set, commands register to this guild only (instant propagation).
  /// Omit for global registration (up to 1 hour propagation).
  GUILD_ID: Deno.env.get("GUILD_ID"),
  DB_PROVIDER: (Deno.env.get("DB_PROVIDER") ?? "postgresql") as
    | "sqlite"
    | "postgresql",
  DATABASE_URL: requireEnv("DATABASE_URL"),

  // ── API (optional — validated at API startup) ─────────────────────────────
  /// Discord OAuth2 client secret (Discord app → OAuth2 settings).
  DISCORD_CLIENT_SECRET: optionalEnv("DISCORD_CLIENT_SECRET"),
  /// Public URL of this API — must match the OAuth2 redirect URI registered
  /// in your Discord app. Example: https://api.yourbot.com
  API_BASE_URL: optionalEnv("API_BASE_URL"),
  /// Secret for signing JWT session tokens. Use a 32+ char random string.
  JWT_SECRET: optionalEnv("JWT_SECRET"),
  /// Port the Elysia API server listens on inside the container (default: 3000).
  API_PORT: parseInt(Deno.env.get("API_PORT") ?? "3000", 10),
} as const;

export type Env = typeof env;
