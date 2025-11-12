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
// removed openroute integration per request (we'll use Gemini for LLM)
dotenv.config();

// Optional Google auth library for service-account OAuth
let GoogleAuth = null;
try { GoogleAuth = require('google-auth-library').GoogleAuth; } catch (e) { /* optional */ }

const app = express();
app.use(express.json());
// Dynamic CORS: allow requests from known shop origins or configured ALLOWED_ORIGINS
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;
app.use(cors({
  origin: function(origin, callback) {
    // allow non-browser clients (curl) with no origin
    if (!origin) return callback(null, true);
    try {
      const originHost = new URL(origin).host;
      // allow explicit allowlist
      if (allowedOrigins && (allowedOrigins.includes(origin) || allowedOrigins.includes(originHost))) return callback(null, true);
      // allow Shopify stores and dev previews (convenience) - accept any myshopify.com origin
      if (originHost && originHost.endsWith('.myshopify.com')) return callback(null, true);
      // allow if this origin maps to a stored shop
      try {
        const shopData = storage.readShopData(originHost);
        if (shopData) return callback(null, true);
      } catch (e) { /* ignore */ }
    } catch (e) { /* invalid origin, fallthrough */ }
    return callback(new Error('CORS blocked for origin: ' + origin));
  },
  credentials: true,
  // allow widget to send X-Shop-Domain and other custom headers
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
            // build index and persist combined data
            const idx = indexer.buildIndex(crawlResult.pages);
            storage.writeShopData(shop, Object.assign({}, crawlResult, { index: idx }));
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

  // Determine provider and API key. Request can pass { apiKey, provider }.
  // Default provider is 'gemini' (Google Generative) if GEMINI_API_KEY is set, otherwise fall back to OpenAI
  const provider = (req.body.provider || process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase();
  const key = apiKey || (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY);

  if (!key) {
      // Fallback: basic keyword match against scraped text
      if (contextText) {
        const qWords = question.toLowerCase().split(/\W+/).filter(Boolean);
        const sentences = contextText.split(/[\.\n]+/).map(s => s.trim()).filter(Boolean);
        // score sentences by number of matching words
        let best = { score: 0, sent: '' };
        for (const s of sentences) {
          const sl = s.toLowerCase();
          let score = 0;
          for (const w of qWords) if (w.length>2 && sl.includes(w)) score++;
          if (score > best.score) best = { score, sent: s };
        }
        if (best.score > 0) return res.json({ answer: `From the site: ${best.sent}` });
      }
  return res.json({ answer: 'No AI API key configured. Set GEMINI_API_KEY or OPENAI_API_KEY in server env, or send apiKey in the request to enable AI answers.' });
    }

    // Build prompt for LLM using any scraped context (truncate to safe size)
    const maxContext = 3000;
    const contextForPrompt = contextText ? contextText.slice(0, maxContext) : '';
    const systemPrompt = 'You are a helpful assistant that answers questions only using the provided website content when available. If the answer is not in the content, say you don\'t know.';
    const userPrompt = `Question: ${question}\n\nWebsite content:\n${contextForPrompt}`;

    let answer = null;

    if (provider === 'gemini' || provider === 'google') {
      // Use Google Generative Language API (Gemini).
      // Allow per-request override: req.body.model or req.query.model can be provided.
      // Fallback to server env GEMINI_MODEL or GOOGLE_MODEL, then to text-bison-001.
      const requestedModel = req.body?.model || req.query?.model || null;
  const modelEnvRaw = requestedModel || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || 'text-bison-001';
  // Normalize and lowercase to avoid accidental case mismatches (model ids are lowercase)
  const modelEnv = String(modelEnvRaw).toLowerCase();
  // Normalize to a models/<id> path for the REST endpoint
  const modelPath = modelEnv.startsWith('models/') ? modelEnv : `models/${modelEnv}`;
      // Helper: obtain access token from a provided service account JSON or key file
      async function getServiceAccountAccessToken() {
        try {
          if (!GoogleAuth) return null;
          const scopes = ['https://www.googleapis.com/auth/cloud-platform'];
          if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            const auth = new GoogleAuth({ credentials: creds, scopes });
            const client = await auth.getClient();
            const at = await client.getAccessToken();
            return (typeof at === 'string') ? at : (at?.token || null);
          }
          if (process.env.GOOGLE_SERVICE_ACCOUNT_PATH) {
            const auth = new GoogleAuth({ keyFilename: process.env.GOOGLE_SERVICE_ACCOUNT_PATH, scopes });
            const client = await auth.getClient();
            const at = await client.getAccessToken();
            return (typeof at === 'string') ? at : (at?.token || null);
          }
          return null;
        } catch (e) {
          console.error('service-account token error', e?.response?.data || e.message || e);
          return null;
        }
      }

      try {
        const urlBase = `https://generativelanguage.googleapis.com/v1/${modelPath}:generate`;
        let resp;
        // Try service-account OAuth first if configured
        const saToken = await getServiceAccountAccessToken();
        if (saToken) {
          resp = await axios.post(urlBase, { prompt: { text: `${systemPrompt}\n\n${userPrompt}` }, temperature: 0.2, maxOutputTokens: 512 }, { headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        } else {
          // Fallback to API key in query string
          resp = await axios.post(`${urlBase}?key=${encodeURIComponent(key)}`, { prompt: { text: `${systemPrompt}\n\n${userPrompt}` }, temperature: 0.2, maxOutputTokens: 512 }, { timeout: 20000 });
        }
        // response shape can vary; try several properties
        answer = resp?.data?.candidates?.[0]?.output || resp?.data?.candidates?.[0]?.content || resp?.data?.output || null;
      } catch (gErr) {
        const status = gErr?.response?.status || null;
        const body = gErr?.response?.data || gErr.message || String(gErr);
        console.error('gemini error', { status, body, modelEnv, modelPath });
        const suggestion = status === 404
          ? `Model not found. Confirm the model name (${modelEnv}) is available to your Google Cloud project and that the Generative API is enabled. Try setting GEMINI_MODEL to a valid model id (e.g. text-bison-001) or verify your project/key permissions.`
          : (status === 401 || status === 403)
            ? `Authentication/permission error. Ensure the API key or service-account has access and the Generative Models API is enabled for the project.`
            : `Unexpected error from Gemini. See 'body' for details.`;
        return res.status(500).json({ error: 'Gemini API error', status, body, modelEnv, modelPath, suggestion });
      }
    } else {
      // Call OpenAI Chat Completions
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 500
      }, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: 20000
      });

      answer = resp?.data?.choices?.[0]?.message?.content || null;
    }
  if (!answer) return res.status(500).json({ error: 'No answer from AI provider', raw: (typeof resp !== 'undefined' ? resp.data : null) });
    return res.json({ answer });
  } catch (err) {
    console.error('ask error', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Failed to get answer', detail: err?.response?.data || err.message });
  }
});

// Server listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));

// Debug endpoint to inspect which provider/env is configured (safe: does not return API keys)
app.get('/api/debug-provider', (req, res) => {
  try {
    const hasGemini = !!process.env.GEMINI_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || null;
    return res.json({ providerDefault: process.env.AI_PROVIDER || (hasGemini ? 'gemini' : (hasOpenAI ? 'openai' : null)), hasGemini, hasOpenAI, geminiModel });
  } catch (e) {
    return res.status(500).json({ error: 'debug error', detail: e.message });
  }
});