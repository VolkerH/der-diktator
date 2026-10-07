"""Entry point for the local browser-facing service."""

import argparse

import uvicorn

from phonon_web.app import create_app


def main() -> None:
    """Bind to localhost, which Windows browsers can access through WSL forwarding."""
    parser = argparse.ArgumentParser(description="Run the local Phonon dictation web app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    arguments = parser.parse_args()
    uvicorn.run(create_app(), host=arguments.host, port=arguments.port)
