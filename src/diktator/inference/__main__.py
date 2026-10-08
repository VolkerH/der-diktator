"""Start the model service or explicitly install a model from the command line."""

import argparse
import asyncio

import uvicorn

from diktator.inference.store import ModelStore, models_directory
from diktator.models import CATALOG, model_info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8010)
    download = commands.add_parser("download")
    download.add_argument("model", choices=[model.id for model in CATALOG])
    args = parser.parse_args()
    if args.command == "download":
        store = ModelStore(models_directory())
        asyncio.run(store.install(model_info(args.model).id, print))
        print(f"Installed: {store.path(args.model)}")
    else:
        uvicorn.run(
            "diktator.inference.server:create_engine",
            factory=True,
            host="127.0.0.1",
            port=args.port,
        )


if __name__ == "__main__":
    main()
