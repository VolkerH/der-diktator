# Phonon dictation

A local English dictation app: record in a Windows browser, transcribe with
Phonon-2 running on the CPU in WSL, edit the text, and copy it.

## Requirements

- WSL2 with x86-64 Linux, Python 3.12, and [uv](https://docs.astral.sh/uv/).
- Node.js 24 or newer and npm, for frontend development checks.
- Internet access for the initial dependency and model downloads.
- A browser with microphone permission, opened at `http://localhost:8080`.

If Node is managed with NVM, run `nvm use` in this folder. `.nvmrc` selects a Linux
Node.js 24 installation; development checks should use the Linux npm inside WSL.

## Setup and run

```bash
uv sync --locked
npm ci
make download-model
make run
```

Open <http://localhost:8080> in your **Windows browser**. Click **Record**, speak,
then click **Stop & transcribe**. The transcript is editable; **Copy text** copies
your current edits. **Retry transcription** reuses the last recording if the
engine was starting or a request failed. **Clear** removes the recording and text
from the tab. Recording stops automatically after ten minutes.

The microphone is captured by the browser. The WSL service receives a 16 kHz mono
16-bit PCM WAV recording. The web application handles audio in memory; it has no
recording history or database. The model cache is ignored by Git and stays in
`.cache/fermion/`. Phonon-2 supports English.

`make run` runs the engine on `127.0.0.1:8010` and the web app on
`127.0.0.1:8080`. Ctrl-C stops both processes. The engine needs time to load on
first startup; the page shows whether it is ready.

To run the services separately, use `make engine` in one terminal and `make web`
in another. `PHONON_ENGINE_URL` overrides the engine endpoint for the web app.
Keep the default localhost endpoints for processing on this computer. WSL's
Windows-to-Linux localhost forwarding normally makes this address available in
Edge, Chrome, or Firefox on Windows.

The inference environment lives in `engine/`. Its uv configuration selects the
CPU Torch index explicitly. It is separate from the lightweight web environment,
so ordinary app tests and code checks do not download Torch or the model. The
first successful engine sync creates `engine/uv.lock`; commit it after setup.

## Development checks

```bash
make check
make format
```

`make check` runs Ruff formatting, Ruff linting, ty, pytest, Prettier, ESLint,
TypeScript checking of JavaScript, and Node audio tests. `make format` applies
Python and frontend formatting and safe Ruff fixes. The frontend is served
directly from `src/phonon_web/static/`; there is no frontend build step or CDN.

Python tests simulate the engine at its HTTP boundary. They validate the request
format, upload limits, WAV validation, health status, and failure handling. They
do not establish real model accuracy or hardware latency.

## Git in the restricted workspace

This workspace initially contains an empty, read-only `.git` directory. The
repository therefore stores its Git metadata in `.git-local`, with branch `main`.
Use the wrapper for normal Git operations here:

```bash
./scripts/git.sh status
./scripts/git.sh log --oneline
./scripts/git.sh diff
```

On an ordinary clone, the wrapper uses standard Git. To migrate the existing
history after leaving the restricted session, first confirm `.git` is still an
empty placeholder, then remove that empty directory and rename `.git-local` to
`.git`. Remove `core.worktree` with `git config --unset core.worktree` after moving
the repository to a different path. Do not remove an existing populated `.git`.

## Model and live transcription

Phonon-2 is a roughly 164 MB model download; its Python runtime and unpacked model
need additional disk space. The weights use CC-BY-4.0 and the Fermion runtime uses
Apache-2.0. Model attribution: Fermion Research, based on NVIDIA
parakeet-tdt-0.6b-v3. See the upstream [model card](https://huggingface.co/FermionResearch/Phonon-2)
and [installation guide](https://github.com/fermionresearch/phonon/blob/main/docs/install.md).

This version transcribes after recording stops. The engine already exposes
`/v1/audio/stream` for live transcription. A later version can reuse the microphone
capture code, stream resampled PCM over WebSocket, and display provisional and
completed text. The engine supports one live stream per process.

## Setup status in this session

The web environment and frontend tools are installed, with `uv.lock` and
`package-lock.json` tracked. All configured checks pass: 30 Python tests and 12
frontend tests, plus both formatters, both linters, and both type checkers.

The managed sandbox blocks external shell DNS/network access, localhost binding,
and Chromium startup, and mounts `.git` read-only. An attempt to escalate the
engine installation was automatically rejected because sandbox approvals are
disabled. The Fermion runtime and model download must be completed in an ordinary
WSL terminal with internet access using `make download-model`. Browser preview,
real microphone transcription, and inference latency remain unverified.

Reference: [WSL localhost networking](https://learn.microsoft.com/en-us/windows/wsl/networking),
[Fermion speech API](https://www.fermionresearch.com/docs/speech/),
[Fermion streaming protocol](https://www.fermionresearch.com/docs/speech-streaming/).
