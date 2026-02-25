import { env } from "./env.ts";

export function icontains(value: string): {
	contains: string;
	mode?: "insensitive";
} {
	const provider = env.DB_PROVIDER;
	return provider === "sqlite"
		? { contains: value }
		: { contains: value, mode: "insensitive" as const };
}
