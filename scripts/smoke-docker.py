#!/usr/bin/env python3
"""Model-free acceptance of a built image, using disposable containers and volumes.

Run: uv run --locked python scripts/smoke-docker.py der-diktator:local
Docker must already be available. No existing application data is mounted.
"""

import argparse
import json
import subprocess
import time
import uuid
from contextlib import suppress


def docker(*arguments: str) -> str:
    return subprocess.check_output(["docker", *arguments], text=True).strip()


def wait_healthy(name: str) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", "--format", "{{json .State}}", name))
        if state["Status"] == "exited":
            raise RuntimeError(docker("logs", name))
        if state.get("Health", {}).get("Status") == "healthy":
            return
        time.sleep(0.5)
    raise RuntimeError(f"Container did not become healthy: {docker('logs', name)}")


# Exercise the same HTTP contract as any non-browser client from inside the
# isolated container. No network access means no startup dependency downloads.
CREATE = """
import io, json, pathlib, urllib.request, wave
base = "http://127.0.0.1:8080"
def call(path, method="GET", data=None, headers=None):
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(request) as response:
        return response.read(), response.headers
assert b"Der Diktator" in call("/")[0]
assert b"openapi" in call("/openapi.json")[0]
assert b"worklet" in call("/assets/recorder-worklet.js")[0].lower()
assert not json.loads(call("/api/health")[0])["ready"]
models = json.loads(call("/api/models")[0])
assert len(models["models"]) == 3 and all(not model["installed"] for model in models["models"])
chat = json.loads(call("/api/chats", "POST")[0])
path = "/api/chats/" + chat["id"]
call(path + "/text", "PUT", json.dumps({"text": "Container persistence 🌻"}).encode(),
     {"Content-Type": "application/json"})
preferences, headers = call("/api/preferences")
call("/api/preferences", "PATCH", b'{"copy_preamble":"Container preference"}',
     {"Content-Type": "application/json", "If-Match": headers["ETag"]})
audio = io.BytesIO()
with wave.open(audio, "wb") as wav:
    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
    wav.writeframes(bytes(3200))
recording = json.loads(call(path + "/recordings", "POST", audio.getvalue(),
                            {"Content-Type": "audio/wav"})[0])
assert call(path + "/recordings/" + recording["id"])[0] == audio.getvalue()
pathlib.Path("/models/smoke-marker").write_text("persistent")
saved = {"chat": chat["id"], "recording": recording["id"]}
pathlib.Path("/data/smoke.json").write_text(json.dumps(saved))
print("HTTP discovery, assets, chats, preferences and WAV storage passed")
"""
VERIFY = """
import json, pathlib, urllib.request
saved = json.loads(pathlib.Path("/data/smoke.json").read_text())
def get(path):
    return urllib.request.urlopen("http://127.0.0.1:8080" + path).read()
chat = json.loads(get("/api/chats/" + saved["chat"]))
assert chat["text"] == "Container persistence 🌻"
assert json.loads(get("/api/preferences"))["copy_preamble"] == "Container preference"
assert get("/api/chats/" + saved["chat"] + "/recordings/" + saved["recording"]).startswith(b"RIFF")
assert pathlib.Path("/models/smoke-marker").read_text() == "persistent"
print("Offline replacement preserved chats, preferences, WAV and model volume")
"""
IMPORTS = """
import fermion, torch, sherpa_onnx, faster_whisper, soundfile
from sqlalchemy.util import has_compiled_ext
assert has_compiled_ext()
assert torch.version.cuda is None
print("All native backend imports and SQLAlchemy compiled extensions passed; Torch is CPU-only")
"""

# Wait for the real engine before launching the real web CLI against the bad
# data path. This isolates the storage failure from unrelated engine startup
# failures and lets the harness verify peer shutdown before the container exits.
UNWRITABLE = r"""
import os, pathlib, sys, time
from diktator.container import supervise
engine = ["/opt/diktator/engine/.venv/bin/python", "-m", "diktator.inference", "serve"]
engine_start = (
    "import os, pathlib; pathlib.Path('/tmp/engine.pid').write_text(str(os.getpid())); "
    f"os.execv({engine[0]!r}, {engine!r})"
)
web_start = '''
import http.client, os, time, urllib.request
deadline = time.monotonic() + 60
while True:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8010/models", timeout=1) as response:
            assert response.status == 200
        break
    except (OSError, http.client.HTTPException):
        if time.monotonic() >= deadline:
            raise
        time.sleep(.1)
print("Engine ready before unwritable-data check", flush=True)
os.execv("/opt/diktator/.venv/bin/diktator",
         ["diktator", "--host", "0.0.0.0", "--port", "8080"])
'''
result = supervise(
    [[engine[0], "-c", engine_start], [sys.executable, "-c", web_start]], grace_seconds=5
)
assert result != 0
engine_pid = int(pathlib.Path("/tmp/engine.pid").read_text())
# Tini may still be reaping orphaned descendants after supervise() returns.
deadline = time.monotonic() + 5
while True:
    try:
        os.killpg(engine_pid, 0)
    except ProcessLookupError:
        break
    if time.monotonic() >= deadline:
        raise AssertionError("Engine process group survived web startup failure")
    time.sleep(.05)
print("Engine process group stopped after data failure", flush=True)
raise SystemExit(result)
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", default="der-diktator:local")
    image = parser.parse_args().image
    name = "diktator-smoke-" + uuid.uuid4().hex[:10]
    volumes = [name + "-data", name + "-models", name + "-restored"]
    try:
        for volume in volumes:
            docker("volume", "create", volume)
        for index, code in enumerate((CREATE, VERIFY)):
            data_volume = volumes[0] if index == 0 else volumes[2]
            docker(
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--mount",
                f"source={data_volume},target=/data",
                "--mount",
                f"source={volumes[1]},target=/models",
                image,
            )
            wait_healthy(name)
            assert docker("exec", name, "id", "-u") == "10001"
            print(docker("exec", name, "/opt/diktator/.venv/bin/python", "-c", code))
            print(docker("exec", name, "/opt/diktator/engine/.venv/bin/python", "-c", IMPORTS))
            docker("stop", "--time", "25", name)
            assert docker("inspect", "--format", "{{.State.ExitCode}}", name) == "143"
            docker("rm", name)
            if index == 0:
                # The documented stopped-volume backup contains SQLite AND audio.
                archive = subprocess.check_output(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--entrypoint",
                        "tar",
                        "--mount",
                        f"source={volumes[0]},target=/data,readonly",
                        image,
                        "-C",
                        "/data",
                        "-czf",
                        "-",
                        ".",
                    ]
                )
                subprocess.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "-i",
                        "--user",
                        "0:0",
                        "--entrypoint",
                        "tar",
                        "--mount",
                        f"source={volumes[2]},target=/data",
                        image,
                        "-C",
                        "/data",
                        "-xzf",
                        "-",
                    ],
                    input=archive,
                    check=True,
                )
                print("Stopped data volume backed up and restored to a new volume")
        # Check both the shipped entrypoint/exit status and isolated peer cleanup.
        # The latter delays web startup until the engine is known to be healthy.
        for isolated in (False, True):
            launcher = (
                [
                    "--entrypoint",
                    "/usr/bin/tini",
                    image,
                    "--",
                    "/opt/diktator/.venv/bin/python",
                    "-c",
                    UNWRITABLE,
                ]
                if isolated
                else [image]
            )
            docker(
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--env",
                "DIKTATOR_DATA_DIR=/unwritable",
                "--mount",
                f"source={volumes[1]},target=/models",
                *launcher,
            )
            # Budget for engine readiness (60s), web startup, supervisor grace
            # (5s in the harness, 15s in main), reaping (5s), and Docker overhead.
            result = subprocess.run(
                ["docker", "wait", name], text=True, capture_output=True, timeout=120
            )
            logs = subprocess.check_output(
                ["docker", "logs", name], text=True, stderr=subprocess.STDOUT
            )
            assert result.returncode == 0 and int(result.stdout) != 0, logs
            assert "/unwritable" in logs and (
                "Read-only file system" in logs or "Permission denied" in logs
            ), logs
            if isolated:
                assert "Engine ready before unwritable-data check" in logs, logs
                assert "Engine process group stopped after data failure" in logs, logs
                print("Unwritable data fails after engine readiness; engine group stopped")
            else:
                print("Production entrypoint propagates unwritable-data startup failure")
                docker("rm", name)
    finally:
        with suppress(subprocess.CalledProcessError):
            docker("rm", "--force", name)
        for volume in volumes:
            with suppress(subprocess.CalledProcessError):
                docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
