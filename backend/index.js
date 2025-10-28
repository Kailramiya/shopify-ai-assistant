const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const cors = require('cors');
const scraper = require("./scraper");
const shopify = require('./shopify');
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());


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
    console.log(`Installed on ${shop}`, { scope: tokenResp.scope });

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
    const { url } = req.body;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid url' });
    const data = await scraper.scrape(url);
    return res.json({ data });
  } catch (err) {
    console.error('scrape error', err);
    return res.status(500).json({ error: 'Failed to scrape' });
  }
});

// Chat API endpoint (stub)
app.post("/api/ask", async (req, res) => {
  try {
    const { question, url, apiKey } = req.body || {};

    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });

    // If a URL is provided, scrape it to get context; otherwise no context
    let contextText = '';
    if (url) {
      const scraped = await scraper.scrape(url, { maxLength: 4000 });
      if (scraped && scraped.text) contextText = scraped.text;
    }

  // Determine provider and API key. Request can pass { apiKey, provider }.
  const provider = (req.body.provider || process.env.AI_PROVIDER || 'openai').toLowerCase();
  const key = apiKey || (provider === 'gemini' || provider === 'google' ? process.env.GOOGLE_API_KEY : process.env.OPENAI_API_KEY);

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
      return res.json({ answer: 'No AI API key configured. Provide OPENAI_API_KEY in server env or send apiKey in request to enable AI answers.' });
    }

    // Build prompt for LLM using any scraped context (truncate to safe size)
    const maxContext = 3000;
    const contextForPrompt = contextText ? contextText.slice(0, maxContext) : '';
    const systemPrompt = 'You are a helpful assistant that answers questions only using the provided website content when available. If the answer is not in the content, say you don\'t know.';
    const userPrompt = `Question: ${question}\n\nWebsite content:\n${contextForPrompt}`;

    let answer = null;

    if (provider === 'gemini' || provider === 'google') {
      // Use Google Generative Language API (Gemini). This example uses the text generation
      // endpoint. The api key can be provided in the request (apiKey) or via GOOGLE_API_KEY env.
      const model = process.env.GOOGLE_MODEL || 'text-bison-001';
      try {
        const gResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1/models/${model}:generate?key=${encodeURIComponent(key)}`,
          {
            prompt: { text: `${systemPrompt}\n\n${userPrompt}` },
            temperature: 0.2,
            maxOutputTokens: 512
          },
          { timeout: 20000 }
        );
        // response shape can vary; try several properties
        answer = gResp?.data?.candidates?.[0]?.output || gResp?.data?.candidates?.[0]?.content || gResp?.data?.output || null;
      } catch (gErr) {
        console.error('gemini error', gErr?.response?.data || gErr.message || gErr);
        return res.status(500).json({ error: 'Gemini API error', detail: gErr?.response?.data || gErr.message });
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
    if (!answer) return res.status(500).json({ error: 'No answer from AI provider', raw: resp.data });
    return res.json({ answer });
  } catch (err) {
    console.error('ask error', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Failed to get answer', detail: err?.response?.data || err.message });
  }
});

// Server listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
