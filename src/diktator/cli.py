"""Entry point for the local browser-facing service."""

import argparse
from pathlib import Path

import uvicorn

from diktator.app import create_app
from diktator.config import (
    Settings,
    default_data_directory,
    legacy_data_directory,
    migrate_chats,
)


def main() -> None:
    """Bind to localhost, which Windows browsers can access through WSL forwarding."""
    parser = argparse.ArgumentParser(
        description="Run Der Diktator, a local dictation and transcription web app."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="Where chats are stored (default: $DIKTATOR_DATA_DIR or ~/.diktator/chats).",
    )
    arguments = parser.parse_args()
    settings = Settings.from_environment(
        arguments.data_dir.expanduser() if arguments.data_dir else None
    )
    if settings.data_directory == default_data_directory() and migrate_chats(
        legacy_data_directory(), settings.data_directory
    ):
        print(f"Moved existing chats from {legacy_data_directory()}", flush=True)
    print(f"Storing chats in {settings.data_directory}", flush=True)
    uvicorn.run(create_app(settings), host=arguments.host, port=arguments.port)
