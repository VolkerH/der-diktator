#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -d "$task_root/.git-local" ]]; then
  exec git --git-dir="$task_root/.git-local" --work-tree="$task_root" "$@"
fi
exec git -C "$task_root" "$@"
