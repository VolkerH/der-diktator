# syntax=docker/dockerfile:1
# Refresh these immutable inputs deliberately, then rebuild and run the smoke test.
FROM ghcr.io/astral-sh/uv:0.10.8@sha256:88234bc9e09c2b2f6d176a3daf411419eb0370d450a08129257410de9cfafd2a AS uv
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS runtime
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
# Keep all three suites on the same snapshot, newer than the pinned base image.
# Refresh the base digest and this date together, then rebuild and run smoke tests.
ARG DEBIAN_SNAPSHOT=20260301T000000Z
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
    && apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends libgomp1 libstdc++6 tini \
    && rm -rf /var/lib/apt/lists/*

FROM runtime AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /opt/diktator
COPY pyproject.toml uv.lock ./
COPY engine/pyproject.toml engine/uv.lock ./engine/
# Exclude the local application from both environments while caching third-party wheels.
# The engine is virtual, so --no-install-project alone would still install diktator.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project \
    && uv sync --project engine --locked --no-dev --no-install-project --no-install-package diktator
COPY README.md LICENSE.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable \
    && uv sync --project engine --locked --no-dev --no-editable
COPY packaging/inventory.py ./inventory.py
RUN .venv/bin/python inventory.py > /opt/web-dependencies.json \
    && engine/.venv/bin/python inventory.py > /opt/engine-dependencies.json \
    && dpkg-query -W > /opt/system-dependencies.txt

FROM runtime
LABEL org.opencontainers.image.title="Der Diktator" \
      org.opencontainers.image.source="https://github.com/VolkerH/der-diktator" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /opt/diktator
COPY --from=build /opt/diktator/.venv ./.venv
COPY --from=build /opt/diktator/engine/.venv ./engine/.venv
COPY --from=build /opt/*-dependencies.* ./licenses/
COPY LICENSE.md ./licenses/
COPY docs ./docs
COPY README.md pyproject.toml uv.lock ./
COPY engine/pyproject.toml engine/uv.lock ./engine/
RUN groupadd --gid 10001 diktator \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp diktator \
    && mkdir -p /data /models \
    && chown diktator:diktator /data /models
ENV DIKTATOR_DATA_DIR=/data DIKTATOR_MODELS_DIR=/models \
    DIKTATOR_ENGINE_URL=http://127.0.0.1:8010 \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HF_HUB_DISABLE_TELEMETRY=1
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/opt/diktator/.venv/bin/python", "-m", "diktator.container", "--healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/diktator/.venv/bin/python", "-m", "diktator.container"]
