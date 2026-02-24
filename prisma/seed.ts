const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  // Read the JSON file
  const filePath = path.join(__dirname, '../data/hlj-products.json'); // Adjust the path accordingly
  const fileData = fs.readFileSync(filePath);
  
  // Parse the JSON data
  const batches = JSON.parse(fileData).products; // Access the products array directly

  for (const batch of batches) {
    const productEntries = Object.entries(batch); // Iterate over each batch

    for (const [itemCode, product] of productEntries) {
      // Check if the product already exists
      const existingProduct = await prisma.kit.findUnique({
        where: { item_code: itemCode },
      });

      if (!existingProduct) {
        // Insert new product if it doesn't exist
        await prisma.kit.create({
          data: {
            item_code: itemCode,
            release_date: product.release_date,
            jpy_price: parseInt(product.jpy_price, 10), // Ensure price is an integer
            availability: product.availability,
            stock_status: product.stock_status,
            product_name: product.product_name,
          },
        });
      } else {
        console.warn(`[WARN] Skipped ${product.product_name} with item code ${itemCode} (already exists)`);
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
