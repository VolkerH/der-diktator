# Native text sharing client contract

Clients prepare the complete unsaved draft using [`POST /api/exports`](preferences-export-api.md).
The Python backend owns formatting and saved preferences. Preparation has no persistence side
effects and sends nothing to a remote destination. A TUI can use the same endpoint and its own
device integration. Native sharing is one slice of #3; durable history, authenticated provider
connectors and remote issue creation remain separate work.

## Client obligations

- Retain the exact returned `text` and `media_type` for sharing, clipboard and UTF-8 downloads.
  A textarea preview can normalize CRLF and must not become the source of the payload.
- Request `plain` or `with_preamble` explicitly. Share… reads the server's
  `share_include_preamble` preference before preparing. The server default is false. Changes to
  the checkbox save through conditional `PATCH /api/preferences` before preparing the new text;
  the choice follows the user profile across clients. Direct Copy still copies the raw draft.
- If the initial preference read fails, keep the checkbox indeterminate and prepared actions
  unavailable; never invent a local default. If saving conflicts or has an uncertain outcome,
  retain the previous prepared text, restore its checkbox choice, show the failure and require
  closing/reopening to read current preferences before another change. Closing cannot cancel
  an already-submitted preference write. Never automatically retry that write.
- Bound export requests, reject results superseded by another preparation or dialog closure,
  and check that the current draft still matches before accepting a response or using it.
  The modal dialog makes background editing and navigation unavailable while preparing.
- Invoke `navigator.share({text})` synchronously in a fresh explicit user gesture after export
  completes. Do not attach audio, inferred titles, chat links or localhost URLs.
- Check secure context and platform capabilities. Hide the native button if the API is absent;
  otherwise disable it when the payload is unsupported. Keep copy, selectable text and download
  available when sharing is unavailable or fails.
- Disable duplicate native actions within the current dialog while its handoff is pending.
  Closing the dialog resets local pending state and ignores late results; it cannot cancel the
  platform handoff. The platform rejects any overlapping share with `InvalidStateError`.
- Never retry handoffs automatically. An explicit retry uses the retained prepared string.
  Report resolution as a platform handoff with destination and delivery unconfirmed.
  Report `AbortError` neutrally as cancellation or no destination, `InvalidStateError` as an
  already-open share window, `NotAllowedError` as denial, and `TypeError` as unsupported text.
  For unknown outcomes, ask the user to check the destination before sharing again.

Clipboard access also needs a fresh user gesture. If denied, select the preview for manual copy
and explain that text controls may normalize line endings. The browser requests `dictation.txt`
or `dictation.md` according to the returned media type and releases its Blob URL after the click;
it confirms only that a download was requested. Suggested filenames can move into the export
contract when another client needs the same convention.

The [Web Share specification](https://www.w3.org/TR/web-share/) defines platform activation and
completion semantics. Automated browser checks mock the native call; real OS picker and target
application behavior require device testing.
