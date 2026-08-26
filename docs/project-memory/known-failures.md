# Known failures and limits

- Prompt submission depends on ChatGPT’s current contenteditable and send-button selectors. If either is absent or disabled, the injected send operation returns an error and the queue pauses (`background.js`).
- Response detection depends on ChatGPT’s generating, streaming, status, and error markers. An injected-script failure, a detected error/retry state, or a default ten-minute wait timeout pauses the queue (`background.js`).
- In the default wait mode, if no generating indicator appears for five seconds, the worker records that it assumed completion and advances. This is an intentional fallback but can misclassify a response when the page exposes no recognized indicator (`background.js`).
- Deep-research-aware waiting only extends the default timeout after recognized research activity has been observed. Unrecognized page wording does not extend the wait (`background.js`).
- If a worker restart finds only legacy running-job state and no recoverable durable queue, it records that the in-memory queue was lost and clears the stale state (`background.js`).
- Chrome packaging is skipped when a Chrome executable is unavailable. Firefox persistent installation can be rejected for unsigned release packages; the fallback requires a working Firefox, npm/web-ext, and profile setup (`Installers/install_chatgpt_queue_optimizer.py`, `Installers/README.md`).
- This checkout declares no package-manager manifest or automated test suite. Verification is therefore limited to source inspection, syntax checks, manifest parsing, and installer behavior checks unless a browser harness is added.
