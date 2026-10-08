# 0001. SQLite application data, audio and models as files

Status: Accepted (2026-10-08)

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) — issue description,
[architecture review](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060520952),
[review of the reviews](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479),
[accepted corrections](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061509440).

## Context

Chats are stored as one folder each with `chat.json` and WAV files (`src/diktator/chats.py`). The
roadmap adds titles (#2), search (#11), groups (#14), preferences (#9), sharing history (#3), edit
history and shared chats (#16). The earlier issue plans would each have built revisions, locking,
registries or deferred cleanup on top of JSON files. The target is a personal/family application
with simple local or self-hosted deployment.

## Decision

- Store application data in **SQLite**, accessed with **SQLAlchemy 2**, migrated with
  **Alembic**. Public request/response/event models are separate **Pydantic** models; persistence
  rows are never exposed directly. Add request/response model variants only when an endpoint needs
  them.
- Keep **recordings and model weights as files**. The database stores audio metadata and paths
  relative to the data root, keyed by stable chat/recording IDs.
- The **web application owns the database**. The inference service never accesses it; its jobs
  and progress live in engine memory. The engine owns the instance's loaded/preferred model.
- **Application preferences** live in SQLite. **Operator configuration** (bindings, directories,
  hard limits) stays in configuration file, environment and CLI, with explicit precedence.
- Build this foundation **before** features that would otherwise extend JSON persistence (#2, #11,
  #14, the preference slice of #4/#9, #3 history). A small feature need not wait for all of #15.

### SQLite operation

- Short synchronous units of work off the event loop (plain `def` routes or a threadpool); one
  engine per process; sessions never shared between threads. Inference and file processing never
  run inside a database transaction.
- Per connection: `foreign_keys=ON`, WAL, a busy timeout, and **`synchronous=FULL`** initially.
  Use a tested transaction-control recipe for the pysqlite driver; `BEGIN IMMEDIATE` for short
  read-modify-write units, not for every read.
- Store timestamps as UTC and return them timezone-aware; SQLite has no timezone-aware type.
- The application process holds an **exclusive lock on the data directory** for its lifetime,
  acquired before migration, import or cleanup. A second instance refuses to start without
  modifying anything. The lock works on all supported platforms.
- Supported deployment: local filesystem or a named Docker volume. WSL and bind-mount setups need
  validation per configuration. Preserve the meaning of `DIKTATOR_DATA_DIR` or migrate it
  explicitly.
- Alembic uses batch mode on SQLite. Packaged installs upgrade at startup after a backup, refuse to
  start on an unknown newer schema, and ship the migration resources.

### Database/file boundary

- Write and durably finalize retained audio (including directory durability where supported)
  before committing its ready reference. On deletion, commit first, then unlink.
- Cleanup distinguishes abandoned files from active writes and imports; file age alone is not
  enough. Missing files are detected and reported, not assumed impossible.
- A complete backup is a coordinated snapshot of the database **and** audio.

### Legacy import

- Import existing chat folders at startup, preserving chat and recording IDs and leaving the source
  files untouched.
- Persist import completion independently of whether the imported chat still exists, so a deleted
  chat is never resurrected. Protect not-yet-imported audio from cleanup.
- Import recording metadata even when its audio file is missing. Report the missing file and return
  `recording_not_found` for its audio, so a file restored later is used rather than swept.
- Record the transcript as it was at import time, so the baseline history snapshot (see
  [0004](0004-edit-history.md)) reflects the imported state even when history is added later.
- Old JSON is migration recovery material, not a continuing backup.

## Consequences

- `chat.json` is no longer the directly editable source of truth. Per-chat JSON/Markdown export is
  provided through the API instead.
- Groups, preferences, history and membership become tables and foreign keys rather than separate
  file formats.
- A single application process remains the supported deployment; in-memory notifications rely on
  it.
- The storage sections of #2, #3, #9, #10 and #14 are superseded where they specify JSON
  persistence.
- SQLAlchemy ships optional native extensions; verify the packaged bundle (#8).
- Alternative considered: SQLModel. Rejected in favor of explicit separation of table and API
  models.
