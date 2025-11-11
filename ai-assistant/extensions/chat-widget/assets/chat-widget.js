(function() {
  // Avoid multiple mounts
  if (document.getElementById('shopify-chat-widget-root')) return;
(function () {
  // Minimal, dependency-free chat widget (vanilla JS)
  const ROOT_ID = 'saia-chat-root';
  if (document.getElementById(ROOT_ID)) return; // avoid double injection

  function onReady(cb) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') cb();
    else document.addEventListener('DOMContentLoaded', cb, { once: true });
  }

  onReady(async () => {
    // helper: smooth scroll body to bottom (use rAF to avoid layout race)
    function scrollBodyToBottom() {
      requestAnimationFrame(() => {
        try {
          body.scrollTop = body.scrollHeight;
        } catch (e) { /* noop */ }
      });
    }

    // Root container
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'saia-root';

    // Floating button
    const button = document.createElement('button');
    button.className = 'saia-btn';
    button.type = 'button';
    button.title = 'Open chat';
    button.innerText = '💬';

    // Panel
    const panel = document.createElement('div');
    panel.className = 'saia-panel';
    panel.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'saia-header';
    const title = document.createElement('strong');
    title.innerText = 'Site Assistant';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'saia-close';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.innerText = '✕';
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body (answer area)
    const body = document.createElement('div');
    body.className = 'saia-body';
    const hint = document.createElement('div');
    hint.className = 'saia-msg';
    hint.innerText = 'Ask a question about this site.';
    body.appendChild(hint);

    // Controls
    const controls = document.createElement('div');
    controls.className = 'saia-controls';
    const input = document.createElement('input');
    input.className = 'saia-input';
    input.type = 'text';
    input.placeholder = 'Type your question...';
    const send = document.createElement('button');
    send.className = 'saia-send';
    send.type = 'button';
    send.innerText = 'Ask';
    controls.appendChild(input);
    controls.appendChild(send);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(controls);

    root.appendChild(button);
    root.appendChild(panel);
    document.body.appendChild(root);

    // State
    let scraped = false;
    let isSending = false;

    // Determine backend base(s). The widget may be served from the store origin, but the API
    // usually lives on your backend (ngrok / deployed domain). We try the configured backend
    // first (window.SAIA.backend) then fall back to location.origin. If a request returns 404
    // from the store (because the API is not hosted there), and a separate backend is configured,
    // we automatically retry against that backend.
    const CONFIG_BACKEND = (window.SAIA && window.SAIA.backend) || window.SHOPIFY_AI_BACKEND || window.SAIA_BACKEND || null;
    const DEFAULT_BACKEND = location.origin;

    function apiCandidates() {
      const list = [];
      if (CONFIG_BACKEND) list.push(CONFIG_BACKEND.replace(/\/$/, ''));
      if (DEFAULT_BACKEND && !list.includes(DEFAULT_BACKEND.replace(/\/$/, ''))) list.push(DEFAULT_BACKEND.replace(/\/$/, ''));
      return list;
    }

    async function fetchWithFallback(path, options) {
      const candidates = apiCandidates();
      let lastErr = null;
      for (const base of candidates) {
        const url = base + path;
        try {
          // ensure we send shop header so backend can map to stored data
          options = options || {};
          options.headers = options.headers || {};
          if (!options.headers['X-Shop-Domain']) options.headers['X-Shop-Domain'] = location.host;
          const resp = await fetch(url, options);
          if (resp.ok) return resp;
          // If not found (404) and there is another candidate, try next
          if (resp.status === 404) {
            lastErr = new Error('404 from ' + url);
            continue;
          }
          // For other statuses, return the response (so caller can handle)
          return resp;
        } catch (err) {
          lastErr = err;
          continue;
        }
      }
      // All candidates failed
      if (lastErr) throw lastErr;
      throw new Error('No backend candidates available');
    }

    function appendMessage(text, cls) {
      const el = document.createElement('div');
      el.className = 'saia-msg' + (cls ? ' ' + cls : '');
      el.textContent = text;
      body.appendChild(el);
      // ensure the newly added element and input are visible
      try {
        // scroll the new element into view, then ensure body is at bottom
        el.scrollIntoView({ block: 'end', behavior: 'smooth' });
      } catch (e) { /* ignore */ }
      scrollBodyToBottom();
    }

    async function doScrapeIfNeeded() {
      if (scraped) return;
      try {
        const currentUrl = location.href;
        const resp = await fetchWithFallback('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: currentUrl })
        });
        if (resp && resp.ok) scraped = true;
      } catch (err) {
        // non-fatal; log for debugging
        console.error('Scrape error', err);
      }
    }

    // widget configuration from server (useStored flag, apiBase override)
    let widgetCfg = { useStored: false };
    async function loadWidgetConfig() {
      try {
        const r = await fetchWithFallback('/api/widget-config', { method: 'GET' });
        if (r && r.ok) {
          const j = await r.json();
          widgetCfg = Object.assign(widgetCfg, j || {});
          if (widgetCfg.apiBase) {
            // prefer injected apiBase if server indicates it
            try { window.SAIA = window.SAIA || {}; window.SAIA.backend = widgetCfg.apiBase; } catch (e) {}
          }
        }
      } catch (e) { /* ignore */ }
    }

    await loadWidgetConfig();

    async function doAsk() {
      const q = input.value && input.value.trim();
      if (!q || isSending) return;
      appendMessage(q, 'user');
      input.value = '';
      isSending = true;
      send.disabled = true;
      send.innerText = '…';
      // add a typing indicator element in the assistant area while request is in flight
      let typingEl = document.createElement('div');
      typingEl.className = 'saia-msg assistant typing';
      typingEl.textContent = 'Thinking…';
  body.appendChild(typingEl);
  // ensure typing element is visible (align to bottom)
  try { typingEl.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (e) {}
  // fallback ensure (small delay to avoid race)
  requestAnimationFrame(() => { setTimeout(scrollBodyToBottom, 40); });
      try {
        console.log('backend url', apiCandidates());
        console.log('url', location.href);
        const resp = await fetchWithFallback('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, url: location.href, useStored: widgetCfg.useStored === true })
        });
        if (!resp.ok) {
          const t = await resp.text();
          // remove typing indicator then show error
          if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
          appendMessage('Error: ' + resp.status + ' ' + t, 'error');
        } else {
          const j = await resp.json();
          // remove typing indicator and append the assistant answer
          if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
          if (j.answer) appendMessage(j.answer, 'assistant');
          else if (j.error) appendMessage('Error: ' + j.error, 'error');
          else appendMessage('No answer returned', 'error');
          // restore focus to input so controls remain visible
          try { input.focus(); } catch (e) {}
        }
      } catch (err) {
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        appendMessage('Network error: ' + (err.message || err), 'error');
        try { input.focus(); } catch (e) {}
      } finally {
        isSending = false;
        send.disabled = false;
        send.innerText = 'Ask';
      }
    }

    // Events
    button.addEventListener('click', async () => {
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      if (show) {
        input.focus();
        await doScrapeIfNeeded();
        // after opening, scroll to last message so input is visible
        scrollBodyToBottom();
      }
    });
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    send.addEventListener('click', doAsk);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAsk(); });

    // expose a runtime configure hook
    window.SAIA = window.SAIA || {};
    window.SAIA.configure = function (opts) {
      if (!opts) return;
      if (opts.backend) {
        try { window.SAIA.backend = opts.backend; } catch (e) { /* noop */ }
      }
    };
  });
})();
  const askBtn = document.createElement('button');
  askBtn.innerText = 'Ask';
  askBtn.type = 'button';
  askBtn.className = 'shopify-chat-ask';
  chatBox.appendChild(askBtn);

  // Answer div
  const answerDiv = document.createElement('div');
  answerDiv.className = 'shopify-chat-answer';
  chatBox.appendChild(answerDiv);

  // Helper state
  let loading = false;
  let scraped = false;

  // Set default backend API URL, update if needed
  const API_BASE = window.SAIA?.backend || window.SHOPIFY_AI_BACKEND || window.SAIA_BACKEND || location.origin;

  // Scrape page on open
  function scrapeCurrentPage() {
    if (scraped) return;
    fetch(`${API_BASE}/api/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shop-Domain": location.host },
      body: JSON.stringify({ url: window.location.href }),
    }).then(() => {
      scraped = true;
    }).catch((err) => {
      console.error("Scrape error:", err);
    });
  }

  // Toggle open/close UI
  toggleButton.onclick = function() {
    if (chatBox.style.display === 'none') {
      chatBox.style.display = 'block';
      scrapeCurrentPage();
    } else {
      chatBox.style.display = 'none';
      input.value = '';
      answerDiv.innerHTML = '';
      scraped = false;
    }
  };
  closeBtn.onclick = function() {
    chatBox.style.display = 'none';
    input.value = '';
    answerDiv.innerHTML = '';
    scraped = false;
  };

  // Ask question logic
  askBtn.onclick = function() {
    if (!input.value.trim() || loading) return;
    loading = true;
    askBtn.innerText = 'Thinking…';
    // show typing/thinking placeholder in the answer area and ensure scrolling
    answerDiv.innerHTML = `<div class="shopify-chat-typing">Thinking<span class="dots">…</span></div>`;
    // ensure chatBox scrolls to show the typing placeholder and input (use rAF + tiny delay)
    try { requestAnimationFrame(() => { setTimeout(() => { if (chatBox) chatBox.scrollTop = chatBox.scrollHeight; }, 30); }); } catch (e) {}

    fetch(`${API_BASE}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shop-Domain": location.host },
      body: JSON.stringify({ question: input.value, url: window.location.href }),
    })
      .then(res => res.json())
        .then(data => {
          answerDiv.innerHTML = `<strong>Answer:</strong> <div>${data.answer || 'No answer received'}</div>`;
          try { requestAnimationFrame(() => { setTimeout(() => { if (chatBox) chatBox.scrollTop = chatBox.scrollHeight; }, 30); }); } catch (e) {}
          try { input.focus(); } catch (e) {}
        })
      .catch(err => {
        answerDiv.innerHTML = `<strong>Answer:</strong> <div>Error: ${err.message}</div>`;
        try { input.focus(); } catch (e) {}
      })
      .finally(() => {
        loading = false;
        askBtn.innerText = 'Ask';
      });
  };
})();

