# Decisions

- Queue ownership is keyed by ChatGPT tab ID, allowing independent queues while preventing a second sequence from starting on a tab that already has a running or paused queue (`background.js`).
- A command is not completed until `waitForTabResponse()` observes the response cycle or applies its explicit fallback. Failed send/wait phases pause the queue; the retry setting can requeue the current command after a 15-second delay (`background.js`).
- Queue state is persisted in local storage and periodically woken with an alarms entry. On worker wake, an unconfirmed `sending` or `retry-wait` command is put back at the front before processing resumes (`background.js`).
- The optimizer uses layered selectors and fallback discovery because the page is controlled by ChatGPT. Its windowing keeps at least eight recent messages visible and caps the discovered message set at 1,200 (`content.js`).
- Extension API helpers try callback and promise forms so popup, content, and background code can use the same operations across supported browser API variants (`popup.js`, `content.js`, `background.js`).
- The installer converts the source manifest for Firefox and uses a temporary `web-ext` loader when a release Firefox rejects an unsigned persistent package (`Installers/install_chatgpt_queue_optimizer.py`, `README.md`).
