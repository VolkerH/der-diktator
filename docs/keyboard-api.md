# Keyboard preferences and client navigation

`GET /api/preferences` returns `keyboard_actions` (stable `id`, readable `label`,
nullable `default_binding`), `default_keyboard_bindings`, effective
`keyboard_bindings`, `keyboard_bindings_is_default`, and
`keyboard_binding_pattern`. Reads are side-effect free. Any client can discover
all defaults without copying them into its code. Unsupported actions may be
shown as unsupported; clients do not dispatch another action for them.

`PATCH /api/preferences` accepts `keyboard_bindings`, a complete replacement of
custom overrides. Omitted actions use server defaults; null disables an action.
An empty object explicitly follows all current defaults in custom mode. Reset
with `{"reset": ["keyboard_bindings"]}` stores NULL and follows future defaults.
Setting and resetting together, null mappings, unknown action IDs, unsupported
bindings and duplicate _effective_ bindings return 422 `validation_error`.

Bindings use `Ctrl+Shift+` followed by a digit, ArrowUp or ArrowDown.
Ctrl means Control on every platform, including macOS; Command is not used. The conservative grammar
reserves ordinary typing, native navigation, Alt/AltGr, function keys, standard
browser and editing shortcuts. It deliberately avoids Ctrl/Cmd+K despite its
use in some chat interfaces because browsers also use it. Each action has at
most one binding; users may disable any or all shortcuts. Physical number keys
are used so Shift's printed symbols and keyboard layout do not change numbers.
Arrow shortcuts pause in editable fields to preserve text selection. Composition, repeated keys and AltGraph
never dispatch shortcuts. OS/browser/assistive-technology remapping can still
consume a binding; native Tab navigation remains available.

The existing strong ETag covers mappings, action catalog and defaults. All writes
require `If-Match` (428 without it; 412 `revision_conflict` for stale values), check
atomically and increment revision only on changes, including default/custom mode.
Unrelated preference writes preserve the mapping. After response loss or 503
`persistence_failed`, refetch and reconcile before retrying. Invalid stored
mappings cause 503 `preferences_unavailable`; wildcard explicit keyboard reset can
repair that field. If another field is corrupt, reset it explicitly too. No chat,
recording or engine state changes. Migration 0006 adds nullable JSON text to the
existing profile row; public models are separate from persistence models.

## Browser obligations and behavior

The client implements capture, clipboard/share gestures, selection, focus and key
handling. It invokes existing controls, retaining their enabled-state and workflow
checks. Bindings pause in modal dialogs; native Tab/Shift+Tab, Escape and activation
remain authoritative there. Close returns focus to the invoking control or a
visible fallback when a dynamic list replaced it. A mobile drawer contains focus,
uses Escape to dismiss, and makes the main region inert while open. Desktop
sidebar remains ordinary navigation. Chat-list arrows focus visible chats without
opening them; Enter opens. Group menus use native details/summary and buttons;
model choices use native radio buttons. All dynamic recording/recovery actions
remain reachable with Tab.

Keyboard shortcuts in the sidebar opens the help/editor, including current
bindings, editable text fields, disable/default/reset and explicit Save. Validation
errors and conflicts retain the complete draft; Load latest explicitly discards
that draft and reads the current representation. Reset is staged until Save.
Successful saves become active immediately in this tab. Other tabs/devices refresh
on window focus; a currently open editor keeps its original ETag so it can detect
conflicts. A failed initial read does not invent client defaults: the visible
help button remains available with Load latest to retry.

## Research and selected conventions

[WAI APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
and [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
provide the native navigation, visible focus and return-focus conventions.
[ChatGPT search](https://help.openai.com/en/articles/10056348-how-do-i-search-my-chat-history-in-chatgpt)
uses Ctrl/Cmd+K. This app offers a consistent Ctrl+Shift+number family instead
of taking that browser shortcut. Main actions are 1 new chat, 2 search, 3 editor,
4 start/stop, 5 sidebar, 6 models, 7 preamble, 8 share, 9 copy, 0 help. Previous/next
chat focus uses Ctrl+Shift+Up/Down. Optional actions default disabled, with
native controls always available.

[Firefox shortcuts](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly),
[Chrome shortcuts](https://support.google.com/chrome/answer/157179), and
[Apple shortcuts](https://support.apple.com/en-us/102650) inform the reserved set.
Literal Control avoids Command+Shift+3/4/5 screenshot commands on macOS. Letter
bindings are excluded because browsers reserve overlapping Control/Command+Shift
letters (including developer tools and find previous). Native editor selection
continues to own Control+Shift+arrows in editable controls. Supported numbered and
arrow mappings can be swapped or disabled; Tab navigation is independent of them.
