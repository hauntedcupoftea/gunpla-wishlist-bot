const axios = require('axios');
const htmlparser2 = require('htmlparser2');

// Base URL for HLJ Gundam kits search
const baseURL = 'https://www.hlj.com/search/?Page=';
const filterURL = "&MacroType2=High+Grade+Kits&MacroType2=High-Grade+Kits&MacroType2=Master+Grade+Kits&MacroType2=Master-Grade+Kits&MacroType2=Real-Grade+Kits&MacroType2=Real+Grade+Kits&MacroType2=Injection+Kits&MacroType2=Other+Gundam+Kits&MacroType2=Gundam+Kits";
// Rate limit settings: delay between each request in milliseconds (e.g., 1000ms = 1 second)
function rateLimitDelay(){
    return 500*(1 + Math.random());
} 

// Function to simulate realistic headers for axios requests
function getHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'DNT': '1', // Do Not Track Request Header
    };
}



async function getCsrf() {
    try {
        const initialResponse = await axios.get(`${baseURL}1${filterURL}`, {
            withCredentials: true,
            headers: getHeaders()
        });

        let csrfToken = ''; // Variable to store the CSRF token

        const cookies = initialResponse.headers['set-cookie'];
        if (cookies) {
            const csrfCookie = cookies.find(cookie => cookie.startsWith('csrftoken='));
            if (csrfCookie) {
                csrfToken = csrfCookie.split(';')[0].split('=')[1]; // Get the value of the CSRF token
            }
        }
        return csrfToken;
    } catch (error) {
        console.error('Error fetching data:', error.message);
    }
}

// Function to simulate rate-limiting by adding a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLivePrice(item_codes, token) {
    const itemCodesString = item_codes.join(',');
    try {
        const { data } = await axios.get('https://www.hlj.com/search/livePrice/', {
            params: {
                item_codes: itemCodesString,
                csrfmiddlewaretoken: token
            },
            headers: getHeaders()
        });
        return data;
    } catch (error) {
        console.error('Error fetching live price:', error);
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
        const productNames = [];
        let itemCodes = '';

        const itemCodesRegex = /item_codes\s*=\s*"(.*?)"/;
        const itemCodesMatch = itemCodesRegex.exec(data);
        if (itemCodesMatch && itemCodesMatch[1]) {
            itemCodes = itemCodesMatch[1];
        }

        const itemCodesArray = itemCodes.split(',').map(code => code.trim().toUpperCase());

        const parser = new htmlparser2.Parser({
            isProductName: false,
            onopentag(name, attribs) {
                // We're looking for product names inside <p class="product-item-name">
                if (name === 'p' && attribs.class && attribs.class.includes('product-item-name')) {
                    this.isProductName = true; // Mark the start of the product name
                }
            },
            onclosetag(name) {
                // Reset when closing the <p> tag
                if (name === 'p') {
                    this.isProductName = false;
                }
            },
            ontext(text) {
                if (this.isProductName) {
                    productNames.push(text); // Keep the raw text
                }
            },
            onerror(err) {
                console.error("Parsing error:", err);
            }
        }, { decodeEntities: false }); // Disable automatic entity decoding

        parser.write(data);
        parser.end();

        const itemInfo = await getLivePrice(itemCodesArray, token);

        return {
            productNames: productNames.map(name => name.trim()).filter(name => name),
            itemInfo: itemInfo, // Return item codes array
        };
    } catch (error) {
        console.error(`Error scraping page ${pageNumber}:`, error.message);
        return {
            productNames: [],
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

        const parser = new htmlparser2.Parser({
            onopentag(name, attribs) {},
            ontext(text) {
                const match = text.match(/Showing (\d+) results/);
                if (match) {
                    const totalResults = parseInt(match[1], 10);
                    const itemsPerPage = 24;
                    totalPages = Math.ceil(totalResults / itemsPerPage);
                }
            },
            onclosetag(name) {
            },
            onerror(err) {
                console.error("Parsing error:", err);
            }
        }, { decodeEntities: true });

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
    const allProductNames = [];
    const allItemInfos = [];
    let totalWaitTime = 0;

    const token = await getCsrf();

    for (let i = 1; i <= totalPages; i++) {
        const productNames = await scrapeProductsFromPage(i, token);
        allProductNames.push(...productNames.productNames);
        allItemInfos.push(productNames.itemInfo);

        console.log(`Scraped page ${i}/${totalPages} (${i/totalPages*100}%): 
    Found ${productNames.productNames.length} products.
    Found ${Object.keys(productNames.itemInfo).length} item_codes on this page`);

        if (i < totalPages) {
            const rate = rateLimitDelay()
            console.log(`Waiting ${rate / 1000}s before scraping the next page...`);
            await sleep(rate);
            totalWaitTime = totalWaitTime + rate
        }
    }

    console.log(`Scraping complete. Total products scraped: ${allProductNames.length}`);
    console.log(`Total time waited: ${totalWaitTime/1000}s = ${totalWaitTime/60000} min`);
    return {
        "products" : allProductNames,
        "iteminfo" : allItemInfos
    };
}

// Start scraping and handle the result or any errors
async function main() {
    try {
        const products = await scrapeAllProducts();
        await sleep(rateLimitDelay())
        const FileSystem = require("fs");
        FileSystem.writeFile('./data/hlj-products.json', JSON.stringify(products, undefined, 4), (error) => {
            if (error) throw error;
        });
        console.log('All products scraped and saved at ./data/hlj-products.json');
    } catch (error) {
        console.error('Failed to scrape products:', error.message);
    }
}

main();