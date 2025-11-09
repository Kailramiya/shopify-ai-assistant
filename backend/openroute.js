const axios = require('axios');

const OPENROUTE_BASE = 'https://api.openrouteservice.org';

function getApiKey() {
  return process.env.OPENROUTE_API_KEY || null;
}

async function geocode(text) {
  const key = getApiKey();
  if (!key) throw new Error('OPENROUTE_API_KEY not configured');
  const url = `${OPENROUTE_BASE}/geocode/search`;
  const resp = await axios.get(url, {
    params: { text },
    headers: { Authorization: key }
  });
  return resp.data;
}

async function directions(start, end, profile = 'driving-car') {
  // start/end are [lng, lat] arrays
  const key = getApiKey();
  if (!key) throw new Error('OPENROUTE_API_KEY not configured');
  const url = `${OPENROUTE_BASE}/v2/directions/${encodeURIComponent(profile)}`;
  const body = { coordinates: [start, end] };
  const resp = await axios.post(url, body, { headers: { Authorization: key, 'Content-Type': 'application/json' } });
  return resp.data;
}

module.exports = { geocode, directions };
