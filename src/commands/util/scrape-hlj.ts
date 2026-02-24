import axios from "axios";
import cliProgress from "cli-progress";
import * as htmlparser2 from "htmlparser2";

const baseURL = "https://www.hlj.com/search/?Page=";
const filterURL =
  "&MacroType2=High+Grade+Kits&MacroType2=High-Grade+Kits&MacroType2=Master+Grade+Kits&MacroType2=Master-Grade+Kits&MacroType2=Real-Grade+Kits&MacroType2=Real+Grade+Kits&MacroType2=Injection+Kits&MacroType2=Other+Gundam+Kits&MacroType2=Gundam+Kits";

function rateLimitDelay() {
  return 200 * (2 + Math.random());
}

function getHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    DNT: "1", // Do Not Track Request Header
  };
}

async function getCsrf() {
  try {
    const initialResponse = await axios.get(`${baseURL}1${filterURL}`, {
      withCredentials: true,
      headers: getHeaders(),
    });

    let csrfToken = "";

    const cookies = initialResponse.headers["set-cookie"];
    if (cookies) {
      const csrfCookie = cookies.find((cookie: string) =>
        cookie.startsWith("csrftoken=")
      );
      if (csrfCookie) {
        csrfToken = csrfCookie.split(";")[0].split("=")[1];
      }
    }
    return csrfToken;
  } catch (e) {
    const error = e as Error;
    console.error("Error fetching data:", error.message);
  }
}

// Function to simulate rate-limiting by adding a delay
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLivePrice(item_codes: string[], token: string | undefined) {
  const itemCodesString = item_codes.join(",");
  try {
    const { data } = await axios.get("https://www.hlj.com/search/livePrice/", {
      params: {
        item_codes: itemCodesString,
        csrfmiddlewaretoken: token,
      },
      headers: getHeaders(),
    });

    const response: Record<string, any> = {};

    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        response[key] = {
          release_date: data[key].release_date,
          jpy_price: data[key].JPYprice,
          availability: data[key].availability,
          stock_status: data[key].remainingStockStatus,
        };
      }
    }
    return response;
  } catch (e) {
    console.error("Error fetching live price:", e);
    throw e;
  }
}

async function scrapeProductsFromPage(
  pageNumber: number,
  token: string | undefined,
) {
  const url = `${baseURL}${pageNumber}${filterURL}`;

  try {
    const { data } = await axios.get(url, {
      headers: getHeaders(),
    });
    const products: string[] = [];
    let itemCodes = "";

    const itemCodesRegex = /item_codes\s*=\s*"(.*?)"/;
    const itemCodesMatch = itemCodesRegex.exec(data);
    if (itemCodesMatch && itemCodesMatch[1]) {
      itemCodes = itemCodesMatch[1];
    }

    const itemCodesArray = itemCodes
      .split(",")
      .map((code) => code.trim().toUpperCase());

    // HTML parser setup
    let isProductName = false;
    const parser = new htmlparser2.Parser(
      {
        onopentag(name, attribs) {
          // We're looking for product names inside <p class="product-item-name">
          if (
            name === "p" &&
            attribs.class &&
            attribs.class.includes("product-item-name")
          ) {
            isProductName = true; // Mark the start of the product name
          }
        },
        onclosetag(name) {
          if (name === "p") {
            isProductName = false;
          }
        },
        ontext(text) {
          if (isProductName) {
            products.push(text); // Keep the raw text
          }
        },
        onerror(err) {
          console.error("Parsing error:", err);
        },
      },
      { decodeEntities: false },
    ); // Disable automatic entity decoding

    parser.write(data);
    parser.end();

    const itemInfo = await getLivePrice(itemCodesArray, token);
    products
      .map((name) => name.trim())
      .filter((name) => name)
      .forEach((productName, index) => {
        const itemCode = itemCodesArray[index];
        if (itemInfo[itemCode]) {
          itemInfo[itemCode].product_name = productName;
        }
      });

    return {
      itemInfo: itemInfo,
    };
  } catch (e) {
    const error = e as Error;
    console.error(`Error scraping page ${pageNumber}:`, error.message);
    return {
      itemInfo: [],
    };
  }
}

async function getTotalPages() {
  try {
    const { data } = await axios.get(`${baseURL}1${filterURL}`, {
      headers: getHeaders(),
    });

    let calculatedTotalPages = 0; // FIXED: Explicitly declared the variable

    const parser = new htmlparser2.Parser(
      {
        onopentag() {},
        ontext(text) {
          const match = text.match(/Showing (\d+) results/);
          if (match) {
            const totalResults = parseInt(match[1], 10);
            const itemsPerPage = 24;
            calculatedTotalPages = Math.ceil(totalResults / itemsPerPage);
          }
        },
        onclosetag() {},
        onerror(err) {
          console.error("Parsing error:", err);
        },
      },
      { decodeEntities: true },
    );

    parser.write(data);
    parser.end();

    return calculatedTotalPages;
  } catch (e) {
    const error = e as Error;
    console.error(`Error fetching total pages:`, error.message);
    return 0;
  }
}

// Main function to scrape all products across multiple pages with rate limiting
async function scrapeAllProducts() {
  const totalPages = await getTotalPages();
  const allproducts: any[] = [];
  let totalWaitTime = 0;
  let totalItems = 0;

  const token = await getCsrf();

  const progressBar = new cliProgress.SingleBar(
    {
      format:
        "Scraping... |{bar}| {percentage}% | Page {value}/{total} | ETA: {eta}s | Items in page: {items} | Total Items: {titems}",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(totalPages, 0, { items: 0, titems: totalItems });

  for (let i = 1; i <= totalPages; i++) {
    const products = await scrapeProductsFromPage(i, token);

    // Ensure products.itemInfo is an object/array before pushing and getting keys
    if (products.itemInfo && typeof products.itemInfo === "object") {
      allproducts.push(products.itemInfo);

      const n_items = Object.keys(products.itemInfo).length;
      totalItems += n_items;
      progressBar.update(i, { items: n_items, titems: totalItems });
    } else {
      progressBar.update(i, { items: 0, titems: totalItems });
    }

    if (i < totalPages) {
      const rate = rateLimitDelay();
      await sleep(rate);
      totalWaitTime += rate;
    }
  }

  progressBar.stop();

  console.log(
    `Scraping complete. Total product pages scraped: ${allproducts.length}`,
  );
  console.log(
    `Total time waited: ${totalWaitTime / 1000}s = ${
      totalWaitTime / 60000
    } min`,
  );
  return {
    products: allproducts,
  };
}

async function main() {
  try {
    const products = await scrapeAllProducts();
    await sleep(rateLimitDelay());
    try {
      await Deno.mkdir("./data", { recursive: true });
    } catch (e) {
      // Ignore if it already exists
    }

    await Deno.writeTextFile(
      "./data/hlj-products.json",
      JSON.stringify(products, undefined, 2),
    );

    console.log("All products scraped and saved at ./data/hlj-products.json");
  } catch (e) {
    const error = e as Error;
    console.error("Failed to scrape products:", error.message);
  }
}

main();
