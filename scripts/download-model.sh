#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export FERMION_CACHE_DIR="$task_root/.cache/fermion"
uv sync --project "$task_root/engine"
uv run --locked --project "$task_root/engine" fermion transcribe phonon-2 --download-only unused.wav
