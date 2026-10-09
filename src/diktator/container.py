"""Own both container services; Tini reaps orphaned descendants as PID 1.

The production image supplies two installed virtual environments. This launcher
never installs dependencies or model weights and keeps inference on loopback.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from collections.abc import Sequence
from contextlib import suppress
from types import FrameType


def signal_group(process: subprocess.Popen[bytes], signum: int) -> None:
    """Signal an owned group while its unreaped leader still reserves the PID."""
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signum)


def exit_status(process: subprocess.Popen[bytes]) -> int | None:
    """Observe a Linux child without releasing its PID for another process group."""
    result = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if result is None:
        return None
    return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status


def supervise(commands: Sequence[Sequence[str]], *, grace_seconds: float = 15) -> int:
    """Stop all owned services on a signal or any service exit; preserve failures."""
    processes: list[subprocess.Popen[bytes]] = []
    stopped = 0

    def stop(signum: int, _frame: FrameType | None) -> None:
        nonlocal stopped
        stopped = signum

    previous = {signum: signal.signal(signum, stop) for signum in (signal.SIGTERM, signal.SIGINT)}
    try:
        for command in commands:
            if stopped:
                break
            processes.append(subprocess.Popen(command, start_new_session=True))
        while not stopped:
            for process in processes:
                result = exit_status(process)
                if result is not None:
                    print(
                        f"Service PID {process.pid} exited with status {result}",
                        file=sys.stderr,
                        flush=True,
                    )
                    # A service exiting successfully still leaves an unusable container.
                    return max(1, result) if result >= 0 else 128 - result
            time.sleep(0.1)
        return 128 + stopped
    finally:
        for process in processes:
            signal_group(process, signal.SIGTERM)
        deadline = time.monotonic() + grace_seconds
        pending = list(processes)
        while pending and time.monotonic() < deadline:
            pending = [process for process in pending if exit_status(process) is None]
            if pending:
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        # Keep leaders unreaped until the last group signal, including for exited
        # leaders whose downloads/Fermion children may still be alive. poll()/wait()
        # before this point would let the kernel reuse their process-group IDs.
        for process in processes:
            signal_group(process, signal.SIGKILL)
            process.wait()
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def healthy() -> bool:
    """Check web-to-engine availability independently of model installation/readiness."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8080/api/models", timeout=3) as response:
        return isinstance(json.load(response).get("models"), list)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        try:
            sys.exit(0 if healthy() else 1)
        except (OSError, ValueError):
            sys.exit(1)
    # This image owns its internal endpoint; operator overrides must not silently
    # send audio to another inference service while leaving the bundled one idle.
    os.environ["DIKTATOR_ENGINE_URL"] = "http://127.0.0.1:8010"
    sys.exit(
        supervise(
            [
                ["/opt/diktator/engine/.venv/bin/python", "-m", "diktator.inference", "serve"],
                ["/opt/diktator/.venv/bin/diktator", "--host", "0.0.0.0", "--port", "8080"],
            ]
        )
    )


if __name__ == "__main__":
    main()
