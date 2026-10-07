<p align="center">
  <img src="src/diktator/static/splash.svg" alt="A vintage ribbon microphone" width="160" />
</p>

<h1 align="center">Der Diktator</h1>

<p align="center"><strong>A local dictation and transcription app.</strong><br />
Speak into your browser, watch the text appear, edit it, and copy it.<br />
Speech recognition runs on your own computer with the Phonon-2 model.</p>

---

Der Diktator turns speech into editable text. You record in the browser, it
transcribes with [Phonon-2](https://huggingface.co/FermionResearch/Phonon-2) on
the CPU, and your transcripts and recordings are kept as plain files on your
machine. No audio or text is sent to a cloud service. The name is a play on
words: in German, a _Diktat_ is a dictation.

It was built for Windows with WSL2: the app and the model run in WSL, and you use
it from a Windows browser. Phonon-2 recognises English.

## Features

- **Live transcription.** Text appears while you speak and is finalised when you
  stop. Turn off **Live text** to transcribe once after recording instead.
- **Chats.** Each dictation is a chat: one editable transcript plus every
  recording made for it. The sidebar lists your chats; start new ones, reopen
  old ones, or delete them.
- **Dictate at the cursor.** Recording again never replaces your text. The new
  transcript is inserted at the cursor, or replaces the selected text.
- **Recordings are kept.** Every recording is stored with its chat. Play it
  back, or transcribe it again at the cursor.
- **Autosave and copy.** Edits are saved automatically; **Copy** puts the whole
  transcript on the clipboard.
- **Keyboard friendly.** Press Space to start and stop recording when no text
  field is focused.
- **Resilient.** If live transcription drops, the complete recording is
  transcribed when you stop. If a recording cannot be stored, it stays in the
  tab so you can retry.

## Requirements

- WSL2 with x86-64 Linux, Python 3.12, and [uv](https://docs.astral.sh/uv/).
- Node.js 24 or newer and npm, for frontend development checks.
- Internet access for the initial dependency and model downloads.
- A browser with microphone permission, opened at `http://localhost:8080`.

If Node is managed with NVM, run `nvm use` in this folder. `.nvmrc` selects a
Linux Node.js 24 installation; development checks should use the Linux npm inside
WSL.

## Quick start

```bash
uv sync --locked
npm ci
make download-model
make run
```

Open <http://localhost:8080> in your **Windows browser**, click the microphone,
and speak. Click **Stop** when you are done, then edit or copy the text.

`make run` starts the transcription engine on `127.0.0.1:8010` and the web app on
`127.0.0.1:8080`; Ctrl-C stops both. The engine needs some time to load on first
start, and the badge at the top of the page shows when it is ready. WSL's
Windows-to-Linux localhost forwarding normally makes the app available in Edge,
Chrome, or Firefox on Windows.

To run the services separately, use `make engine` in one terminal and `make web`
in another. After updating the app, restart it and refresh the browser: the web
process loads its frontend when it starts.

## Using the app

1. Click the microphone (or press Space) and speak. With **Live text** on,
   provisional words can change as more audio arrives.
2. Click **Stop**. The recording is saved with the chat, and the final
   transcript is inserted at the cursor.
3. Edit the text freely; changes are saved automatically.
4. To add more, place the cursor where the text should go and record again.
5. Use **Copy** to copy the whole transcript.

Each recording appears as a clip under the transcript. ▶ plays it; ↻ transcribes
it again and inserts the result at the cursor. **New chat** starts a fresh
transcript. To delete a chat and its recordings, click its trash icon and then
**Delete**. The app reopens your most recent chat when you load it. A recording
stops automatically after ten minutes.

## Storage and configuration

Chats are stored as plain files, one folder per chat, containing `chat.json` (the
transcript and the list of recordings) and one 16 kHz WAV file per recording.

| Setting         | Default                 | How to change                                    |
| --------------- | ----------------------- | ------------------------------------------------ |
| Chat storage    | `~/.diktator/chats/`    | `DIKTATOR_DATA_DIR=…` or `diktator --data-dir …` |
| Engine endpoint | `http://127.0.0.1:8010` | `DIKTATOR_ENGINE_URL=…`                          |
| Web address     | `127.0.0.1:8080`        | `diktator --host … --port …`                     |

```bash
DIKTATOR_DATA_DIR=/mnt/c/Users/me/Documents/diktator make run
uv run diktator --data-dir ~/dictation
```

The web app prints the storage location when it starts. Chats from earlier
versions in `~/.phonon/chats/` are moved to the default location on first start,
unless that location already exists.

## How it works

The browser captures the microphone and streams 16 kHz mono 16-bit PCM over a
WebSocket (`/api/stream`), which the web app relays to the engine's
`/v1/audio/stream`. Completed phrases stay in the transcript while the current
phrase's partial text is replaced. Stopping flushes the final audio, sends an end
message, and waits for the complete transcript. Each finished recording is
uploaded as a WAV and stored with its chat; when live text is off or unavailable,
the stored WAV is transcribed through the engine's HTTP API.

The engine supports one live stream at a time; a second tab receives an
engine-busy error. Live mode needs a browser audio context running at 16 kHz. If
the browser cannot provide one, turn off **Live text**: recording then resamples
the audio after capture. The first live session can take longer while the engine
warms up. Update speed depends on CPU speed and phrase length; pauses help the
engine finalise phrases.

The inference environment lives in `engine/`. Its uv configuration selects the
CPU Torch index explicitly. It is separate from the lightweight web environment,
so the app's tests and checks do not download Torch or the model. The first
successful engine sync creates `engine/uv.lock`; commit it after setup.

## Development

```bash
make check
make format
```

`make check` runs Ruff formatting and linting, ty, pytest, Prettier, ESLint,
TypeScript checking of the JavaScript, and the Node frontend tests. `make format`
applies Python and frontend formatting and safe Ruff fixes. The frontend is
served directly from `src/diktator/static/`; there is no build step or CDN.

Python tests simulate the engine at its HTTP and WebSocket boundaries and cover
audio forwarding, upload limits, WAV validation, chat storage, health status,
live events, finalisation, and connection cleanup. Frontend tests cover PCM
encoding, microphone cleanup, partial corrections, stream failure, cursor
insertion, chats, and the recording flow. Real microphone behaviour, model
accuracy, and live latency need checks in a browser on the target machine.

### Git in the restricted workspace

This workspace initially contains an empty, read-only `.git` directory, so the
repository stores its Git metadata in `.git-local`, with branch `main`. Use the
wrapper for normal Git operations here:

```bash
./scripts/git.sh status
./scripts/git.sh log --oneline
./scripts/git.sh diff
```

On an ordinary clone, the wrapper uses standard Git. To migrate the existing
history after leaving the restricted session, first confirm `.git` is still an
empty placeholder, then remove that empty directory and rename `.git-local` to
`.git`. Remove `core.worktree` with `git config --unset core.worktree` after
moving the repository to a different path. Do not remove an existing populated
`.git`.

## License and credits

Der Diktator is released under the [MIT License](LICENSE.md).

The speech recognition model is not part of this repository. Phonon-2 is a
roughly 164 MB download; its Python runtime and unpacked model need additional
disk space. The weights are licensed under CC-BY-4.0 and the Fermion runtime under
Apache-2.0. Model attribution: Fermion Research, based on NVIDIA
parakeet-tdt-0.6b-v3. See the [model card](https://huggingface.co/FermionResearch/Phonon-2)
and the [installation guide](https://github.com/fermionresearch/phonon/blob/main/docs/install.md).

References: [WSL localhost networking](https://learn.microsoft.com/en-us/windows/wsl/networking),
[Fermion speech API](https://www.fermionresearch.com/docs/speech/),
[Fermion streaming protocol](https://www.fermionresearch.com/docs/speech-streaming/).
