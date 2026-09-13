#!/usr/bin/env python3
"""Read GPU/model readiness without loading models or changing the computer."""
import csv
import ctypes.util
import json
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

MODEL = 'Qwen3-VL-8B-Instruct-Q4_K_M'
MIN_VRAM_MIB = 12000
FILES = {'Qwen3VL-8B-Instruct-Q4_K_M.gguf': 5027784800,
         'mmproj-Qwen3VL-8B-Instruct-F16.gguf': 1159029824}


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return result.stdout[:16000] if result.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def detect(root=None):
    root = root or Path.home() / '.local/share/boardly-vision'
    system, arch = platform.system(), platform.machine()
    cards = []
    raw = command(['nvidia-smi', '--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])
    for fields in csv.reader(raw.splitlines()):
        try:
            name, total, free = fields
            cards.append({'name': name.strip()[:160], 'memory_mib': int(total), 'free_mib': int(free)})
        except (ValueError, TypeError):
            continue
    if not cards and system == 'Linux':
        for card in Path('/sys/class/drm').glob('card[0-9]*'):
            if not re.fullmatch(r'card\d+', card.name):
                continue
            try:
                device = card / 'device'
                vendor = (device / 'vendor').read_text().strip()
                if vendor != '0x1002':
                    continue
                total = int((device / 'mem_info_vram_total').read_text()) // 1048576
                used = int((device / 'mem_info_vram_used').read_text()) // 1048576
                name = (device / 'product_name').read_text().strip() if (device / 'product_name').is_file() else 'AMD GPU'
                cards.append({'name': name[:160], 'memory_mib': total, 'free_mib': max(0, total - used)})
            except (OSError, ValueError):
                continue
    binary = root / 'runtime-b10930/llama-b10930/llama-server'
    runtime_cards = []
    if binary.is_file():
        for line in command([str(binary), '--list-devices']).splitlines():
            match = re.match(r'\s*(Vulkan\d+): (.+) \((\d+) MiB, (\d+) MiB free\)', line)
            if match:
                device, name, total, free = match.groups()
                runtime_cards.append({'device': device, 'name': name[:160], 'memory_mib': int(total), 'free_mib': int(free)})
    if runtime_cards:
        cards = runtime_cards
    drivers = bool(runtime_cards) or bool(ctypes.util.find_library('vulkan'))
    present = {name: (root / name).is_file() and (root / name).stat().st_size == size for name, size in FILES.items()}
    service = False
    try:
        with urllib.request.urlopen('http://127.0.0.1:18765/health', timeout=2) as response:
            state = json.loads(response.read(4096))
        service = state.get('protocol') == 1 and state.get('model') == MODEL
    except Exception:
        pass
    disk_root = root if root.exists() else Path.home()
    free_bytes = shutil.disk_usage(disk_root).free
    missing_bytes = sum(size for name, size in FILES.items() if not present[name]) + (0 if binary.is_file() else 120000000)
    supported_os = system == 'Linux' and arch in ('x86_64', 'AMD64')
    enough_vram = any(c['memory_mib'] >= MIN_VRAM_MIB for c in cards)
    python_ok = sys.version_info >= (3, 11)
    tools_ok = bool(shutil.which('curl') and shutil.which('systemctl'))
    can_install = supported_os and enough_vram and drivers and python_ok and tools_ok and free_bytes >= missing_bytes + 268435456
    reasons = []
    if not supported_os: reasons.append('The current installer supports Linux x86_64. Connect a supported Linux computer.')
    if not cards: reasons.append('No graphics card was detected. Check that the GPU driver is installed.')
    elif not enough_vram: reasons.append('This vision setup requires a GPU with at least 12 GB of memory; 16 GB is recommended.')
    if not drivers: reasons.append('Install the graphics manufacturer’s Vulkan drivers first.')
    if not python_ok: reasons.append('Install Python 3.11 or newer first.')
    if not tools_ok: reasons.append('The installer requires curl and systemctl.')
    if free_bytes < missing_bytes + 268435456: reasons.append('Free enough disk space for the missing model files and setup.')
    return {'protocol': 1, 'os': system, 'architecture': arch, 'gpus': cards[:16],
            'vulkan_available': drivers, 'minimum_vram_mib': MIN_VRAM_MIB,
            'model': MODEL, 'model_files_present': all(present.values()),
            'runtime_present': binary.is_file(), 'service_available': service,
            'needs_install': not (all(present.values()) and binary.is_file() and service),
            'download_bytes': missing_bytes, 'disk_free_bytes': free_bytes,
            'can_install': can_install, 'reasons': reasons}


if __name__ == '__main__':
    print(json.dumps(detect()))
