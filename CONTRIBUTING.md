# Contributing to ChatGPT Queue + Optimizer

Thanks for your interest in contributing.

## Prerequisites

For normal extension development you need:

- Git.
- Node.js with the built-in `node --test` test runner.
- Google Chrome for testing the primary Manifest V3 build.
- Python 3 only when building browser/store packages or generating the Firefox source.
- Firefox 140+ when testing the generated Firefox build.

The repository currently declares no npm dependencies, so there is no required `npm install` step for the existing test suite.

## Development setup

Clone the repository and enter it:

```bash
git clone https://github.com/MarsLuay/chatgpt-queue-optimizer.git
cd chatgpt-queue-optimizer
```

Run the automated tests:

```bash
npm test
```

`npm test` maps to Node's built-in test runner (`node --test`). There is currently no configured lint script, so do not assume an `npm run lint` command exists.

### Load the development build in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository root, which contains `manifest.json`.
5. Reload any already-open ChatGPT tabs after loading or updating the extension.

### Generate and load the Firefox build

The checked-in root manifest is the Chrome Manifest V3 source. Generate the Firefox-compatible source with:

```bash
python Installers/package_for_stores.py
```

Then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `build/firefox-src/manifest.json`.

The generated Firefox package requires Firefox 140 or newer. Temporary add-ons are removed when Firefox restarts.

## Project map

- `manifest.json` - primary Chrome Manifest V3 manifest.
- `background.js` - service worker and queue orchestration.
- `background.test.js` - Node tests for background behavior.
- `content.js` - ChatGPT page integration and DOM interaction.
- `utils.js` - shared extension utilities.
- `popup.html` / `popup.js` - queue, settings, logging, and optimizer UI.
- `options.html` - extension options/about page.
- `Installers/` - Chrome/Firefox installer and packaging tools.

## Validation before a pull request

Always run:

```bash
npm test
```

Also manually exercise the area you changed:

- Queue changes: run a multi-message sequence, use **Send message next**, and verify stop/instance controls and the automation log.
- ChatGPT integration changes: test on a supported `chatgpt.com` page and reload the page after updating the unpacked extension.
- Deep Research handling: test with **Deep research aware** both enabled and disabled when relevant.
- Retry behavior: verify normal retry limits and **Unlimited retry and wait** when the change touches waiting/recovery logic.
- Optimizer changes: test toggle behavior, window size, batch size, and auto-load on scroll.
- Installer changes: run the platform-specific installer path you modified, or at minimum run the store-packaging command when the change is packaging-only.

Document any validation you could not perform in the pull request description.

## Store packaging

Build upload-ready archives without launching or modifying a browser:

```bash
python Installers/package_for_stores.py
```

This produces:

- `build/chatgpt-queue-optimizer-chrome-store.zip`
- `build/chatgpt-queue-optimizer-firefox-store.zip`
- `build/chrome-src/`
- `build/firefox-src/`

See [Installers/README.md](Installers/README.md) for installer behavior and browser-specific limitations.

## Pull requests

- Keep changes focused on one problem or closely related set of changes.
- Explain the motivation and user-visible effect in the PR description.
- Link the relevant issue when one exists.
- Add or update tests when behavior changes.
- Update documentation when commands, settings, supported browsers, or user workflows change.
- State which browser(s) and flows you tested.

## Code of conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
