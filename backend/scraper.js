const axios = require("axios");
const cheerio = require("cheerio");
// Puppeteer is optional (heavy). We'll require it lazily when needed.
let puppeteer = null;

async function ensurePuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = require('puppeteer');
    return puppeteer;
  } catch (e) {
    // not installed
    return null;
  }
}

/**
 * Scrape visible text from given URL.
 * Returns object with extracted text and basic meta info.
 * Notes:
 * - Cheerio does not support :visible selectors. We remove script/style
 *   elements and then collect text nodes.
 */
async function scrape(url, opts = {}) {
  try {
    console.log('scrape: starting', url);
    const response = await axios.get(url, {
      timeout: opts.timeout || 15000,
      headers: {
        // Provide a sensible User-Agent
        "User-Agent": opts.userAgent || "Shopify-AI-Scraper/1.0 (+https://example.com)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    const html = response.data;
    console.log('scrape: fetched', url, 'bytes=', html ? html.length : 0);
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

    let textOut = fullText.slice(0, opts.maxLength || 2000);

    // If no visible text was extracted and rendering is allowed, try a headless render (Puppeteer)
    const shouldRender = !!opts.render || !!opts.fallbackRender;
    if ((!textOut || textOut.length < 20) && shouldRender) {
      console.log('scrape: attempting render fallback for', url);
      const pptr = await ensurePuppeteer();
      if (pptr) {
        try {
          const browser = await pptr.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'], headless: true });
          const page = await browser.newPage();
          await page.setUserAgent(opts.userAgent || 'Shopify-AI-Scraper/1.0 (+https://example.com)');
          await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.renderTimeout || 20000 });
          // remove unwanted elements then get visible text
          await page.evaluate(() => {
            const remove = ['script','style','noscript','iframe','svg','meta','link'];
            remove.forEach(t => document.querySelectorAll(t).forEach(n => n.remove()));
          });
          const bodyText = await page.evaluate(() => document.body.innerText || '');
          const title2 = await page.title();
          const h1Text = await page.$eval('h1', el => el.innerText,).catch(() => '');
          await browser.close();
          textOut = (bodyText || '').replace(/\s+/g, ' ').trim().slice(0, opts.maxLength || 2000);
          // prefer rendered metadata if original empty
          if (!title) title = title2 || '';
          if (!h1) h1 = h1Text || '';
        } catch (e) {
          console.log('scrape: render fallback failed for', url, e && (e.message || e));
          // rendering failed; ignore and continue with whatever we had
          try { if (browser && browser.close) await browser.close(); } catch (_) {}
        }
      }
    }

    console.log('scrape: finished for', url, 'chars=', (textOut || '').length);
    return {
      title,
      h1,
      description,
      text: textOut,
      url
    };
  } catch (error) {
    console.log('scrape: error for', url, error && (error.message || error));
    // Provide more detailed error for debugging in dev, but keep shape consistent
    return { error: error.message || String(error), url };
  }
}

module.exports = { scrape };
