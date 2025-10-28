const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Scrape visible text from given URL.
 * Returns object with extracted text and basic meta info.
 * Notes:
 * - Cheerio does not support :visible selectors. We remove script/style
 *   elements and then collect text nodes.
 */
async function scrape(url, opts = {}) {
  try {
    const response = await axios.get(url, {
      timeout: opts.timeout || 15000,
      headers: {
        // Provide a sensible User-Agent
        "User-Agent": opts.userAgent || "Shopify-AI-Scraper/1.0 (+https://example.com)",
        Accept: "text/html,application/xhtml+xml"
      }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove elements that should not contribute to visible text
    $("script").remove();
    $("style").remove();
    $("noscript").remove();
    $("iframe").remove();
    $("svg").remove();
    $("meta").remove();
    $("link").remove();

    // Helper: collect text nodes under body, skipping empty/whitespace-only nodes
    let pieces = [];
    $("body").find("*").each((i, el) => {
      // exclude elements that are unlikely to contain user-facing text
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (["script", "style", "noscript", "svg", "iframe", "head", "meta", "link"].includes(tag)) return;
      const text = $(el)
        .contents()
        .filter(function () {
          return this.type === "text";
        })
        .map(function () {
          return $(this).text();
        })
        .get()
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text && text.length > 0) pieces.push(text);
    });

    const fullText = pieces.join(" \n").replace(/\s+/g, " ").trim();

    // Extract some metadata (title, first h1, description)
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const description = $('meta[name="description"]').attr("content") || "";

    return {
      title,
      h1,
      description,
      text: fullText.slice(0, opts.maxLength || 2000), // default limit
      url
    };
  } catch (error) {
    // Provide more detailed error for debugging in dev, but keep shape consistent
    return { error: error.message || String(error), url };
  }
}

module.exports = { scrape };
