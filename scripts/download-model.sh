#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
uv sync --project "$task_root/engine"
uv run --project "$task_root/engine" python -m diktator.inference download "${1:-phonon-2}"
