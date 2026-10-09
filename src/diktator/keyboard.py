"""Portable keyboard action catalog and server-owned binding validation."""

import re
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field


class KeyboardAction(BaseModel):
    """Stable action identity; clients implement supported actions in their own UI."""

    model_config = ConfigDict(frozen=True)
    id: str
    label: str
    default_binding: str | None = None


KEYBOARD_ACTIONS = [
    KeyboardAction(id=name, label=label, default_binding=binding)
    for name, label, binding in (
        ("new_chat", "New chat", "Mod+Shift+1"),
        ("search_chats", "Search chats", "Mod+Shift+2"),
        ("focus_editor", "Focus transcript", "Mod+Shift+3"),
        ("toggle_recording", "Start / stop recording", "Mod+Shift+4"),
        ("focus_sidebar", "Focus chats and groups", "Mod+Shift+5"),
        ("speech_models", "Speech models", "Mod+Shift+6"),
        ("preamble_preferences", "Preamble preferences", "Mod+Shift+7"),
        ("share", "Share draft", "Mod+Shift+8"),
        ("copy", "Copy draft", "Mod+Shift+9"),
        ("keyboard_help", "Keyboard shortcuts", "Mod+Shift+0"),
        ("previous_chat", "Focus previous visible chat", "Mod+Shift+ArrowUp"),
        ("next_chat", "Focus next visible chat", "Mod+Shift+ArrowDown"),
        ("rename_chat", "Rename current chat", None),
        ("new_group", "New group", None),
        ("focus_recordings", "Focus recordings", None),
        ("toggle_live", "Toggle live text", None),
    )
]
DEFAULT_KEYBOARD_BINDINGS = {action.id: action.default_binding for action in KEYBOARD_ACTIONS}
# Deliberately narrow grammar: no typing/navigation keys without modifiers, AltGr,
# function keys, OS combinations or standard browser/editing shortcuts.
BINDING_PATTERN = r"Mod\+Shift\+(?:[0-9A-Z]|ArrowUp|ArrowDown)"
RESERVED_BINDINGS = {"Mod+Shift+" + key for key in "ABCDHIJLMNOPQRSTUVWXYZ"}
# Mod+Shift+E/F/G/K are available; reservations combine Chrome/Firefox/Safari
# commands (tabs, reload, bookmarks, downloads, history, devtools, private windows).


def validate_bindings(value: dict[str, str | None]) -> dict[str, str | None]:
    """Validate a complete replacement of custom overrides (null disables)."""
    unknown = value.keys() - DEFAULT_KEYBOARD_BINDINGS.keys()
    if unknown:
        raise ValueError(f"Unknown keyboard action: {sorted(unknown)[0]}.")
    effective = DEFAULT_KEYBOARD_BINDINGS | value
    used: set[str] = set()
    for binding in effective.values():
        if binding is None:
            continue
        if not re.fullmatch(BINDING_PATTERN, binding) or binding in RESERVED_BINDINGS:
            raise ValueError("Use an available Mod+Shift+digit, E, F, G, K, ArrowUp or ArrowDown.")
        if binding in used:
            raise ValueError(f"Keyboard binding {binding} is assigned more than once.")
        used.add(binding)
    return value


KeyboardBindings = Annotated[
    dict[str, str | None],
    Field(max_length=len(KEYBOARD_ACTIONS)),
    AfterValidator(validate_bindings),
]
