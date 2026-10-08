#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$task_root"
uv sync --project engine
uv sync --locked
task_engine_pid=""
task_web_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$task_web_pid" ]]; then kill "$task_web_pid" 2>/dev/null || true; fi
  if [[ -n "$task_engine_pid" ]]; then kill "$task_engine_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
engine/.venv/bin/python -m diktator.inference serve --port 8010 &
task_engine_pid=$!
.venv/bin/diktator &
task_web_pid=$!
printf 'Open http://localhost:8080 in your Windows browser. Ctrl-C stops both services.\n'
set +e
wait -n "$task_engine_pid" "$task_web_pid"
task_exit=$?
set -e
exit "$task_exit"
