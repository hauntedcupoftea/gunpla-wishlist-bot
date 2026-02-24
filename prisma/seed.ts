import process from "node:process";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

async function main() {
  const filePath = path.join(__dirname, "../data/hlj-products.json"); // Adjust the path accordingly
  const fileData = readFileSync(filePath).toString();

  const batches: Array<
    Record<
      string,
      {
        release_date: string;
        jpy_price: string;
        availability: string;
        stock_status: string;
        product_name: string;
      }
    >
  > = JSON.parse(fileData).products;

  for (const batch of batches) {
    const productEntries = Object.entries(batch);

    for (const [itemCode, product] of productEntries) {
      const existingProduct = await prisma.kit.findUnique({
        where: { item_code: itemCode },
      });

      if (!existingProduct) {
        await prisma.kit.create({
          data: {
            item_code: itemCode,
            release_date: product.release_date,
            jpy_price: parseInt(product.jpy_price, 10),
            availability: product.availability,
            stock_status: product.stock_status,
            product_name: product.product_name,
          },
        });
      } else {
        console.warn(
          `[WARN] Skipped ${product.product_name} with item code ${itemCode} (already exists)`,
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
