# Architecture

- `manifest.json` defines a Manifest V3 browser extension. `background.js` is the service worker; `popup.html`/`popup.js` provide the main UI; `options.html` is the settings page; `content.js` and `styles.css` run on the supported ChatGPT hosts.
- `background.js` owns per-tab queue jobs in a `Map`, accepts runtime messages for start, enqueue, retry, stop, status, and diagnostics, injects prompt scripts into the selected tab, waits for response state, and records durable queue state in local storage.
- `popup.js` selects ChatGPT tabs, stores reusable messages and sequences in local storage, stores optimizer and queue settings in sync storage, resolves placeholders, and renders queue instances, status, and diagnostics through runtime messages.
- `content.js` owns the optimizer in the ChatGPT page. It discovers conversation turns through primary and fallback selectors, hides older messages, lazily restores images, adds a load-more banner, observes DOM changes, and can queue Enter-submitted text while ChatGPT is generating.
- Queue response detection in `background.js` is DOM-driven through injected functions. It recognizes generating/streaming indicators, selected error markers, and deep-research progress; prompt submission finds a contenteditable input and a supported send-button selector.
- `Installers/install_chatgpt_queue_optimizer.py` copies the extension source for packaging, creates a Firefox-specific Manifest V2 source from the Manifest V3 input, builds browser packages, and attempts persistent or temporary browser installation paths.
