# Sidebar chat rename

## Goal

Make saved chat titles directly editable in the sidebar and editor heading, with
the row controls and interaction style already used by the chat list.

## Interaction

- A single click on a chat label opens that chat. Double-clicking the label is a
  shortcut to edit its title. Keep a small, visible pencil button on each saved
  row for touch, keyboard, and explicit pointer access.
- The heading text and its pencil button open the same inline editor. Do not
  open a rename dialog or a per-chat actions menu.
- Enter or the save control submits. Escape or Cancel discards the proposed
  title. Leaving the editor attempts to save, with duplicate submissions
  suppressed while one is in flight.
- Keep the existing Move and Delete icon buttons and Delete's second-click
  confirmation behavior.
- The inline editor offers the automatic title as an explicit choice. An empty
  title is validated normally and never silently resets the custom title.

## State and API behavior

- Use the full Chat GET response to obtain the canonical title and its
  `Title-ETag`; the skinny title endpoint does not return the title. Keep the
  existing title API and server validation unchanged.
- Pin an edit to its chat ID. Editing another row must not navigate or replace
  the current editor draft. Preserve the proposed title and show an inline
  error after validation, network, or revision-conflict failures. A conflict
  refreshes the canonical title validator and requires explicit retry.
- Re-rendering the list after background refresh must preserve the editor,
  proposed value, and caret. Ignore title reads or writes after their target
  becomes stale, and keep existing recording, busy, and navigation guards.
- Restore focus to the initiating control when a cancelled or completed edit
  leaves that control available.

## Implementation and validation

1. Replace the prior menu/dialog plan and restore the established Move/Delete
   row controls from `main`.
2. Implement one inline title editor flow shared by sidebar rows and the editor
   heading, including async read/save state, error recovery, outside-click save,
   and stable focus/caret through list refreshes.
3. Add interaction regressions for sidebar and heading entry points, navigation
   and draft preservation, stale requests, validation and network failures,
   conflict retry, outside-click duplicate suppression, refresh preservation,
   focus restoration, Move/Delete, and recording/busy guards.
4. Run `npm run check`. The orchestrator will verify the finished UI in desktop
   and phone browsers.

## Acceptance

The saved-chat label still opens on a single click, while double-click and the
accessible pencil enter inline editing. Both rename entry points share the
same behavior and API semantics. Failed edits remain visible and recoverable,
and Move/Delete keep their familiar controls and safeguards.
