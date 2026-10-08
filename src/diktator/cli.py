"""Entry point for the local browser-facing service."""

import argparse
import logging
from pathlib import Path

import uvicorn

from diktator.app import create_app
from diktator.config import Settings, default_data_directory
from diktator.db import DATABASE_NAME, StorageInUse
from diktator.storage import open_storage


def main() -> None:
    """Bind to localhost by default; a VPN proxy or --host exposes it to other devices."""
    parser = argparse.ArgumentParser(
        description="Run Der Diktator, a local dictation and transcription web app."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--data-dir",
        type=Path,
        help=f"Where chats are stored (default: $DIKTATOR_DATA_DIR or {default_data_directory()}).",
    )
    parser.add_argument(
        "--ssl-certfile",
        type=Path,
        help="Serve HTTPS with this certificate; browsers need HTTPS for the microphone.",
    )
    parser.add_argument("--ssl-keyfile", type=Path, help="Private key for --ssl-certfile.")
    arguments = parser.parse_args()
    if bool(arguments.ssl_certfile) != bool(arguments.ssl_keyfile):
        parser.error("--ssl-certfile and --ssl-keyfile must be given together.")
    settings = Settings.from_environment(
        arguments.data_dir.expanduser() if arguments.data_dir else None
    )
    print(f"Storing chats in {settings.data_directory}", flush=True)
    print(f"Database: {settings.data_directory / DATABASE_NAME}", flush=True)
    # Open before Uvicorn's lifespan exception handler so expected lock refusal
    # is a concise CLI error. The same owner is handed to the application's lifespan.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        storage = open_storage(settings)
    except StorageInUse as error:
        parser.exit(1, f"{error}\n")
    try:
        uvicorn.run(
            create_app(settings, storage=storage),
            host=arguments.host,
            port=arguments.port,
            ssl_certfile=arguments.ssl_certfile,
            ssl_keyfile=arguments.ssl_keyfile,
        )
    finally:
        # Also release if server setup fails before lifespan starts.
        storage.close()
