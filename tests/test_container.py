"""Exercise the container supervisor with real child processes, without Docker/models."""

import os
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from unittest.mock import patch

import pytest

from diktator.container import supervise


def python(code: str) -> list[str]:
    return [sys.executable, "-c", code]


@pytest.mark.parametrize("exit_code, expected", [(0, 1), (7, 7)])
def test_service_exit_stops_peer(tmp_path: Path, exit_code: int, expected: int) -> None:
    peer_pid = tmp_path / "peer.pid"
    peer = python(
        f"import os, pathlib, time; pathlib.Path({str(peer_pid)!r}).write_text(str(os.getpid())); "
        "time.sleep(60)"
    )
    failing = python(
        "import pathlib, time\n"
        f"while not pathlib.Path({str(peer_pid)!r}).exists(): time.sleep(.02)\n"
        f"raise SystemExit({exit_code})"
    )
    assert supervise([peer, failing], grace_seconds=1) == expected
    with pytest.raises(ProcessLookupError):
        os.kill(int(peer_pid.read_text()), 0)


def test_start_failure_stops_already_started_service(tmp_path: Path) -> None:
    # The failed second exec must not leave the first service running.
    peer = subprocess.Popen(python("import time; time.sleep(60)"), start_new_session=True)
    try:
        with (
            patch("diktator.container.subprocess.Popen", side_effect=[peer, FileNotFoundError()]),
            pytest.raises(FileNotFoundError),
        ):
            supervise([["started-peer"], [str(tmp_path / "missing")]])
        assert peer.returncode == -signal.SIGTERM
    finally:
        if peer.poll() is None:
            peer.kill()
            peer.wait()


def test_termination_escalates_and_reaps_owned_children(tmp_path: Path) -> None:
    child_pid = tmp_path / "child.pid"
    command = python(
        "import os, signal, pathlib, time; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"pathlib.Path({str(child_pid)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    supervisor = subprocess.Popen(
        python(
            f"from diktator.container import supervise; "
            f"raise SystemExit(supervise([{command!r}], grace_seconds=.1))"
        )
    )
    try:
        deadline = time.monotonic() + 5
        while not child_pid.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert child_pid.exists()
        supervisor.terminate()
        assert supervisor.wait(timeout=5) == 143
        with pytest.raises(ProcessLookupError):
            os.kill(int(child_pid.read_text()), 0)
    finally:
        if supervisor.poll() is None:
            supervisor.kill()
            supervisor.wait()
        if child_pid.exists():
            with suppress(ProcessLookupError):
                os.kill(int(child_pid.read_text()), signal.SIGKILL)
