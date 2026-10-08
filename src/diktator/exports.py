"""Pure draft export formatting shared by browser, TUI and future connectors."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict

from diktator.errors import ApiFailure
from diktator.preferences import Preamble

ExportFormat = Literal["plain", "with_preamble"]


class PreparedExport(BaseModel):
    """Exact text for the final client copy/share action, with no delivery side effects."""

    text: str
    media_type: Literal["text/plain", "text/markdown"]


class ExportPreviewRequest(BaseModel):
    """Preview an unsaved preference without persisting it."""

    model_config = ConfigDict(extra="forbid")
    copy_preamble: Preamble


def format_export(text: str, preamble: str | None = None) -> PreparedExport:
    """Keep accepted draft whitespace, using a fence longer than every backtick run."""
    if not text.strip():
        raise ApiFailure("Enter some text to export.", "invalid_export", 400)
    if preamble is None:
        return PreparedExport(text=text, media_type="text/plain")
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    newline = "" if text.endswith("\n") else "\n"
    return PreparedExport(
        text=f"{preamble}\n\n{fence}text\n{text}{newline}{fence}", media_type="text/markdown"
    )
