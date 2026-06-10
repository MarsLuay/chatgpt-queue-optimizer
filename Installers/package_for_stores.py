#!/usr/bin/env python3
"""Build store-ready packages for the Chrome Web Store and Firefox Add-ons (AMO).

Unlike install_chatgpt_queue_optimizer.py (which sideloads a .crx and restarts
browsers), this script only produces upload artifacts:

  build/chatgpt-queue-optimizer-chrome-store.zip   (Manifest V3, for Chrome Web Store)
  build/chatgpt-queue-optimizer-firefox-store.zip  (Manifest V2 + gecko id, for AMO)

It never launches or modifies a browser, so it is safe to run anywhere.
"""
import argparse
import json
import shutil
import zipfile
from pathlib import Path

ADDON_ID = "chatgpt-queue-optimizer@marsluay.local"

REPO_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "options.html",
    "styles.css",
    "icon_16.png",
    "icon_48.png",
    "icon_128.png",
]


def log(message):
    print(message, flush=True)


def copy_source(repo_dir, target_dir):
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    for name in REPO_FILES:
        shutil.copy2(repo_dir / name, target_dir / name)
    icons = repo_dir / "icons"
    if icons.exists():
        shutil.copytree(icons, target_dir / "icons")


def build_firefox_source(repo_dir, target_dir):
    """Mirror install_chatgpt_queue_optimizer.build_firefox_source (MV2 + gecko)."""
    copy_source(repo_dir, target_dir)
    base = json.loads((repo_dir / "manifest.json").read_text())
    browser_action = dict(base["action"])
    manifest = {
        "manifest_version": 2,
        "name": base["name"],
        "description": base["description"],
        "version": base["version"],
        "offline_enabled": base.get("offline_enabled", True),
        "browser_action": browser_action,
        "background": {
            "scripts": ["background.js"],
            "persistent": True,
        },
        "options_ui": {
            "page": "options.html",
            "open_in_tab": True,
        },
        "commands": base.get("commands", {}),
        "content_scripts": base.get("content_scripts", []),
        "permissions": sorted(set(base.get("permissions", []) + base.get("host_permissions", []))),
        "icons": base.get("icons", {}),
        "web_accessible_resources": [
            "icon_16.png",
            "icon_48.png",
            "icon_128.png",
            "popup.html",
            "popup.js",
            "styles.css",
        ],
        "browser_specific_settings": {
            "gecko": {
                "id": ADDON_ID,
                "strict_min_version": "140.0",
                "data_collection_permissions": {
                    "required": ["none"],
                },
            },
            "gecko_android": {
                "strict_min_version": "142.0",
            },
        },
    }
    (target_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def zip_dir(source_dir, out_file):
    if out_file.exists():
        out_file.unlink()
    with zipfile.ZipFile(out_file, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(source_dir))


def main():
    default_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=default_root)
    args = parser.parse_args()

    repo_dir = args.repo_dir.resolve()
    if not (repo_dir / "manifest.json").exists():
        raise SystemExit(f"manifest.json was not found in {repo_dir}")

    version = json.loads((repo_dir / "manifest.json").read_text())["version"]
    build_dir = repo_dir / "build"
    build_dir.mkdir(exist_ok=True)

    log(f"Packaging ChatGPT Queue Optimizer v{version}")

    chrome_src = build_dir / "chrome-src"
    copy_source(repo_dir, chrome_src)
    chrome_zip = build_dir / "chatgpt-queue-optimizer-chrome-store.zip"
    zip_dir(chrome_src, chrome_zip)
    log(f"  Chrome (MV3)  -> {chrome_zip.relative_to(repo_dir)}")

    firefox_src = build_dir / "firefox-src"
    build_firefox_source(repo_dir, firefox_src)
    firefox_zip = build_dir / "chatgpt-queue-optimizer-firefox-store.zip"
    zip_dir(firefox_src, firefox_zip)
    log(f"  Firefox (MV2) -> {firefox_zip.relative_to(repo_dir)}")

    log("Done. Both archives are ready to upload to the respective stores.")


if __name__ == "__main__":
    main()
