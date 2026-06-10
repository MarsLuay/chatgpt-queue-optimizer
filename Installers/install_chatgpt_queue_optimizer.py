#!/usr/bin/env python3
import argparse
import configparser
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import zipfile
from struct import unpack_from
from pathlib import Path


ADDON_ID = "chatgpt-queue-optimizer@marsluay.local"
CHROME_ID_FILE = "chrome-extension-id.txt"
REPO_URL = "https://github.com/MarsLuay/chatgpt-queue-optimizer.git"
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


def run(cmd, check=False, cwd=None, capture=True):
    log("+ " + " ".join(str(part) for part in cmd))
    return subprocess.run(
        [str(part) for part in cmd],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        check=check,
    )


def ensure_repo(repo_dir, repo_url, update_repo=False):
    if not (repo_dir / "manifest.json").exists():
        raise RuntimeError(f"manifest.json was not found in {repo_dir}")

    if not update_repo:
        log(f"Using local checkout: {repo_dir}")
        return

    if (repo_dir / ".git").exists():
        log(f"Repository already present: {repo_dir}")
        status = run(["git", "-C", repo_dir, "status", "--porcelain"], capture=True)
        run(["git", "-C", repo_dir, "fetch", "--prune", "origin"], capture=True)
        if status.stdout.strip():
            log("Local changes found in extension repo; fetched origin but skipped pull.")
            return
        pull = run(["git", "-C", repo_dir, "pull", "--ff-only"], capture=True)
        if pull.returncode != 0:
            log("Could not fast-forward extension repo; leaving checkout as-is.")
            log(pull.stdout.strip())
        return

    if repo_dir.exists():
        log(f"Existing path is not a Git checkout, leaving it alone: {repo_dir}")
        return

    repo_dir.parent.mkdir(parents=True, exist_ok=True)
    clone = run(["git", "clone", repo_url, repo_dir], capture=True)
    if clone.returncode != 0:
        raise RuntimeError(f"Could not clone {repo_url}:\n{clone.stdout}")


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
            }
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


def find_executable(candidates):
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.exists():
            return path
        found = shutil.which(str(candidate))
        if found:
            return Path(found)
    return None


def chrome_candidates():
    if platform.system() == "Darwin":
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    if platform.system() == "Windows":
        roots = [os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")]
        return [Path(root) / "Google/Chrome/Application/chrome.exe" for root in roots if root] + ["chrome.exe"]
    return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]


def firefox_candidates():
    if platform.system() == "Darwin":
        return [
            "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
            Path.home() / "Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
            "/Applications/Firefox.app/Contents/MacOS/firefox",
            Path.home() / "Applications/Firefox.app/Contents/MacOS/firefox",
        ]
    if platform.system() == "Windows":
        roots = [os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")]
        return (
            [Path(root) / "Firefox Developer Edition/firefox.exe" for root in roots if root] +
            [Path(root) / "Mozilla Firefox/firefox.exe" for root in roots if root] +
            [Path(root) / "Programs/Firefox Developer Edition/firefox.exe" for root in roots if root] +
            [Path(root) / "Programs/Mozilla Firefox/firefox.exe" for root in roots if root] +
            ["firefox.exe"]
        )
    return ["firefox-developer-edition", "firefoxdeveloperedition", "firefox"]


def openssl_candidates():
    candidates = ["openssl"]
    if platform.system() == "Windows":
        for root in [os.environ.get("PROGRAMFILES"), os.environ.get("LOCALAPPDATA")]:
            if root:
                candidates.append(Path(root) / "Git/usr/bin/openssl.exe")
    return candidates


def chrome_id_from_key(key_path):
    openssl = find_executable(openssl_candidates())
    if not openssl:
        raise RuntimeError("openssl was not found; cannot compute Chrome extension ID.")

    try:
        public_der = subprocess.check_output(
            [str(openssl), "rsa", "-in", str(key_path), "-pubout", "-outform", "DER"],
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Could not read Chrome extension key: {error}") from error
    digest = hashlib.sha256(public_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


def chrome_id_from_public_key(public_key):
    digest = hashlib.sha256(public_key).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


def read_varint(data, index):
    value = 0
    shift = 0
    while index < len(data):
        byte = data[index]
        index += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, index
        shift += 7
    raise ValueError("unterminated protobuf varint")


def protobuf_fields(data):
    index = 0
    while index < len(data):
        key, index = read_varint(data, index)
        field_number = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            _, index = read_varint(data, index)
            yield field_number, wire_type, None
        elif wire_type == 1:
            index += 8
            yield field_number, wire_type, None
        elif wire_type == 2:
            length, index = read_varint(data, index)
            value = data[index:index + length]
            index += length
            yield field_number, wire_type, value
        elif wire_type == 5:
            index += 4
            yield field_number, wire_type, None
        else:
            raise ValueError(f"unsupported protobuf wire type {wire_type}")


def chrome_id_from_crx(crx_path):
    data = crx_path.read_bytes()
    if data[:4] != b"Cr24":
        raise RuntimeError("Chrome package is not a CRX file.")

    version = unpack_from("<I", data, 4)[0]
    if version == 2:
        public_key_len = unpack_from("<I", data, 8)[0]
        public_key = data[16:16 + public_key_len]
        return chrome_id_from_public_key(public_key)

    if version == 3:
        header_len = unpack_from("<I", data, 8)[0]
        header = data[12:12 + header_len]
        for field, wire_type, value in protobuf_fields(header):
            if field != 2 or wire_type != 2 or value is None:
                continue
            for proof_field, proof_wire_type, proof_value in protobuf_fields(value):
                if proof_field == 1 and proof_wire_type == 2 and proof_value:
                    return chrome_id_from_public_key(proof_value)

    raise RuntimeError("Could not read Chrome extension ID from CRX.")


def build_chrome_package(repo_dir, build_dir):
    chrome = find_executable(chrome_candidates())
    if not chrome:
        log("Google Chrome was not found; skipping Chrome extension packaging.")
        return None, None

    chrome_src = build_dir / "chrome-src"
    copy_source(repo_dir, chrome_src)

    key_path = build_dir / "chrome-key.pem"
    crx_path = build_dir / "chatgpt-queue-optimizer-chrome.crx"
    generated_crx = build_dir / "chrome-src.crx"
    generated_key = build_dir / "chrome-src.pem"
    for path in [crx_path, generated_crx]:
        path.unlink(missing_ok=True)

    cmd = [chrome, f"--pack-extension={chrome_src}"]
    if key_path.exists():
        cmd.append(f"--pack-extension-key={key_path}")
    result = run(cmd, capture=True)
    if result.returncode != 0:
        log("Chrome package failed:\n" + result.stdout)
        return None, None

    if generated_key.exists() and not key_path.exists():
        generated_key.replace(key_path)
    if generated_crx.exists():
        generated_crx.replace(crx_path)

    match = re.search(r"Extension ID:\s*([a-p]{32})", result.stdout or "", re.I)
    if match:
        extension_id = match.group(1).lower()
    else:
        try:
            extension_id = chrome_id_from_crx(crx_path)
        except Exception:
            extension_id = chrome_id_from_key(key_path)
    (build_dir / CHROME_ID_FILE).write_text(extension_id + "\n")
    return crx_path, extension_id


def chrome_external_dir():
    if platform.system() == "Darwin":
        return Path.home() / "Library/Application Support/Google/Chrome/External Extensions"
    if platform.system() == "Windows":
        return None
    return Path.home() / ".config/google-chrome/External Extensions"


def register_chrome_extension(crx_path, extension_id, version):
    if platform.system() == "Windows":
        key = rf"HKCU\Software\Google\Chrome\Extensions\{extension_id}"
        run(["reg", "add", key, "/v", "path", "/t", "REG_SZ", "/d", crx_path, "/f"], capture=True)
        run(["reg", "add", key, "/v", "version", "/t", "REG_SZ", "/d", version, "/f"], capture=True)
        return

    external_dir = chrome_external_dir()
    external_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "external_crx": str(crx_path),
        "external_version": version,
    }
    (external_dir / f"{extension_id}.json").write_text(json.dumps(config, indent=2) + "\n")


def chrome_profile_dirs():
    if platform.system() == "Darwin":
        root = Path.home() / "Library/Application Support/Google/Chrome"
    elif platform.system() == "Windows":
        root = Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/User Data"
    else:
        root = Path.home() / ".config/google-chrome"
    return [p for p in [root / "Default"] + sorted(root.glob("Profile *")) if p.exists()]


def restart_chrome():
    if platform.system() == "Darwin":
        run(["osascript", "-e", 'tell application "Google Chrome" to quit'], capture=True)
        time.sleep(3)
        run(["open", "-a", "Google Chrome"], capture=True)
        time.sleep(8)
    elif platform.system() == "Windows":
        run(["taskkill", "/IM", "chrome.exe", "/F"], capture=True)
        time.sleep(3)
        chrome = find_executable(chrome_candidates())
        if chrome:
            subprocess.Popen([str(chrome)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(8)


def verify_chrome(extension_id):
    for profile in chrome_profile_dirs():
        installed = profile / "Extensions" / extension_id
        if installed.exists():
            log(f"Chrome extension installed in {installed}")
            return True
    log("Chrome extension registration was written, but the extension directory was not found yet.")
    return False


def firefox_root():
    if platform.system() == "Darwin":
        return Path.home() / "Library/Application Support/Firefox"
    if platform.system() == "Windows":
        return Path(os.environ.get("APPDATA", "")) / "Mozilla/Firefox"
    return Path.home() / ".mozilla/firefox"


def firefox_resources_dir():
    firefox = find_executable(firefox_candidates())
    if not firefox:
        return None

    if platform.system() == "Darwin":
        for parent in firefox.parents:
            if parent.name == "Contents":
                return parent / "Resources"

    return firefox.parent


def resolve_firefox_profile_path(root, path_text):
    if not path_text:
        return None

    path = Path(path_text)

    if not path.is_absolute():
        path = root / path

    return path


def profile_matches_firefox_app(profile_path, resources_dir):
    if not profile_path or not resources_dir:
        return False

    compatibility = profile_path / "compatibility.ini"
    if not compatibility.exists():
        return False

    parser = configparser.ConfigParser()
    parser.read(compatibility)

    if not parser.has_section("Compatibility"):
        return False

    expected = str(resources_dir.resolve())
    platform_dir = parser.get("Compatibility", "LastPlatformDir", fallback="")
    app_dir = parser.get("Compatibility", "LastAppDir", fallback="")

    return platform_dir == expected or app_dir.startswith(expected + os.sep)


def firefox_profile():
    root = firefox_root()
    profiles_ini = root / "profiles.ini"
    if not profiles_ini.exists():
        return None

    parser = configparser.ConfigParser()
    parser.read(profiles_ini)
    resources_dir = firefox_resources_dir()
    firefox_path = find_executable(firefox_candidates())
    prefers_developer = firefox_path and "developer" in str(firefox_path).lower()

    profile_entries = []
    install_defaults = []
    candidates = []

    for section in parser.sections():
        if section.startswith("Install") and parser.has_option(section, "Default"):
            install_defaults.append(parser.get(section, "Default"))

        if section.startswith("Profile"):
            path = parser.get(section, "Path", fallback="")
            profile_path = resolve_firefox_profile_path(root, path)
            profile_entries.append({
                "name": parser.get(section, "Name", fallback=""),
                "path_text": path,
                "path": profile_path,
                "is_default": parser.get(section, "Default", fallback="0") == "1",
            })

    if resources_dir:
        candidates.extend(
            entry["path_text"]
            for entry in profile_entries
            if profile_matches_firefox_app(entry["path"], resources_dir)
        )

    if prefers_developer:
        candidates.extend(
            entry["path_text"]
            for entry in profile_entries
            if "dev-edition" in entry["name"].lower() or "dev-edition" in entry["path_text"].lower()
        )

    candidates.extend(install_defaults)
    candidates.extend(entry["path_text"] for entry in profile_entries if entry["is_default"])
    candidates.extend(entry["path_text"] for entry in profile_entries)

    for path_text in candidates:
        path = resolve_firefox_profile_path(root, path_text)
        if path.exists():
            return path
    return None


def firefox_policy_path():
    if platform.system() == "Darwin":
        firefox = find_executable(firefox_candidates())
        if firefox:
            for parent in firefox.parents:
                if parent.name == "Contents":
                    return parent / "Resources/distribution/policies.json"
        return None
    if platform.system() == "Windows":
        firefox = find_executable(firefox_candidates())
        if firefox:
            return firefox.parent / "distribution/policies.json"
    return None


def firefox_app_name():
    if platform.system() != "Darwin":
        return None

    firefox = find_executable(firefox_candidates())
    if not firefox:
        return "Firefox"

    for parent in firefox.parents:
        if parent.suffix == ".app":
            return parent.stem

    return "Firefox"


def install_firefox_persistent(xpi_path):
    profile = firefox_profile()
    if profile:
        extensions = profile / "extensions"
        extensions.mkdir(exist_ok=True)
        shutil.copy2(xpi_path, extensions / f"{ADDON_ID}.xpi")
        user_js = profile / "user.js"
        existing = user_js.read_text() if user_js.exists() else ""
        for line in [
            'user_pref("xpinstall.signatures.required", false);',
            'user_pref("extensions.autoDisableScopes", 0);',
            'user_pref("extensions.enabledScopes", 15);',
        ]:
            if line not in existing:
                existing += ("\n" if existing and not existing.endswith("\n") else "") + line + "\n"
        user_js.write_text(existing)

    policy = firefox_policy_path()
    if policy:
        policy.parent.mkdir(parents=True, exist_ok=True)
        data = {"policies": {}}
        if policy.exists():
            try:
                data = json.loads(policy.read_text())
            except Exception:
                data = {"policies": {}}
        settings = data.setdefault("policies", {}).setdefault("ExtensionSettings", {})
        settings[ADDON_ID] = {
            "installation_mode": "force_installed",
            "install_url": xpi_path.resolve().as_uri(),
        }
        policy.write_text(json.dumps(data, indent=2) + "\n")


def restart_firefox():
    if platform.system() == "Darwin":
        app_name = firefox_app_name() or "Firefox"
        run(["osascript", "-e", f'tell application "{app_name}" to quit'], capture=True)
        time.sleep(3)
        run(["open", "-a", app_name], capture=True)
        time.sleep(10)
    elif platform.system() == "Windows":
        run(["taskkill", "/IM", "firefox.exe", "/F"], capture=True)
        time.sleep(3)
        firefox = find_executable(firefox_candidates())
        if firefox:
            subprocess.Popen([str(firefox)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(10)


def verify_firefox_persistent():
    profile = firefox_profile()
    if not profile:
        return False
    extensions_json = profile / "extensions.json"
    if not extensions_json.exists():
        return False
    try:
        data = json.loads(extensions_json.read_text())
    except Exception:
        return False
    for addon in data.get("addons", []):
        if addon.get("id") == ADDON_ID and addon.get("active"):
            log("Firefox extension is persistently active.")
            return True
    return False


def start_firefox_temporary_loader(firefox_src, logs_dir):
    npm = find_executable(["npm", "npm.cmd"])
    firefox = find_executable(firefox_candidates())
    profile = firefox_profile()
    if not npm or not firefox or not profile:
        log("Could not start Firefox temporary loader; npm, Firefox, or a Firefox profile was missing.")
        return False

    if platform.system() == "Darwin":
        app_name = firefox_app_name() or "Firefox"
        run(["osascript", "-e", f'tell application "{app_name}" to quit'], capture=True)
        time.sleep(3)
    elif platform.system() == "Windows":
        run(["taskkill", "/IM", "firefox.exe", "/F"], capture=True)
        time.sleep(3)

    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / "firefox-web-ext.log"
    pid_file = logs_dir / "firefox-web-ext.pid"
    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text().strip())
            if platform.system() == "Windows":
                run(["taskkill", "/PID", str(old_pid), "/F"], capture=True)
            else:
                os.kill(old_pid, 15)
        except Exception:
            pass

    cmd = [
        str(npm),
        "exec",
        "--yes",
        "--",
        "web-ext",
        "run",
        "--source-dir",
        str(firefox_src),
        "--firefox",
        str(firefox),
        "--firefox-profile",
        str(profile),
        "--keep-profile-changes",
        "--no-reload",
        "--start-url",
        "about:debugging#/runtime/this-firefox",
    ]
    if platform.system() == "Darwin" and Path("/usr/bin/script").exists():
        runner = logs_dir / "run-firefox-web-ext.zsh"
        quoted = " ".join("'" + str(part).replace("'", "'\\''") + "'" for part in cmd)
        runner.write_text("#!/bin/zsh\ncd " + "'" + str(firefox_src.parent.parent).replace("'", "'\\''") + "'\nexec " + quoted + "\n")
        runner.chmod(0o755)
        cmd = ["/usr/bin/script", "-q", "/dev/null", str(runner)]

    with log_file.open("w") as out:
        process = subprocess.Popen(
            cmd,
            cwd=str(firefox_src.parent.parent),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_file.write_text(str(process.pid) + "\n")
    time.sleep(20)
    output = log_file.read_text(errors="replace") if log_file.exists() else ""
    log(output.strip())
    return "Installed" in output and "temporary add-on" in output


def build_packages(repo_dir):
    build_dir = repo_dir / "build"
    build_dir.mkdir(exist_ok=True)

    chrome_crx, chrome_id = build_chrome_package(repo_dir, build_dir)

    firefox_src = build_dir / "firefox-src"
    build_firefox_source(repo_dir, firefox_src)
    firefox_xpi = build_dir / "chatgpt-queue-optimizer-firefox.xpi"
    zip_dir(firefox_src, firefox_xpi)

    return build_dir, chrome_crx, chrome_id, firefox_src, firefox_xpi


def main():
    default_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-dir", type=Path, default=default_root)
    parser.add_argument("--repo-url", default=REPO_URL)
    parser.add_argument("--update-repo", action="store_true")
    parser.add_argument("--skip-chrome", action="store_true")
    parser.add_argument("--skip-firefox", action="store_true")
    parser.add_argument("--no-restart", action="store_true")
    parser.add_argument("--no-temporary-loader", action="store_true")
    args = parser.parse_args()

    ensure_repo(args.repo_dir, args.repo_url, args.update_repo)
    version = json.loads((args.repo_dir / "manifest.json").read_text())["version"]
    build_dir, chrome_crx, chrome_id, firefox_src, firefox_xpi = build_packages(args.repo_dir)
    failures = []

    if not args.skip_chrome:
        if chrome_crx and chrome_id:
            register_chrome_extension(chrome_crx, chrome_id, version)
            if not args.no_restart:
                restart_chrome()
            if not verify_chrome(chrome_id):
                log("Chrome may need one more launch before the extension directory appears.")
        else:
            failures.append("Google Chrome packaging/registration did not complete.")

    if not args.skip_firefox:
        install_firefox_persistent(firefox_xpi)
        if not args.no_restart:
            restart_firefox()
        if not verify_firefox_persistent():
            if args.no_restart:
                log("Firefox extension files were installed. Restart Firefox to activate and verify them.")
            elif args.no_temporary_loader:
                failures.append("Firefox release did not accept the unsigned persistent XPI.")
            else:
                log("Firefox release did not accept persistent unsigned install; starting web-ext temporary loader.")
                if start_firefox_temporary_loader(firefox_src, build_dir / "logs"):
                    log("Firefox temporary extension loader is running.")
                else:
                    failures.append("Firefox temporary extension loader did not confirm install.")
        else:
            log("Firefox extension is installed persistently.")

    if failures:
        for failure in failures:
            log(f"WARNING: {failure}")
        raise RuntimeError("One or more browser installs need attention.")

    log("ChatGPT Queue Optimizer installer finished.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"ERROR: {error}")
        sys.exit(1)
