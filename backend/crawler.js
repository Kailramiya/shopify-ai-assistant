// crawler.js

const axios = require('axios');
const cheerio = require('cheerio');
const { scrape } = require('./scraper');
const { URL } = require('url');
const robotsParser = require('robots-parser');

/**
 * Robust site crawler optimized for storefront scraping.
 * Features:
 * - Same-origin only
 * - Optional robots.txt respect (basic Disallow parsing)
 * - BFS with depth and page limits
 * - Concurrency control (simple semaphore)
 * - Returns per-page metadata and aggregated text
 */
async function fetchRobotsTxt(rootUrl, userAgent = '*') {
  try {
    const robotsUrl = new URL('/robots.txt', rootUrl).toString();
    const resp = await axios.get(robotsUrl, { timeout: 5000, validateStatus: () => true });
    const body = resp.status === 200 ? resp.data : '';
    const robots = robotsParser(robotsUrl, body);
    const crawlDelay = robots.getCrawlDelay ? (robots.getCrawlDelay(userAgent) || 0) : 0;
    return { robots, crawlDelay };
  } catch (e) {
    return { robots: null, crawlDelay: 0 };
  }
}

function isAllowedByRobots(robots, url, userAgent = '*') {
  try {
    if (!robots) return true;
    return robots.isAllowed(url, userAgent);
  } catch (e) {
    return true;
  }
}

function normalizeUrl(base, href) {
  try {
    // ignore anchors and javascript/mailto
    if (!href || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('#')) return null;
    const u = new URL(href, base);
    // strip fragment
    u.hash = '';
    // normalize: remove trailing slash for consistency except root
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.replace(/\/$/, '');
    return s;
  } catch (e) {
    return null;
  }
}

async function crawlSite(startUrl, opts = {}) {
  const maxPages = opts.maxPages || 100;
  const maxDepth = opts.maxDepth || 4;
  const concurrency = opts.concurrency || 5;
  const userAgent = opts.userAgent || 'Shopify-AI-Crawler/1.0 (+https://example.com)';
  const respectRobots = typeof opts.respectRobots === 'boolean' ? opts.respectRobots : true;

  const root = new URL(startUrl);
  const rootOrigin = root.origin;

  const { disallow, crawlDelay } = respectRobots ? await fetchRobotsTxt(rootOrigin, '*') : { disallow: [], crawlDelay: 0 };

  const seen = new Set();
  const pages = [];
  const queue = [{ url: startUrl, depth: 0 }];

  let active = 0;

  async function worker() {
    if (!queue.length) return;
    if (seen.size >= maxPages) return;
    const item = queue.shift();
    if (!item) return;
    const { url, depth } = item;
    if (seen.has(url)) return;
    seen.add(url);

    try {
      const u = new URL(url);
      if (u.origin !== rootOrigin) return;
      if (!isAllowedByRobots(u.pathname, disallow)) return;

      // scrape visible text and metadata (allow Puppeteer render fallback for JS-heavy sites)
      const scraped = await scrape(url, {
        maxLength: opts.perPageMaxLength || 4000,
        userAgent,
        fallbackRender: opts.fallbackRender !== undefined ? opts.fallbackRender : true,
        renderTimeout: opts.renderTimeout || 20000
      });

      // fallback if scrape returned error
      const page = {
        url,
        title: scraped.title || '',
        h1: scraped.h1 || '',
        description: scraped.description || '',
        text: scraped.text || ''
      };

      pages.push(page);

      // extract links from raw HTML for further crawling
      try {
        const resp = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': userAgent } });
        const $ = cheerio.load(resp.data);
        if (depth + 1 <= maxDepth) {
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const nu = normalizeUrl(url, href);
            if (!nu) return;
            // same-origin only
            try {
              const nuObj = new URL(nu);
              if (nuObj.origin !== rootOrigin) return;
            } catch (e) { return; }
            if (!seen.has(nu) && !queue.find(q => q.url === nu) && pages.length + queue.length < maxPages) {
              queue.push({ url: nu, depth: depth + 1 });
            }
          });
        }
      } catch (e) {
        // ignore link extraction failures
      }
    } catch (err) {
      // swallow page errors but continue
    } finally {
      // when finished, allow another worker to start
      active--;
    }
  }

  // simple concurrency loop
  const runners = [];
  while ((queue.length && seen.size < maxPages) || active > 0) {
    while (active < concurrency && queue.length && seen.size < maxPages) {
      active++;
      runners.push(worker());
    }
    // wait a short while for some workers to finish
    // apply crawlDelay if set
    const waitMs = Math.max(50, (crawlDelay && crawlDelay * 1000) || 50);
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, waitMs));
    // if we have too many runners, let them settle
    if (runners.length > 1000) await Promise.all(runners.splice(0, runners.length));
  }

  // ensure all in-flight runners finished
  await Promise.all(runners);

  // build aggregated text (respect aggregate limit)
  const aggregateLimit = opts.aggregateMaxLength || 100000; // chars
  let aggregated = '';
  for (const p of pages) {
    if (aggregated.length >= aggregateLimit) break;
    aggregated += `\n\n# ${p.url}\n${p.title ? p.title + '\n' : ''}${p.h1 ? p.h1 + '\n' : ''}${p.text}\n`;
  }

  return { pages, aggregated };
}

module.exports = { crawlSite };
