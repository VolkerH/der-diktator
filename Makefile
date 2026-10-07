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
	uv run --locked phonon-web

engine:
	FERMION_CACHE_DIR="$(CURDIR)/.cache/fermion" uv run --project engine fermion serve phonon-2 --port 8010

download-model:
	./scripts/download-model.sh
