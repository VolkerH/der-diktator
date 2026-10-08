# Sidebar chat rename

Scope: make chat renaming available from every saved chat row, while keeping the
editor heading rename control visible and accessible.

- Put Rename, Move and Delete in a persistent, keyboard-operable chat actions
  disclosure. Keep recording and busy guards on every action.
- Reuse the title dialog and conditional title API. Pin sidebar rename to the
  selected chat ID and title validator; do not navigate, flush, or replace the
  open editor draft when another chat is selected.
- Ignore a title read or save after its navigation target becomes stale. On
  conflicts, refresh that chat's title validator and explain the current name
  before explicit retry. Restore focus to the originating row action when it
  remains visible after cancel, Escape, save, or reset.
- Keep the heading pencil subdued but visible at rest, with clear hover and
  keyboard focus treatment.

Acceptance: client tests cover sidebar rename/reset, other-chat draft
preservation, stale and failed reads, conflicts, focus restoration, and recording
and busy guards. Run the frontend check suite; the orchestrator will verify the
UI in desktop and phone browsers.
