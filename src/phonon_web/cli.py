"""Entry point for the local browser-facing service."""

import argparse
from pathlib import Path

import uvicorn

from phonon_web.app import create_app
from phonon_web.config import Settings


def main() -> None:
    """Bind to localhost, which Windows browsers can access through WSL forwarding."""
    parser = argparse.ArgumentParser(description="Run the local Phonon dictation web app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="Where chats are stored (default: $PHONON_DATA_DIR or ~/.phonon/chats).",
    )
    arguments = parser.parse_args()
    settings = Settings.from_environment(
        arguments.data_dir.expanduser() if arguments.data_dir else None
    )
    print(f"Storing chats in {settings.data_directory}", flush=True)
    uvicorn.run(create_app(settings), host=arguments.host, port=arguments.port)
