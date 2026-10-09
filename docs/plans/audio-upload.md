# WAV upload to a chat (#34)

Add a file picker beside the transcript actions. Upload attaches audio without
changing editor text; each clip's existing transcription action inserts at the
selected cursor. Accept only the backend's current 16 kHz mono signed 16-bit PCM
WAV format and configured size/duration limits, without codecs or dependencies.

Reuse the recording PUT endpoint and choose an ID before the first attempt.
Lock recording, navigation and editing during upload; preserve text/selection.
Keep ambiguous/network failures in the existing tab-local unsaved clip, with an
upload-only retry that works even without a ready model. Reject invalid formats
with backend feedback and leave the picker available to select a replacement.

Verify strict validation through API tests, exercise upload/transcription/retry
and operation races through client interaction tests, run `make check`, and
capture browser screenshots and a short recording with mocked inference labeled.
