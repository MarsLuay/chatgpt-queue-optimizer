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


@functools.lru_cache(maxsize=4)
def build_optimizer(repo_dir):
    repo = Path(repo_dir).resolve()
    source = repo / "rust" / "optimizer_core.rs"
    rustc = shutil.which("rustc")
    if not rustc:
        raise RuntimeError("Rust is required. Install rustup from https://rustup.rs/ and retry.")
    libdir = subprocess.check_output(
        [rustc, "--print", "target-libdir", "--target", TARGET], text=True
    ).strip()
    if not list(Path(libdir).glob("libcore-*.rlib")):
        rustup = shutil.which("rustup")
        if not rustup:
            raise RuntimeError(f"Missing Rust target {TARGET}. Install it using rustup target add {TARGET}.")
        subprocess.run([rustup, "target", "add", TARGET], check=True)
    build_dir = repo / "build"
    build_dir.mkdir(exist_ok=True)
    destination = repo / OUTPUT
    print("Building Rust optimizer (WebAssembly)...", flush=True)
    with tempfile.TemporaryDirectory(prefix="optimizer-wasm-", dir=build_dir) as temp:
        artifact = Path(temp) / OUTPUT
        subprocess.run([
            rustc, "--edition=2021", "--crate-name", "optimizer_core",
            "--crate-type", "cdylib", "--target", TARGET,
            "-C", "opt-level=z", "-C", "panic=abort",
            "-C", "strip=symbols", "-C", "link-arg=-zstack-size=16384",
            str(source), "-o", str(artifact),
        ], cwd=repo, check=True)
        if artifact.read_bytes()[:8] != b"\x00asm\x01\x00\x00\x00":
            raise RuntimeError("Rust compiler did not produce a valid WASM header.")
        # Replace only after a successful compilation.
        artifact.replace(destination)
    print(f"Rust optimizer built: {destination.name} ({destination.stat().st_size} bytes)", flush=True)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    build_optimizer(args.repo_dir.resolve())
