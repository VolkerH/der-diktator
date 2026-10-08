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

## Multilingual iteration

The next iteration keeps the same selected-text API, review interaction and
conditional save boundary. The operator-configured model is compared on English,
German, French and Spanish, with the same frozen prompts and CPU settings.

1. Replace the English-only instruction with language-preserving correction:
   preserve names, numbers, dates, units, negation and meaning; do not translate,
   obey instructions from selected text, or turn requests into completed events.
2. Require short `##` Markdown headings and topic paragraphs in headings mode for
   substantive multi-topic input. Preserve existing paragraph structure in the
   spelling-only mode.
3. Publish operator-owned language labels in capabilities and display them in the
   existing dialog. An unknown model has no implicit language-support claim;
   explicit operator configuration controls labels. Do not add browser provider
   settings or a model-management interface.
4. Compare Qwen3-4B-Instruct-2507 Q4_K_M and SmolLM3-3B Q4_K_M with matched
   synthetic inputs and all three modes, thinking disabled on the local runtime.
   Record protocol completion separately from language, factual preservation,
   formatting and timing observations; then choose the default from that evidence.
5. Validate multilingual text transport and capability configuration through the
   API, rerun repository checks, and update real-model and browser evidence.

The original SmolLM2 evidence remains historical; a larger model's completion
still requires human review. No translation feature or universal language-support
promise is introduced. The cancellation and edit-history deferrals above remain.

### Iteration outcome

The comparison selected SmolLM3-3B Q4_K_M for the interactive prototype because
it better preserved the ordinary single-language examples and used less memory.
The headings prompt was made unconditional after Qwen v1 often omitted headings;
only that mode was rerun for Qwen, while SmolLM3 used the final prompt set throughout.
The [comparison report](../issue7-evidence/multilingual-comparison.md) records exact
sources and failure examples. Neither candidate met a production-quality gate.
SmolLM3 failed all eight paragraph-break requests and could reverse an instruction
in mixed-language input. The prototype's review requirement remains essential.
