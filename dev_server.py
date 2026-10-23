from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
IGNORED_DIRECTORIES = {
    ".git",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "backup",
    "tests",
    "uploads",
}


def python_source_signature():
    signature = []
    for current, directories, files in os.walk(ROOT):
        directories[:] = [
            name for name in directories if name not in IGNORED_DIRECTORIES
        ]
        for filename in files:
            if not filename.endswith(".py"):
                continue
            path = Path(current) / filename
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            signature.append((
                path.relative_to(ROOT).as_posix(),
                stat.st_mtime_ns,
                stat.st_size,
            ))
    return tuple(sorted(signature))


def start_server():
    environment = os.environ.copy()
    environment["DASHBOARD_DEV_RELOAD"] = "1"
    return subprocess.Popen(
        [sys.executable, str(ROOT / "server.py")],
        cwd=ROOT,
        env=environment,
    )


def stop_server(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    signature = python_source_signature()
    process = start_server()
    print("Watching Python and static files for local dashboard changes.")
    try:
        while process.poll() is None:
            time.sleep(0.5)
            current_signature = python_source_signature()
            if current_signature == signature:
                continue
            print("Python code changed; restarting the local dashboard server.")
            stop_server(process)
            signature = current_signature
            process = start_server()
    except KeyboardInterrupt:
        print("\nStopping local dashboard.")
    finally:
        stop_server(process)


if __name__ == "__main__":
    main()
