# Agent guidance

## Agent attribution

- Every agent-authored commit must have a concise subject and a nonempty body
  explaining the change and why it was made.
- Add a `Co-authored-by:` trailer to every agent-authored commit. Identify the
  coding agent and the actual model used, including its reasoning effort when
  known (for example, `Co-authored-by: Codex (GPT-6 Astra, high) <noreply@openai.com>`).
  Do not guess a model or effort level that the agent cannot verify.
- End every agent-written issue, pull request, merge request, review, or comment
  with a short signature such as `— Codex (GPT-6)`. Use the actual agent and
  model so readers can distinguish the agent from the account holder.

## Pull and merge requests

- Open with an accessible walkthrough of the specific change and how a reader
  can experience it. Follow with technical details and how tests were run.
- Include screenshots whenever the change affects the graphical interface.
  For interface actions, also try to include a short recording in a format
  that displays in the target pull or merge request.
- Host screenshots and recordings made only for pull or merge requests as GitHub
  attachments or release assets, and link them in the description.
- When a pull or merge request fully resolves an issue, include
  `Closes #<issue-number>` in its description.

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
