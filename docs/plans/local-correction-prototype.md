# Local correction prototype (issue #7)

This branch is an unmerged design prototype based on issue #7 and its comments:
<https://github.com/VolkerH/der-diktator/issues/7>. It explores selected-text
correction with the smallest proposed English model, SmolLM2-360M-Instruct.

## MVP steps

1. Define a Python-owned local-provider configuration, three editing modes,
   bounded requests, capability discovery and a finite preview stream. Keep the
   correction provider independent from speech-model loading and recording.
2. Add an OpenAI-compatible chat-completions adapter. Send only selected text;
   stream provisional output and require a successful authoritative completion.
   Reject empty, truncated, incomplete and malformed output. Bound concurrency,
   input, output and elapsed time. Generation never writes chats.
3. Add a keyboard-accessible “Fix selection…” toolbar action and a selected-text
   context-menu shortcut. Present original and streamed proposal, mode choice,
   explicit Accept/Cancel, and a guarded one-step Undo correction action.
4. Snapshot the full editor, selection, navigation generation and edit generation.
   Recheck before Accept, retain all text outside the selection and its outer
   whitespace, and save through the existing conditional full-text API. Editing,
   leaving and returning to a chat, recording, or an autosave conflict invalidate
   a preview. Never apply late output after cancellation.
5. Verify browser-free contracts and provider failures, client stale-result and
   cancellation behavior, existing repository checks, and a browser walkthrough.
   Try an isolated real-model smoke when a runtime is available; report it
   separately from deterministic fake-provider checks.

## Deliberate prototype boundaries

- The existing `If-Match` text save is the persistence boundary. Accept edits a
  local draft and then uses normal autosave; a remote conflict preserves that
  draft for the existing conflict workflow. It is **not** the proposed durable,
  idempotent anchored edit protocol from ADR 0004/0005. Cross-device edit history,
  membership-aware operation IDs, collaborative editing, and durable undo are
  deferred. A deleted chat must still fail the existing save API.
- No model installer, model switcher, cloud fallback, automatic downloads,
  learning from edits, or German quality claim. Larger multilingual models can
  use the same configured endpoint later.
- Modes are backend-owned operator policy, not a new stored user preference.
  The initial mode is paragraphs; selecting a different mode affects this dialog
  only. Prompts and endpoint are configured on the server.
- Stream cancellation closes the upstream request and releases local admission.
  Whether the external model server immediately stops computation is provider
  dependent. Jobs are not durable or resumable; explicit retries start new work.
- A tiny language model may invent, omit, or reword text. Every completed result
  needs human review. This prototype does not claim semantic equivalence or a
  production quality threshold.
