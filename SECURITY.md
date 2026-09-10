# Security Policy

## Supported versions

Security fixes are provided for the latest release of ChatGPT Queue + Optimizer.

## Extension permission rationale

The extension follows a least-privilege permission policy. Every permission in `manifest.json` must have a current code path and is covered by `test/permissions.test.js`.

| Permission | Why it is required |
| --- | --- |
| `scripting` | Injects the bundled content script and stylesheet into supported ChatGPT tabs when the popup needs to initialize or repair the optimizer/automation surface. The MV3 path uses `chrome.scripting`; no remote script is fetched. |
| `storage` | Stores saved prompt sequences, queue state, diagnostics, optimizer settings, and durable queue recovery data through `chrome.storage`. |
| `alarms` | Wakes the MV3 service worker so durable queues can resume after the worker is suspended. |
| `clipboardRead` | Reads clipboard text only after the user chooses **Import prompt output** in the popup. |
| `clipboardWrite` | Writes text only for explicit copy actions such as copying the sequence-building prompt or automation logs. |

The extension intentionally does **not** request `tabs` or `activeTab`. It still uses `chrome.tabs.query`, `chrome.tabs.get`, and tab lifecycle events, but those APIs do not require the broad `tabs` permission for the extension's use. Access to URL/title data and script execution is limited by the ChatGPT host permissions below.

## Host access

Host access is limited to the two ChatGPT origins the extension supports:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

These hosts are used for the bundled content script, ChatGPT tab discovery, and script/CSS injection. No `<all_urls>` or cross-site wildcard host access is requested.

## Content security policy and remote code

Manifest V3 extension pages explicitly use:

```text
script-src 'self'; object-src 'self'
```

The extension does not opt into `unsafe-eval`, does not allow remote script origins in its extension-page CSP, and does not fetch executable JavaScript at runtime. Script injection uses bundled code or `chrome.scripting` on the two supported ChatGPT origins.

## Permission review guard

`npm test` includes a permission regression test that:

- enforces the reviewed permission and host allowlists;
- verifies each remaining permission still has a concrete source-code use;
- rejects broad host patterns;
- requires the strict MV3 extension-page CSP; and
- rejects `eval(...)` and `new Function(...)` in extension JavaScript sources.

When adding a permission, update the implementation, this rationale, and the regression test in the same change.

## Reporting a vulnerability

Please report security issues privately instead of opening a public issue.

1. Email or message the project maintainers with a clear description of the issue.
2. Include reproduction steps and impact when possible.
3. Allow reasonable time for a fix before public disclosure.

We will acknowledge valid reports and coordinate a fix and disclosure timeline.
