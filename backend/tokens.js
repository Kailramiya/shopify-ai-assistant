const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_FILE = path.join(__dirname, 'tokens.enc');

function getKey() {
  // expect 32-byte base64 or hex in env TOKEN_ENCRYPTION_KEY
  const k = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!k) return null;
  // allow hex or base64
  if (/^[0-9a-fA-F]+$/.test(k) && (k.length === 64)) return Buffer.from(k, 'hex');
  try { return Buffer.from(k, 'base64'); } catch (e) { return null; }
}

function encrypt(obj) {
  const key = getKey();
  const plain = JSON.stringify(obj);
  if (!key) {
    // fallback to plaintext write (not secure)
    fs.writeFileSync(TOKEN_FILE, plain, 'utf8');
    return true;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, tag, encrypted]).toString('base64');
  fs.writeFileSync(TOKEN_FILE, out, 'utf8');
  return true;
}

function decrypt() {
  if (!fs.existsSync(TOKEN_FILE)) return {};
  const key = getKey();
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
  // if key missing, assume plaintext JSON
  if (!key) {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  try {
    const data = Buffer.from(raw, 'base64');
    const iv = data.slice(0, 12);
    const tag = data.slice(12, 28);
    const encrypted = data.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    console.error('tokens decrypt failed', e.message || e);
    return {};
  }
}

function saveToken(shop, tokenObj) {
  const store = decrypt();
  store[shop] = tokenObj;
  return encrypt(store);
}

function getToken(shop) {
  const store = decrypt();
  return store[shop] || null;
}

module.exports = { saveToken, getToken };
