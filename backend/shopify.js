const crypto = require('crypto');
const axios = require('axios');

/**
 * Helper utilities for Shopify OAuth and HMAC verification.
 * Expects SHOPIFY_API_KEY and SHOPIFY_API_SECRET in environment.
 */

function buildInstallUrl(shop, scopes = 'read_products,write_script_tags', redirectUri) {
  if (!shop) throw new Error('shop domain required');
  const key = process.env.SHOPIFY_API_KEY;
  if (!key) throw new Error('SHOPIFY_API_KEY not set');
  const state = generateNonce();
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(key)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  console.log('shopify: buildInstallUrl for', shop, 'redirect=', redirectUri);
  return url;
}

function generateNonce(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function verifyHmac(query) {
  // query: object of query params from callback (req.query)
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  // Shopify says to sort params lexicographically and build query string
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const secret = process.env.SHOPIFY_API_SECRET || '';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  // Use timing-safe comparison
  const bufferA = Buffer.from(digest, 'utf8');
  const bufferB = Buffer.from(hmac, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  const ok = crypto.timingSafeEqual(bufferA, bufferB);
  console.log('shopify: verifyHmac result=', ok);
  return crypto.timingSafeEqual(bufferA, bufferB);
}

async function getAccessToken(shop, code) {
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!key || !secret) throw new Error('SHOPIFY_API_KEY/SECRET not configured');
  const url = `https://${shop}/admin/oauth/access_token`;
  console.log('shopify: exchanging code for access token for', shop);
  const resp = await axios.post(url, {
    client_id: key,
    client_secret: secret,
    code
  }, { timeout: 10000 });
  console.log('shopify: access token received for', shop);
  return resp.data; // should contain access_token and scope
}

module.exports = { buildInstallUrl, verifyHmac, getAccessToken, generateNonce };
