# Installers

The Rust CLI in `Installers/native` is the only installer and publisher implementation. Python and PowerShell installer scripts have been removed. Windows and macOS application launchers only bootstrap Cargo and invoke Rust.

## One-click installation

Windows: run `Installers\Install ChatGPT Queue Optimizer.bat`.

macOS: install Rust using <https://rustup.rs/>, then run:

```bash
open "Installers/Install ChatGPT Queue Optimizer.app"
```

The native installer detects Chrome and Firefox, attempts missing browser dependencies through existing winget or Homebrew, builds fresh WASM and store packages, and installs locally. The Windows bootstrap can install rustup through winget; a compatible native build toolchain is required. The macOS bootstrap requires an existing Cargo installation. No Python is required.

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- install-auto --repo-dir .
```

Options: `--browser Chrome|Firefox|Chromium|All`, `--chrome-path PATH`, `--firefox-path PATH`, `--chromium-path PATH`, `--skip-chrome`, `--skip-firefox`, `--no-dependencies`, `--update-repo` (fast-forward origin/main), `--no-restart` (prepare local artifacts without launching a browser), `--no-temporary-loader` (on non-Windows, use the manual Firefox debugger instead of web-ext).

On Windows, native COM UI Automation installs the unpacked Chromium/Chrome extension or temporary Firefox add-on in the selected browser. It validates package identity, verifies the foreground browser and browser-owned picker, and fails closed on ambiguous controls. It does not terminate existing browser sessions or modify signature settings.

On macOS and Linux, Chrome/Chromium opens its extensions page and the native installer provides the exact stable unpacked directory and expected ID. The user must complete Load unpacked/Reload manually; this is reported as requiring attention, not verified success. Firefox uses a pinned web-ext temporary add-on in an isolated profile, checks the log for installation confirmation, and leaves the browser running. Manual Firefox debugging is available when npm is absent or the temporary loader is disabled. Persistent release Firefox installation requires a signed extension; the former unsigned profile/policy override and CRX external registration are deliberately not reproduced.

Diagnostics: `build/installer.log`, `build/installer-help-links.txt`, and per-session `build/logs/firefox-web-ext-*.log`.

## Windows local browser UI

```powershell
& '.\install locally.bat'
& '.\install locally.bat' -Browser Firefox
& '.\install locally.bat' -Browser Chromium
& '.\install locally.bat' -Browser Chrome
& '.\install locally.bat' -Browser All
```

Use explicit browser paths with `-FirefoxPath`, `-ChromiumPath`, or `-ChromePath` if multiple installations exist. Chromium uses a stable development key and local extension directory. Firefox uses content-hashed temporary XPIs. The native UI backend requires a visible Windows desktop and English accessible controls. Logs are written under `build/logs/install-local-*.log`. There is no legacy PowerShell fallback.

## Build and publish

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- build --repo-dir .
cargo run --release --manifest-path Installers/native/Cargo.toml -- package --repo-dir .
cargo run --release --manifest-path Installers/native/Cargo.toml -- publish --local-only
```

The Rust package command builds Chrome Web Store and Firefox AMO archives. Publishing uses pinned web-ext 10.7.0 through npm for Mozilla's supported signing and submission workflow. No browser store upload occurs during installation.

Windows `upload.bat` invokes managed-publish: fast-forward main, validate the clean checkout, run preflight, bump the patch version, submit to the existing AMO listing, then commit and push the version after acceptance. AMO credentials are read from environment variables or hidden prompts and redacted from logs. No live submission happens without an explicit publishing command.

On macOS, build the native publisher once, then open its app:

```bash
cargo run --release --manifest-path Installers/native/Cargo.toml -- install-upload-launcher
open upload.app
```

The macOS publisher runs publish for the current version without automatic Git synchronization or version bump. Both publishing paths launch an isolated Firefox test. See `build/logs/upload.log` and `build/logs/upload-firefox-test.log`.

## Verification

```bash
cargo test --manifest-path Installers/native/Cargo.toml
cargo run --release --manifest-path Installers/native/Cargo.toml -- check-secrets --repo-root .
```

Windows UI must additionally be verified in a live desktop session; package builds alone cannot establish browser installation parity.
