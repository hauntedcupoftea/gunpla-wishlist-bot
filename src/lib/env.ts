import "@std/dotenv/load";

function requireEnv(key: string): string {
	const value = Deno.env.get(key);
	if (!value) throw new Error(`Missing required environment variable: ${key}`);
	return value;
}

export const env = {
	DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
	APPLICATION_ID: requireEnv("APPLICATION_ID"),
	GUILD_ID: Deno.env.get("GUILD_ID"), // optional
	DB_PROVIDER: (Deno.env.get("DB_PROVIDER") ?? "postgresql") as
		| "sqlite"
		| "postgresql",
	DATABASE_URL: requireEnv("DATABASE_URL"),
} as const;

export type Env = typeof env;
