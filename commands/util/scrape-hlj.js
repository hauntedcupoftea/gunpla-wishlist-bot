const axios = require("axios");
const htmlparser2 = require("htmlparser2");
const cliProgress = require('cli-progress');

// Base URL for HLJ Gundam kits search
const baseURL = "https://www.hlj.com/search/?Page=";
const filterURL =
  "&MacroType2=High+Grade+Kits&MacroType2=High-Grade+Kits&MacroType2=Master+Grade+Kits&MacroType2=Master-Grade+Kits&MacroType2=Real-Grade+Kits&MacroType2=Real+Grade+Kits&MacroType2=Injection+Kits&MacroType2=Other+Gundam+Kits&MacroType2=Gundam+Kits";
// Rate limit settings: delay between each request in milliseconds (e.g., 1000ms = 1 second)
function rateLimitDelay() {
  return 200 * (2 + Math.random());
}

// Function to simulate realistic headers for axios requests
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

    let csrfToken = ""; // Variable to store the CSRF token

    const cookies = initialResponse.headers["set-cookie"];
    if (cookies) {
      const csrfCookie = cookies.find((cookie) =>
        cookie.startsWith("csrftoken=")
      );
      if (csrfCookie) {
        csrfToken = csrfCookie.split(";")[0].split("=")[1]; // Get the value of the CSRF token
      }
    }
    return csrfToken;
  } catch (error) {
    console.error("Error fetching data:", error.message);
  }
}

// Function to simulate rate-limiting by adding a delay
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLivePrice(item_codes, token) {
  const itemCodesString = item_codes.join(",");
  try {
    const { data } = await axios.get("https://www.hlj.com/search/livePrice/", {
      params: {
        item_codes: itemCodesString,
        csrfmiddlewaretoken: token,
      },
      headers: getHeaders(),
    });

    let response = {};

    // Loop over the actual data object, assuming it's an object of item codes as keys
    for (let key in data) {
      if (data.hasOwnProperty(key)) {
        // Create the response as key-value pair with item code as key
        response[key] = {
          release_date: data[key].release_date,
          jpy_price: data[key].JPYprice,
          availability: data[key].availability,
          stock_status: data[key].remainingStockStatus,
        };
      }
    }
    return response;
  } catch (error) {
    console.error("Error fetching live price:", error);
    throw error;
  }
}

// Function to scrape product names from a single page
async function scrapeProductsFromPage(pageNumber, token) {
  const url = `${baseURL}${pageNumber}${filterURL}`;

  try {
    const { data } = await axios.get(url, {
      headers: getHeaders(),
    });
    const products = [];
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
    const parser = new htmlparser2.Parser(
      {
        isProductName: false,
        onopentag(name, attribs) {
          // We're looking for product names inside <p class="product-item-name">
          if (
            name === "p" &&
            attribs.class &&
            attribs.class.includes("product-item-name")
          ) {
            this.isProductName = true; // Mark the start of the product name
          }
        },
        onclosetag(name) {
          if (name === "p") {
            this.isProductName = false;
          }
        },
        ontext(text) {
          if (this.isProductName) {
            products.push(text); // Keep the raw text
          }
        },
        onerror(err) {
          console.error("Parsing error:", err);
        },
      },
      { decodeEntities: false }
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
  } catch (error) {
    console.error(`Error scraping page ${pageNumber}:`, error.message);
    return {
      itemInfo: [],
    };
  }
}


// Function to get the total number of pages from the search results
async function getTotalPages() {
  try {
    const { data } = await axios.get(`${baseURL}1${filterURL}`, {
      headers: getHeaders(),
    });

    const parser = new htmlparser2.Parser(
      {
        onopentag(name, attribs) {},
        ontext(text) {
          const match = text.match(/Showing (\d+) results/);
          if (match) {
            const totalResults = parseInt(match[1], 10);
            const itemsPerPage = 24;
            totalPages = Math.ceil(totalResults / itemsPerPage);
          }
        },
        onclosetag(name) {},
        onerror(err) {
          console.error("Parsing error:", err);
        },
      },
      { decodeEntities: true }
    );

    parser.write(data);
    parser.end();

    return totalPages;
  } catch (error) {
    console.error(`Error fetching total pages:`, error.message);
    return 0;
  }
}

// Main function to scrape all products across multiple pages with rate limiting
async function scrapeAllProducts() {
  const totalPages = await getTotalPages();
  const allproducts = [];
  let totalWaitTime = 0;
  let totalItems = 0;

  const token = await getCsrf();

  // Create a new progress bar instance
  const progressBar = new cliProgress.SingleBar({
    format: 'Scraping... |{bar}| {percentage}% | Page {value}/{total} | ETA: {eta}s | Items in page: {items} | Total Items: {titems}',
    hideCursor: true
  }, cliProgress.Presets.shades_classic);

  // Start the progress bar with total pages
  progressBar.start(totalPages, 0, { items: 0, titems: totalItems });

  for (let i = 1; i <= totalPages; i++) {
    const products = await scrapeProductsFromPage(i, token);
    allproducts.push(products.itemInfo);

    // Update the progress bar, passing the current page and number of items found
    let n_items = Object.keys(products.itemInfo).length
    totalItems += n_items
    progressBar.update(i, { items:  n_items, titems: totalItems });

    if (i < totalPages) {
      const rate = rateLimitDelay();
      await sleep(rate);  // Delay for rate limiting
      totalWaitTime += rate;
    }
  }

  // Stop the progress bar after completion
  progressBar.stop();

  console.log(
    `Scraping complete. Total products scraped: ${allproducts.length}`
  );
  console.log(
    `Total time waited: ${totalWaitTime / 1000}s = ${totalWaitTime / 60000} min`
  );
  return {
    products: allproducts,
  };
}

// Start scraping and handle the result or any errors
async function main() {
  try {
    const products = await scrapeAllProducts();
    await sleep(rateLimitDelay());
    const FileSystem = require("fs");
    FileSystem.writeFile(
      "./data/hlj-products.json",
      JSON.stringify(products, undefined, 2),
      (error) => {
        if (error) throw error;
      }
    );
    console.log("All products scraped and saved at ./data/hlj-products.json");
  } catch (error) {
    console.error("Failed to scrape products:", error.message);
  }
}

main();
