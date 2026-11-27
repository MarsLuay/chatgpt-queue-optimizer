# Installers

Installer and packaging tools for ChatGPT Queue + Optimizer.

## Files

- `Install ChatGPT Queue Optimizer.bat` - Windows launcher.
- `../install locally.bat` - Windows local installer for Firefox and Chromium, with optional Chrome selection.
- `native/src/main.rs` - Rust build, packaging, installation and publishing coordinator.
- `install_chromium_locally.ps1` - verified Chromium Developer mode, Load unpacked and reload automation adapted from Vault Pi.
- `install_firefox_locally.ps1` - verified Firefox debugging-page and file-picker automation adapted from Vault Pi.
- `Install ChatGPT Queue Optimizer.app` - macOS launcher.
- `install_chatgpt_queue_optimizer.py` - shared Chrome/Firefox installation helper used by the launchers.
- Rust `package` command - builds upload-ready Chrome Web Store and Firefox AMO archives without installing or launching a browser.
- `upload_extension.py` - submits a listed Firefox update to AMO and starts an isolated local Firefox test.
- `../upload.bat` - Windows managed release launcher (Git sync, validation, version bump, AMO, Git push).
- `../upload.app` - macOS package-and-upload launcher.

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

## Install the latest local build into your normal browser sessions

From the repository root in PowerShell:

```powershell
& '.\install locally.bat'
```

The launcher prompts for `1. Firefox` or `2. Chromium` before building and
installs into only the selected browser. Explicit command-line selection skips
the prompt. The batch window stays open after success or failure until you
press a key, then returns the installer exit code. Packaging output and browser
setup diagnostics (including stderr, failing setup stage, per-browser exit
codes and total elapsed time) stream to the console and are retained in a
unique timestamped `build/logs/install-local-*.log` file for each run. The
exact log path is printed at the beginning and end of the run. Before the
batch pauses, the coordinator prints the complete saved log between BEGIN
and END FULL INSTALLER LOG markers so it can be copied directly from the
console. Python detection records each candidate and continues to the next
candidate if the first cannot run. If PowerShell
cannot start or initialize logging, the batch still pauses and displays the
failure; in that case a log may not exist. Google Chrome and installing both browsers (`-Browser All`) remain
available only through explicit command-line selection:

```powershell
& '.\install locally.bat' -Browser Firefox
& '.\install locally.bat' -Browser Chromium
& '.\install locally.bat' -Browser Chrome
& '.\install locally.bat' -Browser All
```

Chromium and Chrome use the Vault Pi style verified `chrome://extensions`
workflow: detect the requested browser executable, enable Developer mode only
if it is off, choose **Load unpacked** in the native folder picker, and verify
the dedicated local extension ID. Later runs update the stable
`build/local-chromium/extension/` directory and request Reload on the exact
local extension card instead of uninstalling it. The persistent unpacked
extension survives browser restarts as long as the directory is retained and
the browser permits developer extensions. Its public development key gives it
a separate ID and storage from any store-installed copy; disable that copy
manually if both would run on the same sites. The store package is unchanged.
No browser is terminated and no store upload occurs. Live reload execution
inside the browser is not independently verified by the script.

For a nonstandard Chromium executable:

```powershell
& '.\install locally.bat' -Browser Chromium -ChromiumPath 'D:\Chromium\chrome.exe'
```

For Firefox, the launcher builds the current checkout, validates the Firefox XPI against the pinned
Gecko ID and current manifest version, detects the existing Firefox executable,
opens or reuses `about:debugging#/runtime/this-firefox`, and automates **Load
Temporary Add-on** through the real Firefox-owned file picker. It verifies the
temporary add-on in the debugger inventory and, when replacing an existing
temporary copy, requires evidence of the selected XPI location.

Keep the Windows desktop available during setup; the installer needs access to
Firefox's visible UI. It does not close Firefox, create a separate test profile,
uninstall the store-installed add-on, change signature preferences, submit to
AMO, or bump the version. A temporary add-on only lasts until Firefox restarts.
Run the batch file again after restarting or changing the source. Windows,
Python 3 and Firefox 140+ are required. The automation uses English Firefox UI
labels and fails if it cannot verify the target window or controls.

If multiple Firefox editions are running, select the intended executable:

```powershell
& '.\install locally.bat' -FirefoxPath 'C:\Program Files\Mozilla Firefox\firefox.exe'
```

The generated local XPI files are kept under `build/local-firefox/` by content
hash to avoid overwriting a package that Firefox may still be using. You can
remove unused packages after closing Firefox.

## Submit a Firefox update and test it locally

On Windows, `upload.bat` now runs the managed release publisher, which requires a clean `main` checkout and Git push access. It fast-forward pulls `origin/main`, installs locked npm dependencies, runs `npm run check`, automatically increments the patch version in `manifest.json`, then executes the existing Firefox AMO packaging/submission workflow. Once AMO confirms the submission request, it commits the version change and pushes it to `origin/main` (never with force). If validation fails, no version is changed or submitted. If AMO submission or Git push fails, the bumped manifest or local commit is retained so the user can inspect what the server accepted before retrying. Read `build/logs/upload.log` and `git status`. The temporary Firefox test is non-blocking in this managed Windows mode.

On macOS, first compile the native publisher, then open the application:

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- install-upload-launcher
open upload.app
```

The generated executable is not tracked by Git. It opens Terminal and runs the Rust `publish` command for the current manifest version, without an automatic Git pull or version bump. Both launchers:

1. Rebuild the store-ready packages and validate the Firefox add-on ID and version.
2. Start `web-ext run` with the generated Firefox source in a separate temporary profile. This local test starts before the store submission and works while AMO review is pending; it does not modify your normal Firefox profile or disable signature checks.
3. Submit the Firefox update to the existing AMO listing using the `listed` channel. The command does not wait for review approval, and it does not change what public users receive until Mozilla approves the update.

The upload prompts for an AMO API key (JWT issuer) and a hidden API secret, not your AMO account password. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>. Credentials are kept in process memory and are not written to the repository. You can also provide `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` as local environment variables. `web-ext` 10.7.0 is fetched through npm when needed, so Rust/Cargo, Node/npm, network access, and an installed Firefox are required for the native publishing path.

The temporary test profile closes with its Firefox session. Workflow output is saved to `build/logs/upload.log`, and Firefox diagnostics are in `build/logs/upload-firefox-test.log`. For local-only testing without an AMO submission, run:

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- publish --local-only
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
cargo run --release --manifest-path Installers/native/Cargo.toml -- package
```

Then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select:

```text
build/firefox-src/manifest.json
```

## Build store packages

Run:

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- package
```

This script does not launch or modify a browser. It produces:

- `build/chatgpt-queue-optimizer-chrome-store.zip` - Manifest V3 archive for the Chrome Web Store.
- `build/chatgpt-queue-optimizer-firefox-store.zip` - Manifest V2 archive with Gecko metadata for Firefox AMO.
- `build/chrome-src/` - generated Chrome source directory.
- `build/firefox-src/` - generated Firefox source directory.

Use the Rust `package` command when you need store/upload artifacts or a generated Firefox source tree without performing the installer flow.

### Local Chrome signing keys

The installer’s Chrome CRX path may reuse `build/chrome-key.pem`; when no local key is supplied, Chrome can generate one in the ignored build directory. Keep any reusable source key in a secure location outside the checkout, copy it into `build/chrome-key.pem` only for local packaging, and never commit or force-add it. the Rust `package` command creates unsigned store archives and does not need this key.

The repository can confirm the former tracked key and the presence of a CRX artifact from local metadata, but local metadata cannot prove whether that key signed a distributed build or update. Check the relevant store or release records before changing a signing identity. This repository does not rotate credentials or modify external distribution state as part of cleanup.

## Which path should I use?

Use the Windows `.bat` or macOS `.app` when you want the repository to attempt local browser installation automatically.

Use the Rust `package` command when you are preparing store submissions, testing the generated Firefox source manually, or need build artifacts without changing browser installation state.

The removed Python build/packaging and managed-release scripts and the PowerShell coordinator are no longer needed. The remaining legacy cross-platform installer and optional Python upload helper invoke the Rust build/package commands directly. The native macOS launcher is generated locally, and `upload.app` must be rebuilt when its Rust implementation changes. Native source and integration verification must be completed on the target platforms.
