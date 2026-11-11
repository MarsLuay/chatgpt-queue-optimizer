#!/usr/bin/env python3
"""Validate, version, submit, and push a Firefox extension release from main."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

import upload_extension


def run_command(command: list[str], repo_root: Path, *, capture: bool = False) -> str:
    result = subprocess.run(command, cwd=repo_root, capture_output=capture, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{command[0]} {command[1]} failed (exit {result.returncode}).")
    return (result.stdout or "").rstrip("\r\n")


def bump_patch_version(path: Path) -> tuple[str, str]:
    source = path.read_text(encoding="utf-8")
    version = json.loads(source).get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Expected a three-part numeric extension version in manifest.json.")
    major, minor, patch = (int(part) for part in version.split("."))
    new_version = f"{major}.{minor}.{patch + 1}"
    pattern = r'(?m)^([ \t]*"version"[ \t]*:[ \t]*")' + re.escape(version) + r'("[ \t]*,?)'
    updated, count = re.subn(pattern, lambda match: match[1] + new_version + match[2], source)
    if count != 1 or json.loads(updated).get("version") != new_version:
        raise RuntimeError("Could not safely update the manifest version.")
    path.write_text(updated, encoding="utf-8")
    return version, new_version


def managed_publish(
    repo_root: Path,
    *,
    command_runner: Callable[..., str] = run_command,
    npm_lookup: Callable[[], str | None] = upload_extension.find_npm,
    credentials_reader: Callable[[], tuple[str, str]] = upload_extension.read_amo_credentials,
    upload_runner: Callable[..., list[str]] = upload_extension.run_upload_workflow,
) -> str:
    repo_root = repo_root.resolve()
    manifest_path = repo_root / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("manifest.json not found in repository root.")
    git = shutil.which("git")
    npm = npm_lookup()
    if not git or not npm:
        raise RuntimeError("Git and Node.js/npm must be installed before publishing.")

    def run(*args: str, capture: bool = False) -> str:
        return command_runner([*args], repo_root, capture=capture)

    if Path(run(git, "rev-parse", "--show-toplevel", capture=True)).resolve() != repo_root:
        raise RuntimeError("Run from the root of the intended Git checkout.")
    if run(git, "branch", "--show-current", capture=True) != "main":
        raise RuntimeError("Publishing requires the main branch.")
    if run(git, "status", "--porcelain", "--untracked-files=normal", capture=True):
        raise RuntimeError("Working tree has uncommitted/untracked files. Commit or stash them first.")
    run(git, "remote", "get-url", "origin", capture=True)

    upload_extension.log("Fetching the latest origin/main (fast-forward only).")
    run(git, "pull", "--ff-only", "origin", "main")
    if run(git, "status", "--porcelain", "--untracked-files=normal", capture=True):
        raise RuntimeError("Working tree is not clean after pulling main.")
    upload_extension.log("Installing pinned development dependencies.")
    run(npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund")
    upload_extension.log("Running npm run check before any version change or submission.")
    run(npm, "run", "check")
    upload_extension.log("Running Python packaging and release regression tests.")
    run(sys.executable, "-m", "unittest", "discover", "-s", "Installers", "-p", "test_*.py")

    # Verify credentials before touching the manifest. Never print the credentials.
    credentials = credentials_reader()
    original_manifest = manifest_path.read_bytes()
    _old, version = bump_patch_version(manifest_path)
    upload_extension.log(f"Prepared Firefox version {version}.")
    submission_started = False
    try:
        submission_started = True
        errors = upload_runner(
            repo_root,
            credential_reader=lambda: credentials,
            require_local_test=False,
        )
        if errors:
            raise RuntimeError("Firefox AMO did not confirm the submission; see the upload log.")
        # The upload can create only ignored build files; never stage anything else.
        changes = run(git, "status", "--porcelain", "--untracked-files=normal", capture=True).splitlines()
        if changes != [" M manifest.json"]:
            raise RuntimeError("Unexpected working-tree changes after upload; refusing automatic commit.")
        run(git, "add", "--", "manifest.json")
        run(git, "commit", "-m", f"chore(release): Firefox extension v{version}")
        run(git, "push", "origin", "main")
    except Exception:
        if not submission_started:
            manifest_path.write_bytes(original_manifest)
        else:
            upload_extension.log(
                "Keeping the bumped manifest and any local release commit because the "
                "AMO submission may already exist. Inspect the submission and Git status "
                "before retrying; never force-push or blindly resubmit the same version."
            )
        raise
    upload_extension.log(
        f"AMO submission requested and release v{version} committed/pushed to origin/main. "
        "Mozilla review may still be pending."
    )
    return version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        root = args.repo_dir.resolve()
        log_path = root / "build" / "logs" / "upload.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("", encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"[ERROR] Could not initialize the release directory or upload log: {error}", file=sys.stderr)
        print("Check the repository path and upload.bat quoting, then retry.", file=sys.stderr)
        return 1
    upload_extension.LOG_PATH = log_path
    try:
        managed_publish(root)
        return 0
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        upload_extension.log(f"Release stopped: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
