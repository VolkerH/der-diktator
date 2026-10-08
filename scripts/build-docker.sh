#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# No registry push: build and load one Linux CPU image into the local daemon.
exec docker buildx build --platform linux/amd64 --load \
  --tag "${1:-der-diktator:local}" "$task_root"
