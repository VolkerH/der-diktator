# Native platform sharing (#3 slice)

Build on #24's backend draft export. This slice shares text through
the browser/OS only, using the saved server preference for the optional preamble.

Acceptance:

- Prepare the complete current unsaved draft through POST /api/exports; keep its exact returned
  string for a final explicit user-gesture Share action and clipboard/download fallbacks.
- Do not save chats or history, attach audio/localhost URLs, or call remote providers.
- Reject superseded preparation results and check the current draft before accepting them.
  Ignore completions after closing/replacing the dialog. Disable repeats within one dialog;
  let the platform reject overlaps across dialogs.
- Handle unavailable/denied sharing, AbortError, resolution and uncertain failures honestly.
  Resolution indicates a platform handoff, with no destination or delivery confirmation.
- Keep accessible labels, keyboard/focus restoration and wrapping mobile actions. Offer copying,
  selectable text and a UTF-8 download; fallbacks do not require another export request.
- Verify client behavior separately, run make check, and smoke-test real Chromium against the
  actual API using a mocked native share adapter. Do not send to any real destination.

Remaining #3 work: durable share history, provider connectors, credentials and confirmed remote
creation/reconciliation. This slice references #3 and must not close the full issue.
