# Installers

Installer and packaging tools for ChatGPT Queue + Optimizer.

## Files

- `Install ChatGPT Queue Optimizer.bat` - Windows launcher.
- `Install ChatGPT Queue Optimizer.app` - macOS launcher.
- `install_chatgpt_queue_optimizer.py` - shared Chrome/Firefox installation helper used by the launchers.
- `package_for_stores.py` - builds upload-ready Chrome Web Store and Firefox AMO archives without installing or launching a browser.
- `upload_extension.py` - submits a listed Firefox update to AMO and starts an isolated local Firefox test.
- `../upload.bat` and `../upload.app` - Windows and macOS upload launchers.

## One-click install

Windows:

```bat
Installers\Install ChatGPT Queue Optimizer.bat
```

macOS:

```bash
open "Installers/Install ChatGPT Queue Optimizer.app"
```

Both launchers ultimately call `install_chatgpt_queue_optimizer.py` against the repository root.

## Submit a Firefox update and test it locally

Run `upload.bat` on Windows or open `upload.app` on macOS. These launchers are separate from the regular installer and:

1. Rebuild the store-ready packages and validate the Firefox add-on ID and version.
2. Start `web-ext run` with the generated Firefox source in a separate temporary profile. This local test starts before the store submission and works while AMO review is pending; it does not modify your normal Firefox profile or disable signature checks.
3. Submit the Firefox update to the existing AMO listing using the `listed` channel. The command does not wait for review approval, and it does not change what public users receive until Mozilla approves the update.

The upload prompts for an AMO API key (JWT issuer) and a hidden API secret, not your AMO account password. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>. Credentials are kept in process memory and are not written to the repository. You can also provide `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` as local environment variables. `web-ext` 10.7.0 is fetched through npm when needed, so Python 3, Node/npm, network access, and an installed Firefox are required.

The temporary test profile closes with its Firefox session. Workflow output is saved to `build/logs/upload.log`, and Firefox diagnostics are in `build/logs/upload-firefox-test.log`. For local-only testing without an AMO submission, run:

```bash
python Installers/upload_extension.py --local-only
```

This launcher submits to Firefox AMO only. It builds the Chrome Web Store package but does not submit it to the Chrome Web Store.

## What the installer does

The shared installer flow:

1. Builds the Chrome extension package from the repository source.
2. Attempts to register/install it for Google Chrome.
3. Builds the Firefox-compatible extension source/package.
4. Tries the persistent Firefox install path first.
5. Falls back to a `web-ext` temporary loader when release Firefox rejects the unsigned add-on and the required Node/npm tooling is available.
6. Writes diagnostics and actionable help links under `build/`.

The installer targets Google Chrome and Firefox. It does not currently provide a dedicated install path for other Chromium browsers.

## Platform prerequisites and automatic setup

### Windows

The Windows launcher looks for Python, Chrome, Firefox, and npm/Node.js.

When `winget` is available, it can attempt to install missing components using:

- Python 3.12
- Google Chrome
- Mozilla Firefox
- Node.js LTS

Python is required to run the shared installer. Missing Chrome or Firefox can cause that browser's installation step to be skipped. Missing npm can prevent the Firefox `web-ext` fallback from being used.

### macOS

The macOS launcher looks for `python3`, Google Chrome, Firefox, and npm/Node.js.

If Homebrew is already installed, the launcher can use it to attempt installation of missing Python, Chrome, Firefox, or Node.js. The launcher does not install Homebrew itself.

Python is required to run the shared installer. Missing browsers can be skipped. Missing npm can prevent the Firefox temporary-loader fallback.

## Diagnostics

Installer output is written to:

- `build/installer.log`
- `build/installer-help-links.txt`

If installation needs attention, check `installer.log` first. `installer-help-links.txt` contains links for dependencies or browser setup that could not be completed automatically.

The launchers do not require an extra Enter keypress after completion.

## Firefox limitations

The generated Firefox build declares Firefox 140.0 as its minimum desktop version.

Release Firefox normally rejects unsigned extensions as permanent installs. The installer therefore tries the persistent path first and then uses `web-ext` as a temporary-loading fallback when available. A temporary-loaded extension does not survive a normal Firefox restart in the same way as a signed AMO installation.

For manual temporary testing, generate the Firefox source with:

```bash
python Installers/package_for_stores.py
```

Then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select:

```text
build/firefox-src/manifest.json
```

## Build store packages

Run:

```bash
python Installers/package_for_stores.py
```

This script does not launch or modify a browser. It produces:

- `build/chatgpt-queue-optimizer-chrome-store.zip` - Manifest V3 archive for the Chrome Web Store.
- `build/chatgpt-queue-optimizer-firefox-store.zip` - Manifest V2 archive with Gecko metadata for Firefox AMO.
- `build/chrome-src/` - generated Chrome source directory.
- `build/firefox-src/` - generated Firefox source directory.

Use `package_for_stores.py` when you need store/upload artifacts or a generated Firefox source tree without performing the installer flow.

### Local Chrome signing keys

The installer’s Chrome CRX path may reuse `build/chrome-key.pem`; when no local key is supplied, Chrome can generate one in the ignored build directory. Keep any reusable source key in a secure location outside the checkout, copy it into `build/chrome-key.pem` only for local packaging, and never commit or force-add it. `package_for_stores.py` creates unsigned store archives and does not need this key.

The repository can confirm the former tracked key and the presence of a CRX artifact from local metadata, but local metadata cannot prove whether that key signed a distributed build or update. Check the relevant store or release records before changing a signing identity. This repository does not rotate credentials or modify external distribution state as part of cleanup.

## Which path should I use?

Use the Windows `.bat` or macOS `.app` when you want the repository to attempt local browser installation automatically.

Use `package_for_stores.py` when you are preparing store submissions, testing the generated Firefox source manually, or need build artifacts without changing browser installation state.
