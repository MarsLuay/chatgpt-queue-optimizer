# Installers

Installer and packaging tools for ChatGPT Queue + Optimizer.

## Files

- `Install ChatGPT Queue Optimizer.bat` - Windows launcher.
- `Install ChatGPT Queue Optimizer.app` - macOS launcher.
- `install_chatgpt_queue_optimizer.py` - shared Chrome/Firefox installation helper used by the launchers.
- `package_for_stores.py` - builds upload-ready Chrome Web Store and Firefox AMO archives without installing or launching a browser.

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

## Which path should I use?

Use the Windows `.bat` or macOS `.app` when you want the repository to attempt local browser installation automatically.

Use `package_for_stores.py` when you are preparing store submissions, testing the generated Firefox source manually, or need build artifacts without changing browser installation state.
