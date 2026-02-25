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

export function kitNameFilter(query: string) {
	const provider = env.DB_PROVIDER;
	const words = query.trim().split(/\s+/).filter(Boolean);

	if (words.length === 0) return {};

	const conditions = words.map((word) =>
		provider === "sqlite"
			? { product_name: { contains: word } }
			: { product_name: { contains: word, mode: "insensitive" as const } },
	);
	return conditions.length === 1 ? conditions[0] : { AND: conditions };
}
