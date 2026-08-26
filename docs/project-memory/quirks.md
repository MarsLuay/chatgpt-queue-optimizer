# Quirks

- `{{name}}` placeholders are resolved with a prompt immediately before a sequence or queued message is sent. The variable dropdown was removed, but typed and imported placeholders still work (`popup.js`).
- A popup “Send message next” request is inserted at the front of an active queue by default; the inline Enter shortcut instead appends to the end and waits for the current response to become idle (`popup.js`, `content.js`).
- Saved sequences and the current editable message list use local storage. Optimizer settings and queue wait settings use sync storage (`popup.js`, `content.js`, `background.js`).
- The popup refreshes tab and queue status every three seconds. The optimizer can be injected on demand when a selected ChatGPT tab does not yet have the content script (`popup.js`).
- The content script waits up to 120 checks at 250 ms intervals for visible messages, then initializes even if none were found. It logs a bounded warning and retries discovery through fallback selectors (`content.js`).
- Queue diagnostics are persisted as a bounded 300-entry local list; the popup renders the newest 30 entries and truncates serialized details (`background.js`, `popup.js`).
- Closing a tab removes its in-memory queue job and updates the stored running-job snapshot (`background.js`).
