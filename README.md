# ChatGPT Queue + Optimizer

Browser extension for running ChatGPT prompt queues and reducing long-chat UI overhead.

![ChatGPT Queue + Optimizer popup](docs/ui.png)

The extension combines queue controls, saved prompt sequences, automation logs, and an optional message-window optimizer in one popup.

## Supported browsers

- Google Chrome desktop: primary Manifest V3 target.
- Firefox desktop 140+: supported through the generated Firefox build and installer flow.

The bundled installers explicitly target Google Chrome and Firefox. Other Chromium browsers are not installer-supported.

The extension runs on:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## Install

### One-click installers

Windows:

```bat
Installers\Install ChatGPT Queue Optimizer.bat
```

macOS:

```bash
open "Installers/Install ChatGPT Queue Optimizer.app"
```

The installers build browser-specific packages, attempt installation for Chrome and Firefox, and write diagnostics to `build/installer.log`. If something cannot be completed automatically, they also write `build/installer-help-links.txt` with the relevant setup links.

Firefox release builds normally reject unsigned permanent add-ons. The installer tries the persistent path first and falls back to a temporary `web-ext` loader when needed.

See [Installers/README.md](Installers/README.md) for installer details and generated artifacts.

### Manual Chrome install

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository root, which contains `manifest.json`.
6. Open or reload a ChatGPT tab after installing the extension.

### Manual Firefox temporary install

The repository root is the Chrome Manifest V3 source. Build the Firefox-compatible source first:

```bash
python Installers/package_for_stores.py
```

Then:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `build/firefox-src/manifest.json`.
4. Open or reload a ChatGPT tab.

A temporary Firefox add-on is removed when Firefox restarts. Use the installer flow for its `web-ext` fallback, or a signed AMO package, when you need a longer-lived Firefox installation.

## Quick start

1. Open ChatGPT in a supported tab.
2. Open the extension popup and stay on **Queue Tool**.
3. Under **Run sequence on**, choose the ChatGPT tab you want to control. Use **Refresh** if a newly opened tab is missing.
4. Expand **Make a sequence**, enter a message, press `+`, and repeat for each step.
5. Save the sequence if you want to reuse it, then choose it from **Saved sequence**.
6. Click **Send Sequence** to start the queue.
7. Use **Running instances** to inspect active runs, stop one instance, or stop all instances.

### Send one message next

The **Send message next** field lets you insert a single prompt into the active queue. If no queue is running, the message is sent immediately.

### Sequence helper buttons

- **Copy prompt for making a sequence** copies the helper prompt used to generate a sequence externally.
- **Import prompt output** imports compatible generated sequence output back into the extension.

## Queue settings

Open the gear tab in the popup for queue settings and logs.

- **Deep research aware**: keeps queue completion detection aware of ChatGPT Deep Research flows. It is enabled by default.
- **Unlimited retry and wait**: allows the automation to keep waiting/retrying instead of stopping at the normal retry boundary. It is disabled by default.
- **Automation log**: refresh, copy, or clear the stored automation log for troubleshooting.

If you enable unlimited retry/wait, a queue can remain active for much longer during a stuck or repeatedly failing ChatGPT state.

## Optimizer

The **Optimizer Tool** limits how much conversation UI stays loaded at once in long chats.

Settings auto-save:

- **Window Size**: number of messages to keep visible, default `50`, allowed range `10-500`.
- **Batch Size**: number of messages to load at once, default `25`, allowed range `5-100`.
- **Auto-load on scroll**: loads additional messages as you scroll.
- **Toggle**: enables or disables the optimizer.

The default keyboard shortcut for toggling the optimizer is `Ctrl+Shift+Y`.

## Troubleshooting

### A ChatGPT tab does not appear in the target list

- Confirm the tab is on `chatgpt.com` or `chat.openai.com`.
- Reload the ChatGPT tab after installing or updating the extension.
- Click **Refresh** beside **Run sequence on**.

### The extension says the content script is unavailable or a command stops responding

Reload the target ChatGPT tab. Browser extensions do not retroactively inject updated content scripts into an already-open page after every install/update.

If the problem remains, disable and re-enable the extension, then reload ChatGPT again.

### A queue appears stuck

- Open the gear tab and inspect **Automation log**.
- Refresh **Running instances**.
- Stop the affected instance or use **Stop all instances** if recovery is not possible.
- Enable **Deep research aware** for queues that intentionally use Deep Research.
- Check whether **Unlimited retry and wait** is keeping a repeatedly failing job alive instead of allowing it to stop.

### Firefox will not keep the extension installed

Release Firefox normally blocks unsigned permanent extensions. Use the temporary manual flow above, the installer fallback, or a signed AMO package.

### Installer failure

Check:

- `build/installer.log`
- `build/installer-help-links.txt`

The Windows launcher can locate or install Python, Chrome, Firefox, and Node.js through `winget` when available. The macOS launcher uses existing tools and Homebrew when available.

## Store packaging

Build upload-ready archives without installing or launching a browser:

```bash
python Installers/package_for_stores.py
```

Outputs:

- `build/chatgpt-queue-optimizer-chrome-store.zip` - Chrome Web Store, Manifest V3.
- `build/chatgpt-queue-optimizer-firefox-store.zip` - Firefox AMO, Manifest V2 with Gecko metadata.
- `build/chrome-src/` - generated Chrome source directory.
- `build/firefox-src/` - generated Firefox source directory.

The Firefox package declares a minimum Firefox version of 140.0.

## Development

The repository currently has no declared npm dependencies. Tests use Node's built-in test runner.

Run the test suite with:

```bash
npm test
```

Main files:

- `manifest.json` - Chrome Manifest V3 extension manifest.
- `background.js` - service worker and queue orchestration.
- `content.js` - ChatGPT page integration.
- `popup.html` / `popup.js` - queue, settings, and optimizer UI.
- `options.html` - extension options/about page.
- `Installers/` - browser installer and store-packaging tools.

Contributor setup and validation steps are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
