const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const cors = require('cors');
const scraper = require("./scraper");
const shopify = require('./shopify');
const crawler = require('./crawler');
const storage = require('./storage');
const tokens = require('./tokens');
const indexer = require('./indexer');
// This server is configured to use OpenRouter as the sole LLM provider.
dotenv.config();

// Optional HTTPS agent to reuse sockets and allow TLS tweaks. NOTE: setting
// `rejectUnauthorized: false` disables certificate verification and is a
// security risk; only use if you understand the implications (e.g. in a
// controlled test environment). It does not fix DNS resolution errors.
const https = require('https');
const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
});

// Optional: force Node's DNS resolver to use specific servers. This affects
// Node's internal resolver calls (dns.resolve etc.) but may not affect the
// OS-level getaddrinfo used by some network stacks. Use with caution.
const dns = require('dns');
if (process.env.FORCE_DNS === '1' || process.env.FORCE_DNS === 'true') {
  const servers = process.env.FORCE_DNS_SERVERS ? process.env.FORCE_DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean) : ['8.8.8.8', '1.1.1.1'];
  try {
    dns.setServers(servers);
    console.log('dns.setServers applied', servers);
  } catch (e) {
    console.warn('dns.setServers failed', e && e.message ? e.message : e);
  }
}

// Optional Google auth library for service-account OAuth (used for Gemini access)
let GoogleAuth = null;
try { GoogleAuth = require('google-auth-library').GoogleAuth; } catch (e) { /* optional */ }

const app = express();
app.use(express.json());

// Simplified and robust CORS setup
const allowedOrigins = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Dynamically add the origin to the list of allowed origins if it's a shopify domain
    // This is safe because we validate the shop and HMAC for any sensitive endpoints.
    if (/\.myshopify\.com$/.test(new URL(origin).hostname)) {
      if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
      }
    }
    
    if (allowedOrigins.length === 0) {
        // Fallback to allowing any origin if none are specified.
        // This is less secure but good for development.
        // For production, you should set ALLOWED_ORIGINS in your .env file.
        return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'X-Shop-Domain', 'X-Use-Stored', 'X-SAIA-Token', 'Authorization'],
  exposedHeaders: ['Content-Type', 'X-Shop-Domain']
}));


const shops = {};

// Health check
app.get("/", (req, res) => res.send("Shopify AI Assistant Backend!"));

// OAuth start: redirect the merchant to their shop's install URL
app.get("/api/auth/shopify", (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop || !/^([a-z0-9-]+)\.myshopify\.com$/.test(shop)) {
      return res.status(400).send('Missing or invalid shop parameter. Use {shop}.myshopify.com');
    }

    const redirectUri = process.env.SHOPIFY_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/callback`;
    const url = shopify.buildInstallUrl(shop, process.env.SHOPIFY_SCOPES || 'read_products,write_script_tags', redirectUri);
    return res.redirect(url);
  } catch (err) {
    console.error('oauth start error', err);
    return res.status(500).send('Failed to start OAuth');
  }
});

// OAuth callback: verify HMAC and exchange code for access token
app.get('/api/auth/callback', async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || !hmac) return res.status(400).send('Missing required parameters');

    const verified = shopify.verifyHmac(req.query);
    if (!verified) return res.status(400).send('HMAC verification failed');

    const tokenResp = await shopify.getAccessToken(shop, code);
    // tokenResp typically contains { access_token, scope }
  shops[shop] = { token: tokenResp.access_token, scope: tokenResp.scope, installedAt: Date.now() };
  // persist token securely (if TOKEN_ENCRYPTION_KEY provided)
  try { tokens.saveToken(shop, tokenResp); } catch (e) { console.error('save token failed', e); }
    console.log(`Installed on ${shop}`, { scope: tokenResp.scope });
    // After OAuth install, call Shopify Admin API to create ScriptTag
    await axios.post(
      `https://${shop}/admin/api/2025-07/script_tags.json`,
      {
        script_tag: {
          event: "onload",
          src: "https://localhost:5173/ChatWidget.js"
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': tokenResp.access_token,
          'Content-Type': 'application/json'
        }
      }
    );

    // Optionally perform a background crawl of the storefront to index pages.
    // Enable by setting AUTO_CRAWL_ON_INSTALL=true in env. This runs async and stores results in memory (shops[shop].pages).
    try {
      if (process.env.AUTO_CRAWL_ON_INSTALL === 'true') {
        (async () => {
          try {
            const site = `https://${shop}`;
            const crawlOpts = {
              maxPages: parseInt(process.env.CRAWL_MAX_PAGES || '100', 10),
              maxDepth: parseInt(process.env.CRAWL_MAX_DEPTH || '4', 10),
              concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '5', 10),
              perPageMaxLength: parseInt(process.env.CRAWL_PER_PAGE_MAX || '4000', 10),
              aggregateMaxLength: parseInt(process.env.CRAWL_AGGREGATE_MAX || '100000', 10),
              respectRobots: true
            };
            const crawlResult = await crawler.crawlSite(site, crawlOpts);
            shops[shop].pages = crawlResult.pages;
            shops[shop].aggregated = crawlResult.aggregated;
            // build index and persist combined data (include installedAt metadata)
            const idx = indexer.buildIndex(crawlResult.pages);
            storage.writeShopData(shop, Object.assign({}, crawlResult, { index: idx, installedAt: shops[shop].installedAt }));
            console.log(`Crawl finished for ${shop}: pages=${crawlResult.pages.length}`);
          } catch (e) { console.error('background crawl error', e); }
        })();
      }
    } catch (e) { console.error('auto crawl schedule error', e); }

    // For a real app, redirect to the embedded admin UI. For now, show success.
    return res.send(`App installed on ${shop}. You can close this window.`);
  } catch (err) {
    console.error('oauth callback error', err?.response?.data || err.message || err);
    return res.status(500).send('OAuth callback error');
  }
});

// Scrape endpoint (simplified). Expects JSON { url }
app.post("/api/scrape", async (req, res) => {
  try {
    const { url, crawl, maxPages, maxDepth, concurrency } = req.body;
    console.log('/api/scrape: request', { url, crawl, maxPages, maxDepth, concurrency });
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid url' });

  if (crawl) {
      // Crawl the whole site (same-origin), return aggregated content and per-page metadata
      const opts = {
        maxPages: maxPages || parseInt(process.env.CRAWL_MAX_PAGES || '100', 10),
        maxDepth: maxDepth || parseInt(process.env.CRAWL_MAX_DEPTH || '4', 10),
        concurrency: concurrency || parseInt(process.env.CRAWL_CONCURRENCY || '5', 10),
        perPageMaxLength: parseInt(process.env.CRAWL_PER_PAGE_MAX || '4000', 10),
        aggregateMaxLength: parseInt(process.env.CRAWL_AGGREGATE_MAX || '100000', 10),
        respectRobots: true
      };
      const result = await crawler.crawlSite(url, opts);
      // build index for result and persist optionally if shop host detected
      try {
        const idx = indexer.buildIndex(result.pages);
        // if it's a shop host, persist
        try {
          const host = new URL(url).host;
          storage.writeShopData(host, Object.assign({}, result, { index: idx }));
        } catch (e) { /* ignore non-host URLs */ }
        result.index = idx;
      } catch (e) { console.error('index build failed', e); }
      return res.json({ data: result });
    }

    const data = await scraper.scrape(url);
    return res.json({ data });
  } catch (err) {
    console.error('scrape error', err);
    return res.status(500).json({ error: 'Failed to scrape' });
  }
});

// Chat API endpoint (stub)

// Store results in memory for now (replace with DB if needed)
let storeScrapeCache = {};

app.post('/api/scrape-store', async (req, res) => {
  const { baseUrl } = req.body;
  console.log('/api/scrape-store: request', { baseUrl });
  if (!baseUrl || !/^https?:\/\/.+myshopify\.com/.test(baseUrl)) {
    return res.status(400).json({ error: "Invalid Shopify store URL" });
  }
  try {
    const crawlOpts = { maxPages: 50, maxDepth: 3, concurrency: 4, respectRobots: true };
    const result = await crawler.crawlSite(baseUrl, crawlOpts);
    // build index and persist
    const idx = indexer.buildIndex(result.pages);
    const host = new URL(baseUrl).host;
    storage.writeShopData(host, Object.assign({}, result, { index: idx }));
    storeScrapeCache[baseUrl] = result;
    return res.json({ status: 'Store scraped', pageCount: result.pages.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// Widget config endpoint - returns whether the store has stored aggregated content
app.get('/api/widget-config', (req, res) => {
  try {
    // determine shop from header or origin
    const shop = req.get('X-Shop-Domain') || (req.get('Origin') ? new URL(req.get('Origin')).host : null);
    console.log('/api/widget-config: shop detected', shop);
    let cfg = { apiBase: process.env.PUBLIC_APP_URL || '', useStored: false };
    if (shop) {
      const data = storage.readShopData(shop);
      if (data && data.aggregated && data.aggregated.length > 100) cfg.useStored = true;
    }
    return res.json(cfg);
  } catch (e) {
    console.error('widget-config error', e);
    return res.json({ apiBase: process.env.PUBLIC_APP_URL || '', useStored: false });
  }
});

// Serve widget asset in dev if available (convenience)
const fs = require('fs');
const path = require('path');
app.get('/widget/chat-widget.js', (req, res) => {
  // search likely paths relative to backend folder
  const candidates = [
    path.join(__dirname, '..', 'ai-assistant-1', 'extensions', 'chat-widget', 'assets', 'chat-widget.js'),
    path.join(__dirname, '..', 'extensions', 'chat-widget', 'assets', 'chat-widget.js')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return res.type('application/javascript').send(fs.readFileSync(p, 'utf8'));
    }
  }
  return res.status(404).send('Not found');
});

// Endpoint to fetch stored data for a shop
  app.get('/api/store-data', (req, res) => {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: 'shop query param required' });
    const data = storage.readShopData(shop);
    if (!data) return res.status(404).json({ error: 'No stored data for shop' });
    return res.json({ data });
  });

  // Search endpoint using built index
  app.get('/api/search', (req, res) => {
    const { shop, q } = req.query;
    if (!shop || !q) return res.status(400).json({ error: 'shop and q required' });
    const data = storage.readShopData(shop);
    if (!data || !data.index) return res.status(404).json({ error: 'No index for shop' });
    const term = q.toLowerCase().trim();
    const postings = data.index[term] || [];
    return res.json({ results: postings.slice(0, 20) });
  });







app.post("/api/ask", async (req, res) => {
  try {
    const { question, url, apiKey } = req.body || {};
    console.log('API ask received', { question: question ? question.slice(0,30) : null, url });
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });

    // If useStored=true, prefer server-side persisted aggregated content for the shop
    const useStored = req.body.useStored === true || req.get('X-Use-Stored') === '1';
    let contextText = '';
    if (useStored) {
      try {
        const shopHeader = req.get('X-Shop-Domain');
        const originHost = req.get('Origin') ? new URL(req.get('Origin')).host : null;
        const urlHost = url ? (new URL(url).host) : null;
        const shop = shopHeader || urlHost || originHost;
        if (shop) {
          const data = storage.readShopData(shop);
          if (data && data.aggregated) contextText = data.aggregated;
        }
      } catch (e) { console.error('useStored fetch error', e); }
    }
    // Fallback to live scrape when not using stored context
    if (!contextText && url) {
      try {
        const scraped = await scraper.scrape(url, { maxLength: 4000, renderFallback: true });
        if (scraped && scraped.text) contextText = scraped.text;
      } catch (e) { console.error('live scrape error', e); }
    }

  // Determine available providers and keys
    const providedApiKey = apiKey || null;
    const hasOpenRouter = !!(providedApiKey || process.env.OPENROUTER_API_KEY);
    const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    let provider = req.body?.provider || process.env.AI_PROVIDER || (hasGemini ? 'gemini' : (hasOpenRouter ? 'openrouter' : null));
    console.log('/api/ask: provider selection', { provider, hasGemini, hasOpenRouter, useStored });

    if (!provider) {
      // Fallback: basic keyword match against scraped text
      if (contextText) {
        const qWords = question.toLowerCase().split(/\W+/).filter(Boolean);
        const sentences = contextText.split(/[\.\n]+/).map(s => s.trim()).filter(Boolean);
        let best = { score: 0, sent: '' };
        for (const s of sentences) {
          const sl = s.toLowerCase();
          let score = 0;
          for (const w of qWords) if (w.length > 2 && sl.includes(w)) score++;
          if (score > best.score) best = { score, sent: s };
        }
        if (best.score > 0) return res.json({ answer: `From the site: ${best.sent}` });
      }
      return res.json({ answer: 'No AI provider configured. Set GEMINI or OPENROUTER credentials in server env, or send apiKey in the request.' });
    }

    // Build prompt for LLM using any scraped context (truncate to safe size)
    const maxContext = 3000;
    const contextForPrompt = contextText ? contextText.slice(0, maxContext) : '';
    const systemPrompt = 'You are a helpful assistant that answers questions only using the provided website content when available. If the answer is not in the content, say you don\'t know.';
    const userPrompt = `Question: ${question}\n\nWebsite content:\n${contextForPrompt}`;

    let answer = null;

    // Prefer Gemini (Google Generative) if available, otherwise OpenRouter
    if (provider === 'gemini') {
      try {
        const requestedModel = req.body?.model || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || 'text-bison-001';
        const modelEnv = String(requestedModel).toLowerCase();
        const modelPath = modelEnv.startsWith('models/') ? modelEnv : `models/${modelEnv}`;
        const urlBase = `https://generativelanguage.googleapis.com/v1/${modelPath}:generate`;
        // prepare request body for Gemini
        const geminiBody = { prompt: { text: `${systemPrompt}\n\n${userPrompt}` }, temperature: 0.2, maxOutputTokens: 512 };

        // Try service-account token first (preferred)
        let respGemini = null;
        let saToken = null;
        try {
          if (GoogleAuth) {
            const scopes = ['https://www.googleapis.com/auth/cloud-platform'];
            if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
              const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
              const auth = new GoogleAuth({ credentials: creds, scopes });
              const client = await auth.getClient();
              const at = await client.getAccessToken();
              saToken = (typeof at === 'string') ? at : (at?.token || null);
            } else if (process.env.GOOGLE_SERVICE_ACCOUNT_PATH) {
              const auth = new GoogleAuth({ keyFilename: process.env.GOOGLE_SERVICE_ACCOUNT_PATH, scopes });
              const client = await auth.getClient();
              const at = await client.getAccessToken();
              saToken = (typeof at === 'string') ? at : (at?.token || null);
            }
          }
        } catch (e) { saToken = null; }

        if (saToken) {
          respGemini = await axios.post(urlBase, geminiBody, { headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        } else if (process.env.GEMINI_API_KEY) {
          respGemini = await axios.post(`${urlBase}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, geminiBody, { timeout: 20000 });
        } else {
          throw new Error('No Gemini credentials available');
        }

        answer = respGemini?.data?.candidates?.[0]?.output || respGemini?.data?.candidates?.[0]?.content || respGemini?.data?.output || null;
      } catch (gErr) {
        console.error('gemini error', gErr?.response?.data || gErr.message || gErr);
        // If Gemini had a network/DNS error and OpenRouter is available, try OpenRouter as fallback
        const netCodes = ['ENOTFOUND','ECONNREFUSED','ENETUNREACH','EAI_AGAIN'];
        const isNetworkErr = gErr && (netCodes.includes(gErr.code) || (gErr.message && (gErr.message.includes('getaddrinfo') || gErr.message.includes('ENOTFOUND'))));
        if (isNetworkErr && (process.env.OPENROUTER_API_KEY || providedApiKey)) {
          console.log('gemini: network error detected, falling back to OpenRouter');
          // perform OpenRouter call
          try {
            const model = req.body?.model || process.env.OPENROUTER_MODEL || 'gpt-4o-mini';
            const baseOpenRouterUrl = 'https://api.openrouter.ai/v1/chat/completions';
            const openrouterUrl = (process.env.OPENROUTER_RELAY_PREFIX || '') + baseOpenRouterUrl;
            const routerKey = providedApiKey || process.env.OPENROUTER_API_KEY;
            const resp = await axios.post(openrouterUrl, {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ],
              temperature: 0.2,
              max_tokens: 500
            }, {
              headers: { Authorization: `Bearer ${routerKey}`, 'Content-Type': 'application/json' },
              httpsAgent: defaultHttpsAgent,
              timeout: 20000
            });
            answer = resp?.data?.choices?.[0]?.message?.content || resp?.data?.choices?.[0]?.message || resp?.data?.choices?.[0]?.text || null;
            if (typeof answer === 'object' && answer?.length) answer = Array.isArray(answer) ? answer.map(a => a?.text || a).join('\n') : (answer?.text || JSON.stringify(answer));
          } catch (orErr) {
            console.error('openrouter fallback error', orErr?.response?.data || orErr.message || orErr);
            return res.status(502).json({ error: 'Gemini failed and OpenRouter fallback failed', detail: orErr?.response?.data || orErr.message });
          }
        } else {
          return res.status(502).json({ error: 'Gemini API error', detail: gErr?.response?.data || gErr.message });
        }
      }
    } else {
      // OpenRouter primary branch
      try {
        const model = req.body?.model || process.env.OPENROUTER_MODEL || 'gpt-4o-mini';
        console.log('openrouter: request model=', model);
        const baseOpenRouterUrl = 'https://api.openrouter.ai/v1/chat/completions';
        const openrouterUrl = (process.env.OPENROUTER_RELAY_PREFIX || '') + baseOpenRouterUrl;
        console.log('openrouter: using URL', openrouterUrl);
        const routerKey = providedApiKey || process.env.OPENROUTER_API_KEY;
        const resp = await axios.post(openrouterUrl, {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 500
        }, {
          headers: { Authorization: `Bearer ${routerKey}`, 'Content-Type': 'application/json' },
          httpsAgent: defaultHttpsAgent,
          timeout: 20000
        });
        answer = resp?.data?.choices?.[0]?.message?.content || resp?.data?.choices?.[0]?.message || resp?.data?.choices?.[0]?.text || null;
        if (typeof answer === 'object' && answer?.length) answer = Array.isArray(answer) ? answer.map(a => a?.text || a).join('\n') : (answer?.text || JSON.stringify(answer));
      } catch (orErr) {
        console.error('openrouter error', orErr?.response?.data || orErr.message || orErr);
        return res.status(502).json({ error: 'OpenRouter API error', detail: orErr?.response?.data || orErr.message });
      }
    }
    // Only OpenRouter provider is supported in this deployment. Other providers removed.
  if (!answer) return res.status(500).json({ error: 'No answer from AI provider', raw: (typeof resp !== 'undefined' ? resp.data : null) });
    return res.json({ answer });
  } catch (err) {
    console.error('ask error', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Failed to get answer', detail: err?.response?.data || err.message });
  }
});

// Server listen
const PORT = process.env.PORT || 3000;
// Simple scheduled crawler: runs periodically and re-crawls shops older than threshold
const crawlingShops = {};

async function performCrawlForShop(shop) {
  if (crawlingShops[shop]) return;
  crawlingShops[shop] = true;
  try {
    console.log(`Scheduled crawl starting for ${shop}`);
    const site = `https://${shop}`;
    const crawlOpts = {
      maxPages: parseInt(process.env.CRAWL_MAX_PAGES || '100', 10),
      maxDepth: parseInt(process.env.CRAWL_MAX_DEPTH || '4', 10),
      concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '5', 10),
      perPageMaxLength: parseInt(process.env.CRAWL_PER_PAGE_MAX || '4000', 10),
      aggregateMaxLength: parseInt(process.env.CRAWL_AGGREGATE_MAX || '100000', 10),
      respectRobots: true
    };
    const result = await crawler.crawlSite(site, crawlOpts);
    const idx = indexer.buildIndex(result.pages);
    // persist; storage.writeShopData will merge existing installedAt
    storage.writeShopData(shop, Object.assign({}, result, { index: idx }));
    console.log(`Scheduled crawl finished for ${shop}: pages=${result.pages.length}`);
  } catch (e) {
    console.error(`Scheduled crawl failed for ${shop}`, e);
  } finally {
    crawlingShops[shop] = false;
  }
}

async function runScheduledCrawls() {
  try {
    const thresholdDays = parseInt(process.env.CRAWL_THRESHOLD_DAYS || '7', 10);
    const now = Date.now();
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
    const shopFiles = storage.listShops();
    for (const sf of shopFiles) {
      // sf is the filename (without .json) as produced by listShops(), which returns sanitized names
      const data = storage.readShopData(sf);
      if (!data) continue;
      const last = data.lastCrawledAt || data.installedAt || 0;
      if (!last || (now - last) >= thresholdMs) {
        // Kick off crawl but don't block the loop (perform sequentially to avoid overload)
        // We'll await to pace things, but protect from long-running overlap via crawlingShops
        await performCrawlForShop(sf);
      }
    }
  } catch (e) { console.error('runScheduledCrawls error', e); }
}

function startCrawlScheduler() {
  const intervalHours = parseInt(process.env.CRAWL_CHECK_INTERVAL_HOURS || '24', 10);
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
  // Run once on startup (but non-blocking)
  setTimeout(() => { runScheduledCrawls(); }, 5 * 1000);
  // Then schedule regularly
  setInterval(() => { runScheduledCrawls(); }, intervalMs);
}

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
  try { startCrawlScheduler(); } catch (e) { console.error('failed to start crawl scheduler', e); }
});

// Debug endpoint to inspect which provider/env is configured (safe: does not return API keys)
app.get('/api/debug-provider', (req, res) => {
  try {
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const openrouterModel = process.env.OPENROUTER_MODEL || null;
    const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    const geminiModel = process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || null;
    const providerDefault = process.env.AI_PROVIDER || (hasGemini ? 'gemini' : (hasOpenRouter ? 'openrouter' : null));
    return res.json({ providerDefault, hasOpenRouter, hasGemini, openrouterModel, geminiModel });
  } catch (e) {
    return res.status(500).json({ error: 'debug error', detail: e.message });
  }
});
