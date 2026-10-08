# Agent guidance

## Backend and frontend contract

- Design features so the browser, a TUI, or another client can use the same
  documented HTTP and streaming APIs without duplicating application logic.
- Keep application rules, validation, persistence, shared text/export formatting,
  and application preferences in the Python backend. The backend is authoritative
  for permissions, capabilities, and resource limits.
- Keep device interactions and presentation in each client: microphone capture,
  clipboard/share-sheet access, editor selection/undo, and local display state.
  Document client obligations such as capture-buffer retention and warnings.
- Define typed requests, responses, and events, including defaults, side effects,
  stable error codes, and relevant retry, conflict, cancellation, and completion
  semantics. Distinguish user preferences from operator settings; do not make
  browser storage the only source of application preferences.
- Test application behavior through the API without requiring the browser, and
  test client interactions separately. Evolve contracts compatibly and document
  changes; introduce only the abstractions needed by the feature.
