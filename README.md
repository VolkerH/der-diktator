# Phonon dictation

A local English dictation app: record in a Windows browser, transcribe with
Phonon-2 running on the CPU in WSL, see text as you speak, edit it, and copy it.

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

Open <http://localhost:8080> in your **Windows browser**. Leave **Live text** on,
click the microphone button (or press Space), and speak. Text appears while you
speak; provisional words can change as more audio arrives. Click **Stop** to
finalize the transcript, then edit it or use **Copy**. Turn off **Live text** to
use the original **Stop & transcribe** workflow.

Each dictation lives in a **chat**: one editable transcript plus every recording
made for it. The sidebar lists your chats, newest first; **New chat** starts a
fresh one, and the trash button (click twice to confirm) deletes a chat with its
audio. The app reopens your most recent chat. Recording again never replaces
text: the new transcript is inserted at the cursor, or replaces the selected
text. Edits are saved automatically.

Each recording appears as a clip under the transcript. Play it back, or use its
↻ button to transcribe it again at the cursor. If the live connection fails
during recording or finalization, the app transcribes the stored WAV after you
stop. If the recording cannot be stored, it stays in the tab as an **Unsaved**
clip that you can retry. Recording stops automatically after ten minutes.

The microphone is captured by the browser. The WSL service receives a 16 kHz mono
16-bit PCM audio over WebSocket during live recording, and each finished
recording as a WAV. The model cache is ignored by Git and stays in
`.cache/fermion/`. Phonon-2 supports English.

### Chat storage

Chats are stored as plain files in `~/.phonon/chats/`, one folder per chat
containing `chat.json` (the transcript and recording list) and one `.wav` file
per recording. To store them elsewhere, set `PHONON_DATA_DIR` or pass
`--data-dir`:

```bash
PHONON_DATA_DIR=/mnt/c/Users/me/Documents/phonon make run
uv run phonon-web --data-dir ~/dictation
```

The web app prints the storage location when it starts.

`make run` runs the engine on `127.0.0.1:8010` and the web app on
`127.0.0.1:8080`. Ctrl-C stops both processes. The engine needs time to load on
first startup; the page shows whether it is ready.

After updating the application, restart the services and refresh the browser:
the web process loads its bundled frontend when it starts.

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
TypeScript checking of JavaScript, and Node frontend tests. `make format` applies
Python and frontend formatting and safe Ruff fixes. The frontend is served
directly from `src/phonon_web/static/`; there is no frontend build step or CDN.

Python tests simulate the engine at its HTTP and WebSocket boundaries. They
validate audio forwarding, upload limits, WAV validation, health status, live
events, finalization, and connection cleanup. Frontend tests cover PCM encoding,
microphone cleanup, partial corrections, stream failure, and the recording flow.
Real microphone behavior, model accuracy, and live latency need browser checks on
the target machine.

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

The app relays browser PCM through `/api/stream` to the engine's
`/v1/audio/stream`. Completed phrases stay in the transcript while the current
phrase's partial text is replaced. Stopping flushes the microphone's final audio,
sends an end message, and waits for the complete transcript before closing.

The engine supports one live stream per process. A second tab attempting live
transcription receives an engine-busy error. Live mode requires a browser audio
context running at 16 kHz; if the browser cannot provide it, turn off live mode
and use batch recording, which can resample audio after capture. The first live
session can take extra time while the engine warms up. Update frequency depends
on CPU speed and phrase length; speech pauses help the engine finalize phrases.

Reference: [WSL localhost networking](https://learn.microsoft.com/en-us/windows/wsl/networking),
[Fermion speech API](https://www.fermionresearch.com/docs/speech/),
[Fermion streaming protocol](https://www.fermionresearch.com/docs/speech-streaming/).
