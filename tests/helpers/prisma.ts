/**
 * @module tests/helpers/prisma
 *
 * Prisma client for tests. Completely separate from src/lib/prisma.ts —
 * does not touch .env, does not load dotenv, does not share state with
 * the app's singleton.
 *
 * Requires TEST_DATABASE_URL to be set (done automatically by deno task test).
 * Cries loudly if it isn't.
 */

import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../generated/client.ts";

const url = Deno.env.get("TEST_DATABASE_URL");

if (!url) {
  throw new Error(
    "\n\nTEST_DATABASE_URL is not set.\n" +
      "Run tests with:  deno task test\n" +
      "                 deno task test:service\n" +
      "or manually:     TEST_DATABASE_URL=file:prisma/test.db deno test -A tests/\n",
  );
}

export const testPrisma = new PrismaClient({
  adapter: new PrismaLibSql({ url }),
});
