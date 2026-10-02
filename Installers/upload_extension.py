#!/usr/bin/env python3
"""Submit a listed Firefox update to AMO and start an isolated local Firefox test."""
from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

ADDON_ID = "chatgpt-queue-optimizer@marsluay.local"
WEB_EXT_VERSION = "10.7.0"
AMO_API_CREDENTIALS_URL = "https://addons.mozilla.org/developers/addon/api/key/"
CHATGPT_START_URL = "https://chatgpt.com/"
LOCAL_INSTALL_WAIT_SECONDS = 30
LOG_PATH: Path | None = None


def log(message: str) -> None:
    print(message, flush=True)
    if LOG_PATH is not None:
        with LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(message + "\n")


def npm_exec_web_ext(npm: str, *args: str) -> list[str]:
    return [
        npm,
        "exec",
        "--yes",
        f"--package=web-ext@{WEB_EXT_VERSION}",
        "--",
        "web-ext",
        *args,
    ]


def build_amo_submit_command(npm: str, source_dir: Path, artifacts_dir: Path) -> list[str]:
    return npm_exec_web_ext(
        npm,
        "sign",
        "--source-dir",
        str(source_dir),
        "--artifacts-dir",
        str(artifacts_dir),
        "--channel",
        "listed",
        "--approval-timeout",
        "0",
        "--no-input",
        "--no-config-discovery",
    )


def build_local_firefox_command(npm: str, source_dir: Path) -> list[str]:
    # Omitting --firefox-profile makes web-ext use an isolated temporary profile;
    # it never edits or disables signing on the user's normal Firefox profile.
    return npm_exec_web_ext(
        npm,
        "run",
        "--source-dir",
        str(source_dir),
        "--no-config-discovery",
        "--start-url",
        CHATGPT_START_URL,
    )


def signing_environment(
    api_key: str,
    api_secret: str,
    base_environment: dict[str, str] | None = None,
) -> dict[str, str]:
    env = dict(os.environ if base_environment is None else base_environment)
    env["WEB_EXT_API_KEY"] = api_key
    env["WEB_EXT_API_SECRET"] = api_secret
    return env


def redact_credentials(text: str, credentials: tuple[str, str]) -> str:
    for credential in credentials:
        if credential:
            text = text.replace(credential, "[redacted]")
    return text


def read_amo_credentials(
    environment: dict[str, str] | None = None,
    input_fn: Callable[[str], str] = input,
    secret_fn: Callable[[str], str] = getpass.getpass,
) -> tuple[str, str]:
    env = os.environ if environment is None else environment
    api_key = env.get("WEB_EXT_API_KEY", "").strip()
    api_secret = env.get("WEB_EXT_API_SECRET", "").strip()

    if not api_key or not api_secret:
        if not sys.stdin.isatty() and (not api_key or not api_secret):
            raise RuntimeError(
                "AMO API credentials are not configured. Run upload.bat/upload.app interactively "
                "or set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in the environment."
            )
        log(f"Create AMO API credentials at {AMO_API_CREDENTIALS_URL}")
        if not api_key:
            api_key = input_fn("AMO API key (JWT issuer): ").strip()
        if not api_secret:
            api_secret = secret_fn("AMO API secret (hidden): ").strip()

    if not api_key or not api_secret:
        raise RuntimeError("Both AMO API credentials are required to submit the listed update.")
    return api_key, api_secret


def find_npm() -> str | None:
    return shutil.which("npm") or shutil.which("npm.cmd")


def validate_firefox_source(source_dir: Path, expected_version: str) -> None:
    manifest_path = source_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    addon_id = manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    if manifest.get("manifest_version") != 2:
        raise RuntimeError("The generated Firefox package is not a Manifest V2 build.")
    if manifest.get("version") != expected_version:
        raise RuntimeError(f"Firefox source version mismatch: expected {expected_version}.")
    if addon_id != ADDON_ID:
        raise RuntimeError(f"Firefox source add-on ID mismatch: expected {ADDON_ID}.")


def build_store_packages(repo_root: Path) -> tuple[str, Path, Path]:
    manifest = json.loads((repo_root / "manifest.json").read_text(encoding="utf-8"))
    version = str(manifest.get("version", "")).strip()
    if not version:
        raise RuntimeError("manifest.json is missing its extension version.")

    package_script = repo_root / "Installers" / "package_for_stores.py"
    result = subprocess.run(
        [sys.executable, str(package_script), "--repo-dir", str(repo_root)],
        cwd=repo_root,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Store package generation failed.")

    build_dir = repo_root / "build"
    source_dir = build_dir / "firefox-src"
    firefox_zip = build_dir / "chatgpt-queue-optimizer-firefox-store.zip"
    if not firefox_zip.is_file():
        raise RuntimeError("The Firefox AMO package was not created.")
    validate_firefox_source(source_dir, version)
    return version, source_dir, build_dir / "amo-artifacts"


def wait_for_local_install(process: subprocess.Popen, log_path: Path) -> str:
    deadline = time.monotonic() + LOCAL_INSTALL_WAIT_SECONDS
    while time.monotonic() < deadline:
        output = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        lower_output = output.lower()
        if "installed" in lower_output and "temporary add-on" in lower_output:
            return "installed"
        if process.poll() is not None:
            return "failed"
        time.sleep(0.5)
    return "starting" if process.poll() is None else "failed"


def start_local_firefox(npm: str, repo_root: Path, source_dir: Path) -> str:
    logs_dir = repo_root / "build" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / "upload-firefox-test.log"
    pid_path = logs_dir / "upload-firefox-test.pid"
    command = build_local_firefox_command(npm, source_dir)
    creation_options: dict[str, int] = {}
    if os.name == "nt":
        creation_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        creation_options["start_new_session"] = True

    with log_path.open("w", encoding="utf-8") as output:
        process = subprocess.Popen(
            command,
            cwd=repo_root,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            **creation_options,
        )
    pid_path.write_text(f"{process.pid}\n", encoding="utf-8")
    state = wait_for_local_install(process, log_path)
    if state == "installed":
        log("The unapproved source is installed as a temporary add-on in a separate Firefox test profile.")
    elif state == "starting":
        log("Firefox test profile is still starting; check the upload-firefox-test.log for status.")
    else:
        log("Local Firefox test launch failed; details are in build/logs/upload-firefox-test.log.")
    log("The temporary test profile does not alter your normal Firefox profile and closes with the test Firefox window.")
    return state


def submit_to_amo(
    npm: str,
    repo_root: Path,
    source_dir: Path,
    artifacts_dir: Path,
    credentials: tuple[str, str],
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> bool:
    command = build_amo_submit_command(npm, source_dir, artifacts_dir)
    env = signing_environment(*credentials)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    result = runner(
        command,
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    output = redact_credentials(result.stdout or "", credentials)
    error_output = redact_credentials(result.stderr or "", credentials)
    if output.strip():
        log(output.rstrip())
    if error_output.strip():
        log(error_output.rstrip())
    if result.returncode == 0:
        log("AMO accepted the listed submission request. Review may still be pending; public users will keep the approved version until Mozilla approves it.")
        return True
    log(f"AMO submission failed with exit code {result.returncode}; the local Firefox test can still be used.")
    return False


def run_upload_workflow(
    repo_root: Path,
    *,
    package_builder: Callable[[Path], tuple[str, Path, Path]] | None = None,
    npm_lookup: Callable[[], str | None] | None = None,
    local_launcher: Callable[[str, Path, Path], str] | None = None,
    credential_reader: Callable[[], tuple[str, str]] | None = None,
    amo_submitter: Callable[[str, Path, Path, Path, tuple[str, str]], bool] | None = None,
    upload: bool = True,
) -> list[str]:
    package_builder = package_builder or build_store_packages
    npm_lookup = npm_lookup or find_npm
    local_launcher = local_launcher or start_local_firefox
    credential_reader = credential_reader or read_amo_credentials
    amo_submitter = amo_submitter or submit_to_amo
    repo_root = repo_root.resolve()
    errors: list[str] = []

    version, source_dir, artifacts_dir = package_builder(repo_root)
    log(f"Prepared ChatGPT Queue + Optimizer v{version} for Firefox.")

    npm = npm_lookup()
    if not npm:
        errors.append("Node.js/npm is required for the AMO submission and temporary Firefox test.")
        log(errors[-1])
        return errors

    # Start local testing before submission. Mozilla review is independent of this
    # temporary install; users can test the exact source while approval is pending.
    try:
        local_state = local_launcher(npm, repo_root, source_dir)
    except Exception as error:
        local_state = "failed"
        log(f"Temporary Firefox test could not start: {error}")
    if local_state == "failed":
        errors.append("The temporary Firefox test did not start successfully; see its log in build/logs/.")

    if not upload:
        return errors

    try:
        credentials = credential_reader()
    except (EOFError, KeyboardInterrupt, RuntimeError, ValueError) as error:
        errors.append(f"AMO upload was not submitted: {error}")
        log(errors[-1])
        return errors

    try:
        submitted = amo_submitter(npm, repo_root, source_dir, artifacts_dir, credentials)
    except Exception as error:
        submitted = False
        log(f"AMO submission could not run: {error}")
    if not submitted:
        errors.append("AMO did not accept the listed submission request.")
    return errors


def main(argv: list[str] | None = None) -> int:
    default_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=default_root)
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="Build and launch the temporary Firefox test without submitting to AMO.",
    )
    args = parser.parse_args(argv)
    repo_root = args.repo_dir.resolve()
    if not (repo_root / "manifest.json").is_file():
        log(f"manifest.json was not found in {repo_root}.")
        return 1

    global LOG_PATH
    logs_dir = repo_root / "build" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    LOG_PATH = logs_dir / "upload.log"
    LOG_PATH.write_text("", encoding="utf-8")
    log("Starting ChatGPT Queue + Optimizer upload workflow.")
    try:
        errors = run_upload_workflow(repo_root, upload=not args.local_only)
    except Exception as error:
        log(f"Upload workflow failed: {error}")
        errors = [str(error)]
    log(f"Workflow log: {LOG_PATH}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
