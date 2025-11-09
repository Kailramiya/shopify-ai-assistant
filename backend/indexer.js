// indexer.js - simple inverted index builder

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length > 2);
}

function buildIndex(pages) {
  // pages: [{url, title, h1, text}]
  const index = {}; // token -> { url -> count }
  for (const p of pages) {
    const body = `${p.title || ''} ${p.h1 || ''} ${p.text || ''}`;
    const toks = tokenize(body);
    const counts = {};
    for (const t of toks) counts[t] = (counts[t] || 0) + 1;
    for (const [t, c] of Object.entries(counts)) {
      index[t] = index[t] || [];
      index[t].push({ url: p.url, count: c });
    }
  }
  // sort postings by count desc
  for (const t of Object.keys(index)) {
    index[t].sort((a, b) => b.count - a.count);
  }
  return index;
}

module.exports = { buildIndex };
