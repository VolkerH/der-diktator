# Stipple recorder MVP

The recording panel uses the white-paper, dark-ink artwork supplied in
[issue #27](https://github.com/VolkerH/der-diktator/issues/27). Its 7,500 normalized
points are extracted from the issue author's [HTML prototype](https://github.com/user-attachments/files/33216894/der_diktator_stipple_recorder_white_mic.html),
using the prototype's default point count. This preserves the bowler hat and
microphone illustration. No external image service or runtime dependency is used.

The final requested direction is **right to left**, matching the old level meter
and superseding the direction in the issue comment. Microphone RMS levels modulate
a vertical wave; point x coordinates and dot sizes stay fixed. This is an audio
level visualization, not a plot of raw PCM. Silence leaves the cloud still.

`recorder-theme.js` contains the default artwork, ink color, and dot size.
`RecorderVisualization(canvas, theme)` accepts the same typed data for another
cloud. The panel's paper, ink, and muted text colors are CSS custom properties.
This MVP ships one theme. A future user-facing selector should add a validated
theme ID to the backend preferences API and load that preference in clients;
localStorage must not become the authoritative theme store. No settings or API
contract changes are needed for this fixed default.

The renderer reuses the recorder's existing level callback and timer. It never
opens another microphone or changes capture, streaming, buffer retention, or
transcription. History is bounded, pixel density is capped at 2, and drawing is
limited to 30 frames per second while recording. Idle and processing states draw
only on layout/state changes. Reduced motion displays static artwork. Hidden tabs
pause drawing and clear history; stopping clears the wave immediately. Controls,
status announcements, and the elapsed-time display remain available without a
canvas context. The decorative canvas remains hidden from assistive technology.

Validation: run `npm run check`. The visualization tests check travel direction,
silence, bounded history, reduced motion, hidden tabs, and resource cleanup.
