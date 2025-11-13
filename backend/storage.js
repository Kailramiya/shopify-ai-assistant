const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function shopToFilename(shop) {
  // keep only host portion if full URL provided
  try {
    const u = new URL(shop);
    shop = u.host;
  } catch (e) {
    // not a URL, assume domain
  }
  // sanitize
  return shop.replace(/[^a-z0-9.-]/gi, '_') + '.json';
}

function filePathForShop(shop) {
  ensureDir();
  return path.join(dataDir, shopToFilename(shop));
}

function writeShopData(shop, data) {
  try {
    ensureDir();
    const fp = filePathForShop(shop);
    // merge with existing to preserve installedAt and other metadata
    let existing = null;
    try { existing = readShopData(shop) || {}; } catch (e) { existing = {}; }
    const out = Object.assign({}, existing, data, { lastCrawledAt: Date.now() });
    fs.writeFileSync(fp, JSON.stringify(out, null, 2), 'utf8');
    console.log('storage: wrote data for', shop, 'to', fp, 'pages=', (out.pages && out.pages.length) || 0);
    return true;
  } catch (e) {
    console.error('storage write error', e);
    return false;
  }
}

function readShopData(shop) {
  try {
    console.log('storage: readShopData for', shop);
    const fp = filePathForShop(shop);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('storage read error', e);
    return null;
  }
}

function listShops() {
  try {
    ensureDir();
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    const shops = files.map(f => f.replace(/\.json$/, ''));
    console.log('storage: listShops ->', shops.length, 'shops');
    return shops;
  } catch (e) {
    return [];
  }
}

function getAllShopData() {
  const shops = listShops();
  const out = {};
  for (const s of shops) {
    const fp = path.join(dataDir, s + '.json');
    try {
      out[s] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) { out[s] = null; }
  }
  return out;
}

module.exports = { writeShopData, readShopData, listShops, getAllShopData };
