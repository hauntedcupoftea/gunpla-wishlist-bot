import "dotenv/config";
import type { PrismaConfig } from "prisma";
import { defineConfig, env } from "prisma/config";

const isSQLite =
	(Deno.env.get("DB_PROVIDER") ?? process.env.DB_PROVIDER) === "sqlite";

export default defineConfig({
	schema: isSQLite
		? "prisma/schema.sqlite.prisma"
		: "prisma/schema.postgresql.prisma",
	migrations: {
		path: "prisma/migrations",
		seed: "deno run --env -A prisma/seed.ts",
	},
	datasource: {
		url: env("DATABASE_URL"),
	},
} satisfies PrismaConfig);
