MODEL ?= phonon-2

.PHONY: setup check format run web engine download-model

setup:
	uv sync --locked
	npm ci

check:
	uv run --locked ruff format --check .
	uv run --locked ruff check .
	uv run --locked ty check
	uv run --locked pytest
	npm run check

format:
	uv run --locked ruff format .
	uv run --locked ruff check --fix .
	npm run format

run:
	./scripts/run.sh

web:
	uv run --locked diktator

engine:
	uv run --project engine python -m diktator.inference serve --port 8010

download-model:
	./scripts/download-model.sh $(MODEL)
