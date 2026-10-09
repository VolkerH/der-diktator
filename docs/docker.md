# Run Der Diktator in Docker

This package runs the browser server and CPU inference service on **Linux amd64**.
It needs Docker Engine with Compose v2; Python, Node and uv are only needed when
working on the source outside Docker. Windows through Docker Desktop's Linux
backend is a candidate deployment; native Windows/macOS installers, ARM images
and GPU acceleration are separate work in #8 and #13.

## Build and start

From this repository:

```sh
./scripts/build-docker.sh
# Equivalent: docker compose build
docker compose up -d --no-build
docker compose logs -f
```

Open <http://localhost:8080>. In **Speech models**, explicitly download a model,
then select **Use model**. The image contains all runtime dependencies and no
weights. Starting it performs no package installation or model download. An
already selected, installed model loads again on restart.

Compose publishes only `127.0.0.1:8080`. For a different host port, set
`DIKTATOR_PORT=8081` in the project's `.env` file, then run
`docker compose up -d --no-build`. Keep persistent deployment choices in that
file so later Compose commands use the same values. The inference services stay
on container loopback ports 8010 and 8011; do not publish them.
For phone microphone access use HTTPS through a private reverse proxy or VPN,
as described in [Using it from your phone](../README.md#using-it-from-your-phone).
The same absence of authentication described in the README applies to Docker.

Without Compose:

```sh
docker run -d --name diktator \
  --publish 127.0.0.1:8080:8080 \
  --mount source=diktator_data,target=/data \
  --mount source=diktator_models,target=/models \
  --stop-timeout 30 \
  der-diktator:local
```

The Docker image can be moved to a host without a source checkout:
`docker save der-diktator:local -o diktator.tar`, transfer it, then
`docker load -i diktator.tar`. Use the `docker run` command above there. No image
is automatically published to a registry. Downloading a missing model still
requires internet access; installed models support offline startup.

## Storage and configuration

The process runs as UID/GID **10001:10001**. Docker initializes new named volumes
with the image directories' ownership. The default volume names are always
`diktator_data` and `diktator_models`, independent of the Compose project name.
For separate deployments, set both `DIKTATOR_DATA_VOLUME` and
`DIKTATOR_MODELS_VOLUME` to distinct names in each deployment's `.env`.
If an existing deployment used a custom project name, save its actual volume
names in those settings before starting this version. Changing `-p` alone does
not select separate storage.
`docker compose down` preserves them. **Do not use
`down --volumes` for an upgrade**: it deletes the stored application data.

| Setting                  | Container value      | Purpose                                                        |
| ------------------------ | -------------------- | -------------------------------------------------------------- |
| `DIKTATOR_DATA_DIR`      | `/data`              | SQLite, preferences, chats, recordings and migration snapshots |
| `DIKTATOR_MODELS_DIR`    | `/models`            | Installed weights, download staging and saved model selection  |
| `DIKTATOR_CPU_THREADS`   | `4` in Compose       | Existing Parakeet/Whisper CPU setting                          |
| `DIKTATOR_PORT`          | `8080`               | Compose host port only; container web port stays 8080          |
| `DIKTATOR_IMAGE`         | `der-diktator:local` | Compose image tag; use a versioned tag for upgrades            |
| `DIKTATOR_DATA_VOLUME`   | `diktator_data`      | Compose data volume name; persist a restored volume here       |
| `DIKTATOR_MODELS_VOLUME` | `diktator_models`    | Compose model volume name; persist a restored volume here      |

Changing a directory environment variable requires a corresponding writable
mount at that path. The launcher owns the inference endpoint and fixes
`DIKTATOR_ENGINE_URL` to `http://127.0.0.1:8010`. There is no container-specific
preferences store: the existing preferences API writes SQLite on `/data`.
Other limits retain the application's current defaults. Configure environment
changes by recreating the container; do not edit files in its writable layer.

Local named volumes are the supported storage route. Bind mounts need existing
directories writable by UID 10001, and filesystem locking and durability must
work. Do not use a network filesystem for SQLite. Validate WSL/Windows host
mounts in the actual setup; Docker Desktop volumes and host bind mounts have
different behavior. An unwritable directory makes startup fail.

The image also supports a read-only root filesystem with writable `/data`,
`/models`, and `/tmp` (for example `--read-only --tmpfs /tmp`). No GPU, privileged
mode or host Docker socket is needed. Ensure enough memory and disk space for
the chosen model and temporary downloads; model sizes are in the picker and
[README](../README.md#quick-start).

## Health and the client API

Docker health means the web service can query the inference model catalog.
A new installation with no weights is healthy. `GET /api/health` reports
`ready: false` until a usable model is loaded; `GET /api/models` reports
capabilities, installation/loading state and errors. A failed service causes
the launcher to terminate its peer and exit nonzero. SIGTERM stops both process
groups, including downloads and the Phonon subprocess; Tini reaps descendants.
Allow at least 25 seconds before Docker forcibly kills the container.

The browser and other clients use the same routes. HTTP schemas are available at
`/openapi.json` and `/docs`. See [chat API](chat-api.md),
[preferences/export API](preferences-export-api.md),
[error and event conventions](api-conventions.md), and
[error schema reference](api-errors.md). These documents are also installed in
`/opt/diktator/docs` inside the image. This packaging does not change the API;
use clients tested with the same release and tolerate additive response fields.

Batch audio uses `POST /api/transcribe?model=...` with PCM WAV; persist the WAV
through the chat recording endpoint as needed. Phonon live text uses
`/api/stream?model=phonon-2`: wait for the `ready` event, then send binary mono
16 kHz, signed 16-bit little-endian PCM frames, then `{"type":"end"}`. Events
are `ready`, `partial`, `final`, `done`, or terminal `error`. The web service supplies
the internal engine configuration; clients do not send it. Only `done` confirms success.
Retain a complete WAV until storage acknowledgement so streaming errors can be
retried as batch audio. The browser implements this already. See the
[streaming description](../README.md#how-it-works) and source contract in
`src/diktator/streaming.py` for limits and cancellation behavior.

## Backup, upgrade and rollback

A complete backup includes **the entire data volume**, including audio. Startup
migration snapshots under `/data/backups` contain SQLite only and cannot replace
that backup. Also save the model volume to avoid downloading weights again and
to retain model selection. Stop both services before copying either volume.

These commands discover the active image and named volumes from the existing
Compose container, including deployments that have already been restored.
Run the complete block; its subshell stops on any failure without closing your
interactive shell. A missing container or named mount aborts before creating
archives. If the container was removed with `docker compose down`, recover its
deployment configuration and identify its existing volumes before proceeding;
do not treat a failed backup as permission to upgrade.

```sh
(
set -eu
docker compose stop
container_id=$(docker compose ps --all --quiet diktator)
: "${container_id:?No Compose container found; backup aborted}"
data_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id")
models_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Name}}{{end}}{{end}}' "$container_id")
: "${data_volume:?No named data volume found; backup aborted}"
: "${models_volume:?No named model volume found; backup aborted}"
docker volume inspect "$data_volume" "$models_volume" > /dev/null
# Keep the actual old image locally for a possible rollback.
image_id=$(docker inspect --format '{{.Image}}' "$container_id")
: "${image_id:?No container image found; backup aborted}"
docker image tag "$image_id" der-diktator:before-upgrade
# Each archive is streamed to the host; no host-directory permission adjustment is needed.
mkdir -p backups
docker run --rm --entrypoint tar --mount "source=$data_volume,target=/data,readonly" \
  der-diktator:before-upgrade -C /data -czf - . > backups/data.tar.gz
docker run --rm --entrypoint tar --mount "source=$models_volume,target=/models,readonly" \
  der-diktator:before-upgrade -C /models -czf - . > backups/models.tar.gz
)
```

Check that the archives list and extract successfully before upgrading. Store
them separately from the Docker host. Build a selected source revision with
`./scripts/build-docker.sh der-diktator:next`. Create or edit the project's `.env`
file and set this key, preserving its other settings:

```dotenv
DIKTATOR_IMAGE=der-diktator:next
```

Then verify the resolved image and start it. Shell environment variables take
precedence over `.env`; remove an old exported override if the resolved image
does not match. Do not select an upgrade image only for a single command:
ordinary subsequent Compose commands must keep selecting the new image.

```sh
docker compose config --images
docker compose up -d --no-build
docker compose logs --tail=100
docker compose ps
```

The web app includes all Alembic migrations and backs up an existing database
before upgrading its schema. Verify chats, preferences, audio playback and model
readiness before discarding the old image or backup. Avoid running two instances
against the same data or model volume; the application refuses concurrent owners.

For rollback, stop the new container and restore the pre-upgrade archives to
**new, empty volumes**. An older image intentionally refuses an unknown newer
schema; changing only the image is not a database downgrade.

```sh
(
set -eu
docker compose down
restore_id=$(date -u +%Y%m%dT%H%M%SZ)
restored_data="diktator_restored_data_$restore_id"
restored_models="diktator_restored_models_$restore_id"
docker volume create "$restored_data"
docker volume create "$restored_models"
# Root is used only by these one-shot restore commands to preserve archived ownership.
docker run --rm -i --user 0:0 --entrypoint tar \
  --mount "source=$restored_data,target=/data" \
  der-diktator:before-upgrade -C /data -xzf - < backups/data.tar.gz
docker run --rm -i --user 0:0 --entrypoint tar \
  --mount "source=$restored_models,target=/models" \
  der-diktator:before-upgrade -C /models -xzf - < backups/models.tar.gz
# These are the three entries to set in .env for the restored deployment.
printf 'DIKTATOR_IMAGE=der-diktator:before-upgrade\nDIKTATOR_DATA_VOLUME=%s\nDIKTATOR_MODELS_VOLUME=%s\n' \
  "$restored_data" "$restored_models"
)
```

Update those three keys in `.env`, preserving the other entries such as
`DIKTATOR_CPU_THREADS` and `DIKTATOR_PORT`. Run `docker compose config` and check
the image and both resolved volume names before starting:

```sh
docker compose up -d --no-build
docker compose logs --tail=100
docker compose ps
```

The restored deployment remains under Compose, with its restart policy, CPU
setting, and selected volumes. Later ordinary Compose commands keep using the
restored volumes. Retain the failed upgrade volumes for diagnosis; do not point
the older image at them. These examples cover named volumes; host bind mounts
need their own stopped-directory backup and restore procedure.
Compose may report that the restored volumes were created outside Compose;
it still mounts the explicit names selected above.

## Build inputs, licenses and validation

The Dockerfile pins the Python and uv images by digest, the Debian package
snapshots by date for `bookworm`, `bookworm-updates`, and `bookworm-security`
(the latter from the separate Debian security archive), and uses both committed
uv lockfiles with `--locked`. Both
application installs are non-editable and include static assets and migrations.
Node and source checkout metadata are excluded. This fixes dependency inputs;
it does not promise byte-identical image archives. Refresh the base digests and
snapshot date together for security updates, and repeat validation before release.
The date must cover the base image's package versions. Frozen security sources
provide updates available at that snapshot, not automatic current updates.
Native packages are upgraded from these coherent sources before installation.
Third-party Python dependencies are installed before copying application source,
so source edits reuse that build layer. Local virtual environments are excluded
from the build context.
The layout follows [uv's Docker guide](https://docs.astral.sh/uv/guides/integration/docker/)
and [Docker's process-management guidance](https://docs.docker.com/engine/containers/multi-service_container/).

`/opt/diktator/licenses/` contains the project license and actual web, inference
and system dependency inventories. Python distributions retain their own license
files in `*.dist-info`; system license notices are in `/usr/share/doc`. The
image license label refers to this project's code, not all dependencies.
Model weights are excluded; their sources and license names are shown by
`GET /api/models` and discussed in the [README license section](../README.md#license-and-credits).

Run the model-free artifact acceptance test after building:

```sh
uv run --locked python scripts/smoke-docker.py der-diktator:local
```

It uses disposable named volumes and containers, disables container networking,
checks packaged native imports, exercises HTTP APIs, replaces the container,
checks persistence, tests unwritable storage, and verifies bounded shutdown.
The **Docker CPU packaging** GitHub Actions workflow builds and runs this check
on manual request, without publishing an image. Open **Actions → Docker CPU
packaging → Run workflow** and choose the branch to validate, or run:

```sh
gh workflow run docker.yaml --ref main
```

Pull requests and pushes do not trigger Docker builds. The check establishes
packaging behavior, not microphone access or transcription quality. Real model
load/transcription and Phonon streaming need separate checks on the deployment
hardware; ARM emulation, GPU execution and native installers are not covered.
