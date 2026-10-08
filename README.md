<p align="center">
  <img src="src/diktator/static/splash.svg" alt="A vintage ribbon microphone" width="160" />
</p>

<h1 align="center">Der Diktator</h1>

<p align="center"><strong>A self-hosted dictation and transcription server.</strong><br />
Dictate snippets from your phone or computer, get editable text,<br />
and keep everything on your own machine.</p>

---

Der Diktator is a small web app for capturing spoken notes, drafts, and ideas as
text. Run it on a home server, open it in the browser on your phone or laptop,
tap the microphone, and speak. Speech is transcribed on your server’s CPU using
**Phonon-2** for English, or **Parakeet v3** and **Whisper large-v3-turbo** for
German, English, and other languages. Choose and
download a model in the browser. Your transcripts and recordings are stored on
the server as plain files. No audio or text is sent to a cloud service.

The intended setup is a machine at home, behind your firewall, that you reach from
anywhere through a private VPN such as [Tailscale](https://tailscale.com/) or
[WireGuard](https://www.wireguard.com/). It also runs on a single computer,
including Windows through WSL2. The name is a play on
words: in German, a _Diktat_ is a dictation.

<p align="center">
  <img src="docs/screenshot-desktop.png" alt="Der Diktator in a desktop browser: chat list, recorder, and an editable transcript with its recordings" width="72%" />
  &nbsp;
  <img src="docs/screenshot-phone.png" alt="Der Diktator on a phone" width="22%" />
</p>

> [!WARNING]
> Der Diktator has **no user accounts, passwords, or access control**. Anyone who
> can reach it can read, change, and delete every chat and recording. Keep it on
> `localhost` or a private network or VPN, and never expose it to the internet
> (no port forwarding, no `tailscale funnel`). It is designed for one person, or
> a household that trusts each other.

> [!NOTE]
> **Experimental.** Der Diktator has been vibe coded with the help of AI coding
> assistants (Claude and Codex). It is a personal project, not a hardened
> product: expect rough edges, review the code before you rely on it, and keep
> backups of transcripts that matter.

## Features

- **Dictate from any device.** A responsive web app for phone, tablet, and
  desktop browsers. Nothing to install on the device.
- **Three speech models.** Choose Phonon-2, Parakeet v3, or Whisper large-v3-turbo.
  Language, recording mode, and download-size labels help you compare them.
  Download missing weights from the browser.
- **Live transcription with Phonon-2.** Text appears while you speak and is
  finalised when you stop. Parakeet and Whisper transcribe after you stop;
  **Live text** is disabled for those models.
- **Chats.** Each dictation is a chat: one editable transcript plus every
  recording made for it. Start new chats, reopen old ones, or delete them.
- **Dictate at the cursor.** Recording again never replaces your text. The new
  transcript is inserted at the cursor, or replaces the selected text.
- **Recordings are kept.** Every recording is stored with its chat. Play it
  back, or transcribe it again at the cursor.
- **Autosave and copy.** Edits are saved on the server automatically; **Copy**
  puts the whole transcript on the clipboard.
- **Private.** Transcription runs on your server's CPU, with no cloud services
  and no GPU required.
- **Resilient.** If live transcription drops, the complete recording is
  transcribed when you stop. If a recording cannot be stored, it stays in the
  tab so you can retry.

## How to use it

1. **Choose a speech model.** Open **Speech models** at the bottom of the sidebar
   (on a phone, open the ☰ menu first). Select a model,
   and click **Download** if needed. Then click **Use model** and wait for the
   ready badge. Downloads and loading run in the background; failures show a retry
   message. The server remembers the last successfully activated model.
   See [Choosing and downloading a model](#choosing-and-downloading-a-model)
   for the full walkthrough.
2. **Tap the microphone** and speak. With **Live text** on, words appear as you
   talk; provisional words can still change. On a computer, Space starts and
   stops recording too.
3. **Tap Stop.** The recording is saved with the chat, and the final transcript
   is inserted at the cursor.
4. **Edit the text** freely; changes are saved automatically.
5. **Add more** by placing the cursor where the text should go and recording
   again. Each recording appears as a clip under the transcript: ▶ plays it, ↻
   transcribes it again at the cursor.
6. **Copy** the transcript into an email, message, or document.

Use **New chat** for the next snippet. Your chats are listed on the left, or
behind the ☰ button on a phone; the app reopens the most recent one. To delete a
chat and its recordings, click its trash icon and then **Delete**. A recording
stops automatically after ten minutes.

## Requirements

- An x86-64 Linux machine, such as a home server, or WSL2 on Windows.
- Python 3.12 and [uv](https://docs.astral.sh/uv/).
- Internet access for the initial dependency and model downloads.
- A browser with microphone access. On other devices, the app must be opened
  over HTTPS (see [Using it from your phone](#using-it-from-your-phone)).
- Node.js 24 or newer and npm, only for development checks.

## Docker

A Linux amd64 CPU image and Compose setup are available. Build with
`./scripts/build-docker.sh`, then run `docker compose up -d --no-build`.
Open <http://localhost:8080>; download a speech model in the picker.
See [Docker setup, persistent storage and upgrades](docs/docker.md).

## Quick start

```bash
uv sync --locked
make run
```

`make run` starts the model service on `127.0.0.1:8010` and the web app on
`127.0.0.1:8080`; Ctrl-C stops both. Open <http://localhost:8080> in a browser on
the same machine. Open **Speech models** in the sidebar, choose a model, download
it, then click **Use model**. Starting
the services does not download model weights. With WSL, use your Windows browser:
WSL forwards `localhost` to Windows. Model loading can take some time.

Phonon-2 downloads about 164 MB; Parakeet v3 INT8 about 671 MB;
Whisper large-v3-turbo about 1.62 GB. Allow
additional disk space for temporary downloads, unpacking, and Python dependencies.
A failed download can be retried. A retry starts the incomplete download again.
To download from the command line instead, use `make download-model` for Phonon-2,
`make download-model MODEL=parakeet-v3`, or
`make download-model MODEL=whisper-large-v3-turbo`. All use the same model store as the GUI.

To run the services separately, use `make engine` in one terminal and `make web`
in another. After updating the app, restart it and refresh the browser: the web
process loads its frontend when it starts.

## Using it from your phone

Browsers only allow microphone access on secure pages: `https://` addresses, or
`localhost`. To dictate from another device, put the app behind HTTPS on your
private network. The web app can keep listening on `127.0.0.1` in both setups
below, or serve HTTPS itself.

### With Tailscale (easiest)

[Tailscale](https://tailscale.com/) gives each device a private address and can
provide HTTPS certificates for them.

1. Install Tailscale on the server and your phone and sign in to the same
   tailnet.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS
   Certificates**.
3. Start Der Diktator on the server with `make run`.
4. Publish it to your tailnet only:

   ```bash
   sudo tailscale serve --bg 8080
   ```

5. On your phone, open the address that command prints, such as
   `https://homeserver.your-tailnet.ts.net`.

`tailscale serve` is only reachable from devices in your tailnet. Do **not** use
`tailscale funnel`, which publishes to the internet. `tailscale serve reset`
stops sharing.

### With WireGuard or another VPN

On a plain WireGuard network, the phone must trust the certificate of the
address you open. Two common options:

- **Reverse proxy.** Run a proxy such as [Caddy](https://caddyserver.com/) on the
  server that serves HTTPS for a host name you own (using a DNS challenge, so it
  needs no public port) and forwards to `127.0.0.1:8080`. WebSocket forwarding
  must be enabled; Caddy does this by default.
- **Let Der Diktator serve HTTPS.** Create a certificate for the server's VPN
  address, for example with [mkcert](https://github.com/FiloSottile/mkcert), and
  install mkcert's root certificate on your phone. Then run the engine with
  `make engine` and the web app with:

  ```bash
  uv run diktator --host 10.0.0.1 --port 8443 \
    --ssl-certfile 10.0.0.1.pem --ssl-keyfile 10.0.0.1-key.pem
  ```

  Replace `10.0.0.1` with the server's WireGuard address, and open
  `https://10.0.0.1:8443` on your phone. Make sure your firewall only allows
  that port on the VPN interface.

Tip: use your phone browser's **Add to Home Screen** to open Der Diktator like
an app.

### Running it as a service

To start Der Diktator with the server, you can use a systemd user service, for
example `~/.config/systemd/user/diktator.service`:

```ini
[Unit]
Description=Der Diktator dictation server
After=network-online.target

[Service]
WorkingDirectory=%h/der-diktator
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/make run
Restart=on-failure

[Install]
WantedBy=default.target
```

Adjust `WorkingDirectory` to where you cloned the repository, then enable it with
`systemctl --user enable --now diktator` and keep it running after you log out
with `loginctl enable-linger`.

## Storage and configuration

Chat transcripts and recording metadata live in SQLite. Audio remains in one
folder per chat, with one 16 kHz WAV file per recording. `DIKTATOR_DATA_DIR` and
`--data-dir` select the same chat storage directory as earlier versions:

```text
<data_dir>/
  .diktator.lock             # held for the application's lifetime
  diktator.sqlite3           # transcripts, membership and recording metadata
  backups/                  # database snapshots before schema upgrades
  <chat_id>/
    <recording_id>.wav       # retained audio
    chat.json               # legacy recovery material, when imported
```

SQLite may also create `diktator.sqlite3-wal` and `diktator.sqlite3-shm` while the
application is running. By default storage lives in the user data folder chosen by
[platformdirs](https://pypi.org/project/platformdirs/) for your operating system:

| System        | Default chat folder                                         |
| ------------- | ----------------------------------------------------------- |
| Linux and WSL | `~/.local/share/diktator/chats` (respects `$XDG_DATA_HOME`) |
| macOS         | `~/Library/Application Support/diktator/chats`              |
| Windows       | `%LOCALAPPDATA%\diktator\chats`                             |

When running in WSL, the Linux location applies.

| Setting         | Default                  | How to change                                    |
| --------------- | ------------------------ | ------------------------------------------------ |
| Chat storage    | user data folder (above) | `DIKTATOR_DATA_DIR=…` or `diktator --data-dir …` |
| Engine endpoint | `http://127.0.0.1:8010`  | `DIKTATOR_ENGINE_URL=…`                          |
| Web address     | `127.0.0.1:8080`         | `diktator --host … --port …`                     |
| HTTPS           | off                      | `diktator --ssl-certfile … --ssl-keyfile …`      |

```bash
DIKTATOR_DATA_DIR=/mnt/c/Users/me/Documents/diktator make run
uv run diktator --data-dir ~/dictation
```

The web app prints the storage directory and database path when it starts, and
`diktator --help` shows the default. One web application process owns each data
directory. Starting another instance with the same directory fails with an
"already in use" message before migration, import or cleanup. Separate data
directories can be used for separate instances.

Use a local filesystem or a named Docker volume. Validate WSL `/mnt/c` storage
and Docker bind mounts for your particular setup; filesystem locking, durable
renames and SQLite WAL support are required. The WSL Linux filesystem is the
default. Network filesystems are outside the supported placement contract.

When the default location is unused, startup moves chats from earlier versions
in `~/.diktator/chats` or `~/.phonon/chats`. The move runs under the ownership
lock and resumes after interruption using `.legacy-migration.json`. It preserves
the lock file and never merges another populated data directory. The marker
identifies the selected source after a partial move has populated the target.
Copying to a staging path and durably finalizing it before removing the source
also protects moves across filesystems.

Startup imports each legacy `chat.json` once, preserving IDs, text, timestamps
and recording metadata. It keeps the JSON as recovery material. SQLite becomes
the authoritative source, so editing the JSON after import does not update a
chat. A deleted imported chat is never imported again. Unreadable chats are
logged and left untouched. Missing WAVs retain their metadata and return
`recording_not_found`; restoring the original WAV makes it available again.
Startup removes abandoned temporary and unreferenced WAV files only where import
status establishes that cleanup is safe. Folders absent from both `chats` and
`legacy_imports` are logged and preserved, including WAVs and temporary files.
This also preserves leftovers when cleanup fails after deleting a newly created
chat; without a durable deletion tombstone, startup cannot prove ownership.
Deleted imported chats remain known through the import ledger and can be swept.

Before a schema upgrade, startup writes a consistent database snapshot using
`VACUUM INTO` under `backups/`. A fresh, empty database needs no snapshot; an
existing database is backed up even if it has no Alembic version table. One
snapshot is retained per upgrade, with no automatic retention limit. Remove
older snapshots manually after verifying your own complete backup.
A database from a newer application version causes startup to refuse. These snapshots
contain database data; a complete backup includes audio too. Stop the web app
and copy the entire data directory when making a complete backup. Legacy JSON
is recovery material from import time, and does not track subsequent edits.

The current HTTP persistence behavior is documented in
[Storage API behavior](docs/storage.md).

## Speech models

| Model                     | Languages                                        | Recording mode                            | Approximate download |
| ------------------------- | ------------------------------------------------ | ----------------------------------------- | -------------------- |
| Phonon-2                  | English                                          | Live text or transcription after stopping | 164 MB               |
| Parakeet TDT 0.6B v3 INT8 | German, English, and 23 other European languages | Transcription after stopping              | 671 MB               |
| Whisper large-v3-turbo    | German, English, and many other languages        | Transcription after stopping              | 1.62 GB              |

### Choosing and downloading a model

**1. Open Speech models.** The button sits at the bottom of the sidebar, outside
the current chat. On a phone, open the ☰ menu first. You can change models without
starting a new chat or losing your transcript.

**2. Compare the labels and select a model.** Each option shows its properties
as small pills:

- **German**, **English**, and the additional-language label describe language
  support. Language detection is automatic; these labels are not language switches.
- **Live text** means text can appear while you speak. **After recording** means
  transcription starts once you press Stop.
- **Download: …** is the approximate size of the model files transferred to the
  server. Runtime memory and Python dependencies need additional space.

Selecting an option lets you inspect it. Click **Use model** to activate it once
it is installed.

<!-- screenshot:model-picker:start -->

<img src="docs/screenshot-model-picker.png" alt="Choose a model by its language, recording mode, and download-size pills." width="520" />

_Choose a model by its language, recording mode, and download-size pills. Screenshot of the app with demonstration state._

<!-- screenshot:model-picker:end -->

**3. Click Download if the model is missing.** Every model has a **Download**
button when its files are absent, or **Delete download** when they are already
available locally. The size pill shows the approximate download size. Downloads run on the server and report which file is
being fetched. **Downloading model…** means the download is running; it does not
mean your speech is being transcribed. Starting the app never downloads model
weights automatically.

<!-- screenshot:model-download:start -->

<img src="docs/screenshot-model-download.png" alt="The download status reports the current model file." width="520" />

_The download status reports the current model file. Screenshot of the app with demonstration state._

<!-- screenshot:model-download:end -->

**4. Click Use model after the download finishes.** Wait for **Loading model…**
to change to **Ready**, then close the dialog and record. The sidebar repeats
the selected model's name and capability labels. Whisper and Parakeet switch off
the **Live text** control; their transcript arrives after you stop recording.
The last successfully activated model is loaded again when the server restarts.

<!-- screenshot:model-ready:start -->

<img src="docs/screenshot-model-ready.png" alt="The sidebar shows Whisper ready, with its languages and recording mode." width="300" />

_The sidebar shows Whisper ready, with its languages and recording mode. Screenshot of the app with demonstration state._

<!-- screenshot:model-ready:end -->

### Deleting downloaded models

Open **Speech models** and click **Delete download** on the model you want to
remove. A confirmation dialog names the model; click **Cancel** to keep it or
**Delete download** to remove its files from the server and free disk space.
An active model is unloaded first. Chats and recordings are kept, and you can
download the model again later. Deletion is disabled while recording,
transcribing, downloading, or loading a model. Other tabs also see the updated
availability. After deleting the active model, choose another downloaded model
and click **Use model** before recording again.

<!-- screenshot:model-delete:start -->

<img src="docs/screenshot-model-delete.png" alt="Confirm model deletion while keeping chats and recordings." width="520" />

_Confirm model deletion while keeping chats and recordings. Screenshot of the app with demonstration state._

<!-- screenshot:model-delete:end -->

### Understanding the status

| Status                | What it means / what to do                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Download a model      | The selected model is missing. Open Speech models and click Download.                                                                        |
| Downloading model…    | Model files are being downloaded. Wait for completion.                                                                                       |
| Choose Use model      | The files are installed. Click Use model to load them.                                                                                       |
| Deleting model…       | The server is unloading and removing the downloaded model files.                                                                             |
| Loading model…        | The server is preparing the model. Wait for Ready.                                                                                           |
| Ready                 | You can record with the selected model.                                                                                                      |
| Transcribing…         | The server is processing audio with the selected model.                                                                                      |
| Model needs attention | Downloading or loading failed, or the engine stopped. Open Speech models to read the error and retry. This is not a transcription indicator. |
| Engine unavailable    | The browser cannot reach the model service. Check the server terminal and restart with `make run` if needed.                                 |

For a failed download, check internet access and available disk space, then
click **Download** again. A retry starts that model's incomplete download over.
For a loading failure, check the server log and click **Use model** again.
After updating the app, restart `make run` to install runtime dependency changes,
then refresh the browser.

### Language recognition and model storage

Whisper large-v3-turbo uses faster-whisper with CTranslate2 INT8 CPU inference.
It supports German, English, and many other languages, with transcription after
recording stops. Language detection runs for each segment; speech detection skips
silence. INT8 is applied when loading the model and does not reduce the download.

Parakeet uses automatic language recognition. Mixed German/English dictation is a
useful application, but accuracy for language switches and technical vocabulary
should be checked with your own recordings. No translation is requested.
For long Parakeet recordings, the app looks for quiet cuts between 25 and 30
seconds; continuous speech forces a cut at 30 seconds and may lose word accuracy
at that boundary. Pausing between sentences helps.

The model choice is shared by all tabs using the same server. Switching is
refused during inference or a live stream. Recording requests carry the model
chosen when recording started; if another tab switches the server meanwhile,
the saved clip can be transcribed again after choosing the intended model.
Only one model is loaded at a time. If loading fails, choose **Use model** again;
the previous successful choice remains the startup preference.

Weights live in the server's app data directory: on Linux/WSL,
`~/.local/share/diktator/models` (respecting `$XDG_DATA_HOME`). Set
`DIKTATOR_MODELS_DIR` for another location, including when running `make download-model`. This is independent of `DIKTATOR_DATA_DIR`, which continues to
control chats. The directory also contains installation markers and the saved
model selection. Incomplete downloads are kept out of installed model directories.

Earlier versions used the repository's `.cache/fermion` directory. Those files
are left in place; use the GUI to download into the new app directory. Once you
have verified the new installation, you can remove the old cache yourself.
Model files are obtained from fixed sources: Parakeet weights and tokens from a
pinned revision of the [sherpa-onnx model conversion](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8),
with SHA-256 verification of the three weight files; Phonon uses Fermion's pinned
archive verification. Whisper uses a pinned revision of the
[faster-whisper conversion](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo),
with SHA-256 verification of the weights and validated JSON companion files.
Loading uses local files and works offline after setup.

## How it works

With Phonon-2 live text enabled, the browser captures the microphone and streams
16 kHz mono 16-bit PCM over a
WebSocket (`/api/stream`), which the web app relays through the model service
to Fermion’s `/v1/audio/stream`. Completed phrases stay in the transcript while the current
phrase's partial text is replaced. Stopping flushes the final audio, sends an end
message, and waits for the complete transcript. Each finished recording is
uploaded as a WAV and stored with its chat; when live text is off or unavailable,
the stored WAV is transcribed through the selected model’s HTTP API.

The engine supports one live stream at a time; a second tab receives an
engine-busy error. Live mode needs a browser audio context running at 16 kHz. If
the browser cannot provide one, turn off **Live text**: recording then resamples
the audio after capture. The first live session can take longer while the engine
warms up. Update speed depends on CPU speed and phrase length; pauses help the
engine finalise phrases.

The model service runs in `engine/`, with Fermion for Phonon and sherpa-onnx for
Parakeet. It listens on loopback port 8010. When Phonon is active, its managed
child server uses loopback port 8011 (`DIKTATOR_PHONON_PORT` overrides it).
`DIKTATOR_CPU_THREADS` sets Parakeet’s thread count (default 4). Heavy model work
runs outside the web event loop; status remains available while it loads or decodes.

The inference environment’s uv configuration selects the
CPU Torch index explicitly. It is separate from the lightweight web environment,
so the app's tests and checks do not download Torch or the model. The first
successful engine sync creates `engine/uv.lock`; commit it after setup. The web
client now expects the app-owned model service, so an older standalone Fermion
server is not a replacement for `make engine`.

## Development

```bash
npm ci        # once, for the frontend checks
make check
make format
```

If Node is managed with NVM, run `nvm use` in this folder first. `.nvmrc` selects
a Linux Node.js 24 installation; under WSL, use the Linux npm, not the Windows
one.

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

### Updating the model screenshots

The capture script opens the actual frontend with demonstration API responses.
It captures the picker, a download in progress, the ready state, and deletion
confirmation, then inserts
the images into the walkthrough above. It needs no running server and does not
download model weights or access saved chats.

```bash
uv run scripts/capture_model_screenshots.py --install-browser  # once
uv run scripts/capture_model_screenshots.py
```

This uses an isolated script environment with Playwright. Run it on a machine
that permits Chromium to start; restricted sandboxes may block browser startup.

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

Parakeet TDT 0.6B v3 is by NVIDIA and licensed under CC-BY-4.0. This app uses
the INT8 ONNX conversion distributed by the sherpa-onnx maintainers.
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) is Apache-2.0. See the
[Parakeet model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) and
[conversion/runtime documentation](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html).

Whisper is by OpenAI. Its weights and the
[faster-whisper runtime](https://github.com/SYSTRAN/faster-whisper) are MIT licensed.

References: [WSL localhost networking](https://learn.microsoft.com/en-us/windows/wsl/networking),
[Fermion speech API](https://www.fermionresearch.com/docs/speech/),
[Fermion streaming protocol](https://www.fermionresearch.com/docs/speech-streaming/).

Share… opens a preview of your current edited draft with Copy, Download and, when supported,
Share to app. Include saved preamble is remembered on the server for your local user profile
across devices. The main Copy button still copies your draft directly. Preamble preferences
let you edit the introduction. See the [preferences and export API](docs/preferences-export-api.md)
for conditional saves and limits, and the [native-sharing contract](docs/native-sharing.md)
for handoff outcomes and client responsibilities.
