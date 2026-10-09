# Settings dialog delivery (#9)

Build on #31's shared preference representation and keyboard editor. Expand the
existing preamble dialog with the persisted sharing default, links to the existing
keyboard and model controls, and a readable summary of running application limits.
Keep Save/Cancel, default-following preamble semantics, backend validation, and
If-Match conflict handling; stale writes retain the draft for explicit reconciliation.

Expose typed, read-only GET /api/settings containing only safe application limits,
source, editability, restart metadata and a snapshot revision. Do not expose paths,
network addresses or secrets. No operator write capability exists at this stage.
The original read-only settings stage described web enforcement at 600 seconds.
The integrated #6 follow-up adds a 1800-second default interval, a 3600-second
ceiling, coordinated policy discovery, bounded capture and acknowledged extensions
in the same delivery. Existing model APIs remain the sole instance model authority.

Validate API snapshots and write refusal, actual preference persistence and stale
writes, client dialog/save/cancel behavior, full make check, and responsive browser
screenshots. Future #9 stages cover authorized operator configuration precedence,
restart orchestration and documented storage relocation.
