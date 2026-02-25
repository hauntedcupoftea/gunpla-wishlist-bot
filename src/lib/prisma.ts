import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/client.ts";
import { env } from "./env.ts";

const dbProvider = env.DB_PROVIDER;
const databaseUrl = env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error(
		"DATABASE_URL is not set. Make sure your .env file exists and contains DATABASE_URL.",
	);
}

function createPrismaClient(): PrismaClient {
	if (dbProvider === "sqlite") {
		const adapter = new PrismaLibSql({ url: databaseUrl });
		return new PrismaClient({ adapter });
	}

	const adapter = new PrismaPg({ connectionString: databaseUrl });
	return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();
