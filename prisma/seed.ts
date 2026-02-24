import { prisma } from "../src/lib/prisma.ts";

interface ProductData {
	release_date: string;
	jpy_price: string;
	availability: string;
	stock_status: string;
	product_name: string;
}

type ProductBatch = Record<string, ProductData>;

async function main() {
	const fileData = await Deno.readTextFile("./data/hlj-products.json");
	const { products }: { products: ProductBatch[] } = JSON.parse(fileData);

	let created = 0;
	let skipped = 0;

	for (const batch of products) {
		for (const [itemCode, product] of Object.entries(batch)) {
			const existing = await prisma.kit.findUnique({
				where: { item_code: itemCode },
			});

			if (existing) {
				skipped++;
				continue;
			}

			await prisma.kit.create({
				data: {
					item_code: itemCode,
					release_date: product.release_date || null,
					jpy_price: parseInt(product.jpy_price, 10),
					availability: product.availability,
					stock_status: product.stock_status || null,
					product_name: product.product_name,
				},
			});
			created++;
		}
	}

	console.log(`Seed complete — created: ${created}, skipped: ${skipped}`);
}

main()
	.catch((e) => {
		console.error(e);
		Deno.exit(1);
	})
	.finally(() => prisma.$disconnect());
