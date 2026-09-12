#!/usr/bin/env python3
"""Install pinned, verified Qwen3-VL weights and a portable llama.cpp runtime."""
import argparse
import hashlib
import json
import os
import platform
import fcntl
from pathlib import Path
import subprocess
import tarfile

STATUS_ROOT = None


def status(state, message):
    if STATUS_ROOT:
        temporary = STATUS_ROOT / 'install-status.tmp'
        temporary.write_text(json.dumps({'status': state, 'message': message}) + '\n')
        temporary.replace(STATUS_ROOT / 'install-status.json')

REVISION = "f982a07559d4a2f6c8744d840bf6fccab30eea96"
HF = f"https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/{REVISION}/"
ASSETS = [
    ("Qwen3VL-8B-Instruct-Q4_K_M.gguf", HF + "Qwen3VL-8B-Instruct-Q4_K_M.gguf", "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2"),
    ("mmproj-Qwen3VL-8B-Instruct-F16.gguf", HF + "mmproj-Qwen3VL-8B-Instruct-F16.gguf", "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38"),
    ("llama-b10930-bin-ubuntu-vulkan-x64.tar.gz", "https://github.com/ggml-org/llama.cpp/releases/download/b10930/llama-b10930-bin-ubuntu-vulkan-x64.tar.gz", "4b257f7866a0e844904c96a8406afbfaa0b44fd69e08db3673e4cc5536d3d7eb"),
]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    global STATUS_ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--service", action="store_true", help="Install and start the private user service")
    args = parser.parse_args()
    root = args.directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATUS_ROOT = root
    lock = (root / 'install.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('GPU installation is already running.', flush=True)
        return
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise RuntimeError('This installer currently supports Linux x86_64 with Vulkan GPU drivers. Windows and macOS need a separate supported connector.')
    for name, url, expected in ASSETS:
        dest = root / name
        if dest.exists() and digest(dest) == expected:
            print(json.dumps({"asset": name, "status": "already_verified"}), flush=True)
            continue
        partial = dest.with_suffix(dest.suffix + ".part")
        status('installing', 'Downloading and verifying ' + name)
        print(json.dumps({"asset": name, "status": "downloading"}), flush=True)
        subprocess.run(["curl", "--fail", "--location", "--retry", "4", "--continue-at", "-", "--output", str(partial), url], check=True)
        if digest(partial) != expected:
            raise RuntimeError("Downloaded asset failed SHA-256 verification: " + name)
        partial.replace(dest)
        print(json.dumps({"asset": name, "status": "verified", "sha256": expected}), flush=True)
    runtime = root / "runtime-b10930"
    runtime.mkdir(exist_ok=True)
    with tarfile.open(root / ASSETS[-1][0]) as archive:
        archive.extractall(runtime, filter="data")
    binaries = list(runtime.rglob("llama-server"))
    if len(binaries) != 1:
        raise RuntimeError("Expected one llama-server binary")
    manifest = {"model_revision": REVISION, "runtime": "b10930", "binary": str(binaries[0]), "model": str(root / ASSETS[0][0]), "projector": str(root / ASSETS[1][0]), "assets": [{"name": n, "sha256": h} for n, _, h in ASSETS]}
    (root / "installation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.service:
        status('installing', 'Checking the GPU and starting private vision')
        devices = subprocess.check_output([str(binaries[0]), '--list-devices'], cwd=binaries[0].parent, text=True, stderr=subprocess.STDOUT)
        if 'Vulkan0:' not in devices:
            raise RuntimeError('No Vulkan GPU was detected. Install the GPU manufacturer’s Vulkan drivers and retry.')
        if not (root / 'serve.py').is_file():
            raise RuntimeError('The private vision service script is missing. Run setup again.')
        unit = Path.home() / '.config/systemd/user/boardly-vision.service'
        unit.parent.mkdir(parents=True, exist_ok=True)
        # Quoting is for systemd, not a shell. No downloaded file is passed to a shell.
        program = str(root / 'serve.py').replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
        unit.write_text('[Unit]\nDescription=Private Boardly Qwen vision\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/python3 "' + program + '"\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n')
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'boardly-vision.service'], check=True)
    status('installed', 'Qwen is installed. Test the GPU in Boardly before selecting it.')
    print(json.dumps({"status": "installed", "binary": str(binaries[0])}), flush=True)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        status('error', str(error)[:500])
        raise
