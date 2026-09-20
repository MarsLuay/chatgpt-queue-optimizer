#!/usr/bin/env python3
"""Reject PEM private-key material in Git-tracked files without echoing contents."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


PEM_BEGIN = b"-" * 5 + b"BEGIN "
PEM_END = b"-" * 5
PRIVATE_KEY_LABEL = b"PRIVATE" + b" KEY"


def has_private_key_header(data: bytes) -> bool:
    """Return whether data contains a syntactically plausible private-key PEM header."""
    for raw_line in data.splitlines():
        line = raw_line.strip()
        if not (line.startswith(PEM_BEGIN) and line.endswith(PEM_END)):
            continue
        label = line[len(PEM_BEGIN) : -len(PEM_END)]
        if PRIVATE_KEY_LABEL not in label:
            continue
        if all(char == 0x20 or 0x30 <= char <= 0x39 or 0x41 <= char <= 0x5A for char in label):
            return True
    return False


def tracked_paths(repo_root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("could not enumerate tracked files")
    return [os.fsdecode(value) for value in result.stdout.split(b"\0") if value]


def path_is_inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def check_repository(repo_root: Path) -> tuple[list[str], list[str]]:
    root = repo_root.resolve()
    violations: list[str] = []
    read_errors: list[str] = []

    for relative_name in tracked_paths(root):
        path = root / Path(relative_name)
        if path.is_symlink() or not path.is_file():
            continue
        resolved = path.resolve()
        if not path_is_inside(root, resolved):
            read_errors.append(relative_name)
            continue
        try:
            data = path.read_bytes()
        except OSError:
            read_errors.append(relative_name)
            continue
        if has_private_key_header(data):
            violations.append(relative_name)

    return violations, read_errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root to scan (default: the parent of this script's directory)",
    )
    args = parser.parse_args()

    try:
        violations, read_errors = check_repository(args.repo_root)
    except (OSError, RuntimeError):
        print("ERROR: tracked-file secret check could not inspect the repository.", file=sys.stderr)
        return 2

    if read_errors:
        for relative_name in read_errors:
            print(f"ERROR: tracked file could not be inspected safely: {relative_name}", file=sys.stderr)
        return 2

    if violations:
        for relative_name in violations:
            print(
                "ERROR: tracked file contains prohibited PEM private-key material: "
                f"{relative_name}",
                file=sys.stderr,
            )
        return 1

    print("Tracked-file secret check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
