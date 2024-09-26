const axios = require('axios');
const htmlparser2 = require('htmlparser2');

// Base URL for HLJ Gundam kits search
const baseURL = 'https://www.hlj.com/search/?Page=';
// Rate limit settings: delay between each request in milliseconds (e.g., 1000ms = 1 second)
const rateLimitDelay = 1500; // 1.5 seconds between each request

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

let csrfToken = ''; // Variable to store the CSRF token

async function getCsrf() {
    try {
        // First request to get the CSRF token
        const initialResponse = await axios.get(`${baseURL}1&MacroType2=Gundam+Kits&MacroType2=Injection+Kits&AdultItem=0`, {
            withCredentials: true, // Ensure that cookies are included in the request
            headers: getHeaders()
        });

        // Extract the CSRF token from the cookies
        const cookies = initialResponse.headers['set-cookie'];
        if (cookies) {
            const csrfCookie = cookies.find(cookie => cookie.startsWith('csrftoken='));
            if (csrfCookie) {
                csrfToken = csrfCookie.split(';')[0].split('=')[1]; // Get the value of the CSRF token
            }
        }
    } catch (error) {
        console.error('Error fetching data:', error.message);
    }
}

// Function to simulate rate-limiting by adding a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to scrape product names from a single page
async function scrapeProductNamesFromPage(pageNumber) {
    const url = `${baseURL}${pageNumber}&MacroType2=Gundam+Kits&MacroType2=Injection+Kits&AdultItem=0`;

    try {
        const { data } = await axios.get(url, {
            headers: getHeaders(), // Use realistic headers in each request
        });
        const productNames = [];
        const itemCodes = [];

        // Use htmlparser2 to parse the HTML
        const parser = new htmlparser2.Parser({
            isProductName: false,
            currentHref: '', // Store the current href
            onopentag(name, attribs) {
                // We're looking for product names inside <p class="product-item-name">
                if (name === 'p' && attribs.class && attribs.class.includes('product-item-name')) {
                    this.isProductName = true; // Mark the start of the product name
                } else if (name === 'a' && this.isProductName) {
                    // Capture the href when we're in a product name
                    this.currentHref = attribs.href; // Store the href attribute
                }
            },
            onclosetag(name) {
                // Reset when closing the <p> tag
                if (name === 'p') {
                    this.isProductName = false; // Reset after capturing the name
                    this.currentHref = ''; // Reset the href
                }
            },
            ontext(text) {
                if (this.isProductName) {
                    // Directly push the text, preserving ampersands
                    productNames.push(text.trim()); // Keep the raw text

                    // Extract item code from the href
                    const itemCodeMatch = this.currentHref.match(/-(\w+)$/); // Match the last part of the URL after the last '-'
                    if (itemCodeMatch) {
                        const itemCode = itemCodeMatch[1].toUpperCase(); // Convert to uppercase
                        itemCodes.push(itemCode); // Store the item code
                    }
                }
            },
            onerror(err) {
                console.error("Parsing error:", err);
            }
        }, { decodeEntities: false }); // Disable automatic entity decoding

        parser.write(data);
        parser.end();

        console.log(productNames, itemCodes)

        // Clean up product names: trim whitespace and filter out empty strings
        return {
            productNames: productNames.filter(name => name), // Keep only non-empty strings
            itemCodes, // Return item codes
        };
    } catch (error) {
        console.error(`Error scraping page ${pageNumber}:`, error.message);
        return { productNames: [], itemCodes: [] }; // Return empty arrays on error
    }
}

// Function to get the total number of pages from the search results
async function getTotalPages() {
    try {
        const { data } = await axios.get(`${baseURL}1&MacroType2=Gundam+Kits&MacroType2=Injection+Kits&AdultItem=0`, {
            headers: getHeaders(), // Use realistic headers in each request
        });

        // Use htmlparser2 to parse the HTML
        const parser = new htmlparser2.Parser({
            onopentag(name, attribs) {
                // No need for any specific open tag handling
            },
            ontext(text) {
                // Look for the specific text indicating total results
                const match = text.match(/Showing (\d+) results/);
                if (match) {
                    const totalResults = parseInt(match[1], 10);
                    // Assuming 24 items per page
                    const itemsPerPage = 24;
                    totalPages = Math.ceil(totalResults / itemsPerPage);
                }
            },
            onclosetag(name) {
                // No need for any specific close tag handling
            },
            onerror(err) {
                console.error("Parsing error:", err);
            }
        }, { decodeEntities: true }); // Enable entity decoding

        parser.write(data);
        parser.end();

        return totalPages; // Return the calculated total pages
    } catch (error) {
        console.error(`Error fetching total pages:`, error.message);
        return 0; // Return 0 in case of an error
    }
}

// Main function to scrape all products across multiple pages with rate limiting
async function scrapeAllProducts() {
    const totalPages = await getTotalPages();
    const allProductNames = [];

    // Scrape each page, displaying progress as you go
    for (let i = 1; i <= totalPages; i++) {
        const productNames = await scrapeProductNamesFromPage(i);
        allProductNames.push(productNames);

        console.log(`Scraped page ${i}/${totalPages} - Found ${productNames.length} products on this page`);

        // Rate limiting: wait for a specified delay between each request
        if (i < totalPages) {
            console.log(`Waiting ${rateLimitDelay / 1000} seconds before scraping the next page...`);
            await sleep(rateLimitDelay);
        }
    }

    console.log(`Scraping complete. Total products scraped: ${allProductNames.length}`);
    return allProductNames;
}

// Start scraping and handle the result or any errors
(async () => {
    try {
        const products = await scrapeAllProducts();
        console.log('All products scraped:', products);
    } catch (error) {
        console.error('Failed to scrape products:', error.message);
    }
})();
