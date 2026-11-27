#!/usr/bin/env python3
"""Compile the dependency-free Rust optimizer to a packaged WASM artifact."""
import argparse
import functools
import shutil
import subprocess
import tempfile
from pathlib import Path

TARGET = "wasm32-unknown-unknown"
OUTPUT = "optimizer_core.wasm"
BROWSER_OUTPUT = "optimizer_browser.wasm"
HISTORY_OUTPUT = "optimizer_history.wasm"
QUEUE_OUTPUT = "optimizer_queue.wasm"


@functools.lru_cache(maxsize=4)
def build_optimizer(repo_dir):
    """Compatibility entry point; Rust owns artifact generation."""
    repo = Path(repo_dir).resolve()
    cargo = shutil.which("cargo")
    if not cargo:
        raise RuntimeError("Rust/Cargo is required. Install rustup and retry.")
    subprocess.run([cargo, "run", "--release", "--manifest-path",
                    str(repo / "Installers" / "native" / "Cargo.toml"),
                    "--", "build", "--repo-dir", str(repo)], check=True)
    return repo / OUTPUT


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    build_optimizer(args.repo_dir.resolve())
