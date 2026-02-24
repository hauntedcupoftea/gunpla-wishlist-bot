import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/client/client.ts";
import "dotenv/config";

const dbProvider = Deno.env.get("DB_PROVIDER") ?? "postgresql";
const databaseUrl = Deno.env.get("DATABASE_URL");

function createPrismaClient(): PrismaClient {
	if (dbProvider === "sqlite") {
		const client = createClient({ url: databaseUrl });
		const adapter = new PrismaLibSql(client);
		return new PrismaClient({ adapter });
	}
	const adapter = new PrismaPg({ connectionString: databaseUrl });
	return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();
