# Installers

One-click installers for ChatGPT Queue + Optimizer.

## What is here

- `Install ChatGPT Queue Optimizer.bat` - Windows installer
- `Install ChatGPT Queue Optimizer.app` - macOS installer
- `install_chatgpt_queue_optimizer.py` - shared Chrome/Firefox install helper

## What they do

- Build the Chrome extension package from this repo
- Register the extension with Google Chrome
- Build a Firefox-compatible package
- Try the persistent Firefox install path first
- Start a `web-ext` Firefox loader if release Firefox rejects the unsigned XPI
- Write logs and help links to `build/`

## Start here

Windows:

```bat
Installers\Install ChatGPT Queue Optimizer.bat
```

macOS:

```bash
open "Installers/Install ChatGPT Queue Optimizer.app"
```

## Notes

Firefox release builds usually reject unsigned extensions as a permanent install. The installer still tries the persistent path first, then keeps the extension loaded with `web-ext` when Firefox blocks it.

The installers do not ask for Enter. If something fails, they finish with links for the missing browser, runtime, or extension setup step.
