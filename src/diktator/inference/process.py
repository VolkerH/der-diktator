"""Bounded child process cleanup shared by downloads and Phonon serving."""

import asyncio
from contextlib import suppress


async def stop_process(process: asyncio.subprocess.Process, *, grace_seconds: float = 5) -> None:
    """Reap a child, escalating from terminate to kill after five seconds."""
    if process.returncode is not None:
        await process.wait()
        return
    with suppress(ProcessLookupError):
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=grace_seconds)
    except TimeoutError:
        with suppress(ProcessLookupError):
            process.kill()
        await process.wait()
