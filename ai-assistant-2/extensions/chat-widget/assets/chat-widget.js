/*
  Chat widget (single-file) - integrates with backend endpoints:
  - GET  /api/widget-config  -> { useStored, apiBase }
  - POST /api/scrape         -> { data }
  - POST /api/ask            -> { answer }

  The widget ensures the X-Shop-Domain header is sent with each request so the backend
  can map to stored shop data. The widget will prefer a configured backend (window.SAIA.backend)
  and will fall back to the current origin.
*/

(function () {
  const ROOT_ID = 'saia-chat-root';
  if (document.getElementById(ROOT_ID)) return;

  function onReady(cb) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') cb();
    else document.addEventListener('DOMContentLoaded', cb, { once: true });
  }

  onReady(async () => {
    // --- helpers
    function make(tag, opts = {}) {
      const el = document.createElement(tag);
      if (opts.className) el.className = opts.className;
      if (opts.type) el.type = opts.type;
      if (opts.placeholder) el.placeholder = opts.placeholder;
      if (opts.text) el.innerText = opts.text;
      if (opts.html) el.innerHTML = opts.html;
      if (opts.attrs) Object.keys(opts.attrs).forEach(k => el.setAttribute(k, opts.attrs[k]));
      return el;
    }

    function uniqueCandidates() {
      const cfg = window.SAIA && window.SAIA.backend ? String(window.SAIA.backend).replace(/\/$/, '') : null;
      const fallback = location.origin.replace(/\/$/, '');
      const out = [];
      if (cfg) out.push(cfg);
      if (!out.includes(fallback)) out.push(fallback);
      return out;
    }

    async function fetchWithFallback(path, options = {}) {
      const cands = uniqueCandidates();
      let lastErr = null;
      for (const base of cands) {
        const url = base + path;
        try {
          options.headers = options.headers || {};
          if (!options.headers['X-Shop-Domain']) options.headers['X-Shop-Domain'] = location.host;
          const res = await fetch(url, options);
          if (res.ok) return res;
          // try next if not found
          if (res.status === 404) { lastErr = new Error('404 ' + url); continue; }
          return res; // return non-OK to caller
        } catch (err) { lastErr = err; continue; }
      }
      throw lastErr || new Error('No backend candidates');
    }

    // --- build DOM
    const root = make('div', { attrs: { id: ROOT_ID }, className: 'saia-root' });

    const toggle = make('button', { className: 'saia-toggle-btn', attrs: { 'aria-label': 'Open site assistant', title: 'Open site assistant' }, text: '💬' });

    const panel = make('div', { className: 'saia-widget' });
    panel.style.display = 'none';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-hidden', 'true');

    const header = make('div', { className: 'saia-header' });
    const hTitle = make('div', { className: 'title', text: 'Site Assistant' });
    const closeBtn = make('button', { className: 'saia-toggle-close', text: '✕', attrs: { 'aria-label': 'Close chat' } });
    header.appendChild(hTitle); header.appendChild(closeBtn);

    const body = make('div', { className: 'saia-body' });
    const empty = make('div', { className: 'saia-empty', text: 'Ask a question about this site.' });
    body.appendChild(empty);

    const controls = make('div', { className: 'saia-input-wrap' });
    const input = make('input', { className: 'saia-input', attrs: { type: 'text', placeholder: 'Type your question...' } });
    const send = make('button', { className: 'saia-send', text: 'Ask', attrs: { type: 'button' } });
    controls.appendChild(input); controls.appendChild(send);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(controls);

    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);

    // --- state
    let haveScraped = false;
    let sending = false;
    let widgetCfg = { useStored: false };

    function scrollToBottom(el) {
      try { el.scrollTop = el.scrollHeight; } catch (e) { /* noop */ }
    }

    function addMsg(text, cls) {
      const el = make('div', { className: 'saia-msg' + (cls ? ' ' + cls : ''), text });
      body.appendChild(el);
      scrollToBottom(body);
      return el;
    }

    async function loadWidgetConfig() {
      try {
        const r = await fetchWithFallback('/api/widget-config', { method: 'GET' });
        if (r && r.ok) {
          const j = await r.json();
          widgetCfg = Object.assign(widgetCfg, j || {});
          if (widgetCfg.apiBase) {
            try { window.SAIA = window.SAIA || {}; window.SAIA.backend = widgetCfg.apiBase; } catch (e) {}
          }
        }
      } catch (e) {
        // non-fatal
        console.debug('widget-config failed', e.message || e);
      }
    }

    await loadWidgetConfig();

    async function doScrape() {
      if (haveScraped) return;
      try {
        const res = await fetchWithFallback('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: location.href })
        });
        if (res && res.ok) haveScraped = true;
      } catch (e) { console.debug('scrape failed', e.message || e); }
    }

    async function askQuestion(question) {
      if (!question || sending) return;
      sending = true; send.disabled = true; send.innerText = '…';
      addMsg(question, 'user');
      const typing = addMsg('Thinking…', 'assistant typing');
      try {
        const res = await fetchWithFallback('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, url: location.href, useStored: widgetCfg.useStored === true })
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          typing.remove(); addMsg('Error: ' + res.status + ' ' + txt, 'error');
        } else {
          const j = await res.json().catch(() => ({}));
          typing.remove();
          if (j.answer) addMsg(j.answer, 'assistant');
          else if (j.error) addMsg('Error: ' + j.error, 'error');
          else addMsg('No answer returned', 'error');
        }
      } catch (err) {
        typing.remove(); addMsg('Network error: ' + (err.message || err), 'error');
      } finally {
        sending = false; send.disabled = false; send.innerText = 'Ask'; input.focus();
      }
    }

    // --- events
    toggle.addEventListener('click', async () => {
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      panel.setAttribute('aria-hidden', show ? 'false' : 'true');
      if (show) { input.focus(); await doScrape(); scrollToBottom(body); }
    });
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; panel.setAttribute('aria-hidden', 'true'); });
    send.addEventListener('click', () => { askQuestion(input.value && input.value.trim()); input.value = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askQuestion(input.value && input.value.trim()); input.value = ''; } });

    // expose a runtime configure hook so the host can set backend programmatically
    window.SAIA = window.SAIA || {};
    window.SAIA.configure = function (opts) { if (!opts) return; if (opts.backend) { try { window.SAIA.backend = opts.backend; } catch (e) {} } };

  });
})();

