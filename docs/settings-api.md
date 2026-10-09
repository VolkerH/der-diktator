# Settings and preferences

Open **Settings** in the sidebar to edit the copy preamble, default sharing
format and next-recording interval. Save writes changed preferences atomically to the shared local profile;
Cancel discards this dialog's draft. Keyboard shortcuts and Speech models open
their existing controls with their own persistence and actions. Model selection
remains instance state owned by the model API.

`GET /api/settings` returns a typed `EffectiveSettings` snapshot in OpenAPI:
`profile_scope`, `operator_editable: false`, `model_selection`, `policy_revision`,
`upload_timeout_seconds`, `client_timeout_margin_seconds`, `client_upload_timeout_ms`, and `limits`. Each limit has `id`, `label`, integer `value`, `unit`,
`source: application_configuration`, `editable: false`, and
`restart_required: true`. The source identifies the running application's frozen
configuration, including injected configuration; it does not infer whether an
operator used an environment variable, CLI or file. The API omits host addresses,
engine URLs, filesystem paths and secrets. It needs no operator authorization to
read this safe subset. PATCH/PUT are unsupported (405); this stage grants no
operator writes, restart action or storage relocation.

The revision is a deterministic identifier for this public snapshot. It is not
an engine handshake or write validator. Limits describe web application
recording/upload/text enforcement; an engine may impose additional constraints.
The default recording ceiling is 3600 seconds and the default interval is 1800
seconds. A profile can choose whole-minute intervals from 60 seconds through the
operator ceiling. Each extension adds the original frozen interval; extensions
that cannot fit in full are disabled. A later settings save applies to the next
recording. Settings shows both a saved request and its effective interval when
a lower operator ceiling constrains it.

`GET /api/recording-policy` checks current engine agreement and returns the safe
recording policy together with one preference snapshot and its strong ETag.
The browser reads it before microphone access and freezes that recording's
interval, ceiling, model and timeout budgets. The application settings revision
still identifies the web display snapshot only. See [recording policy](recording-policy-api.md).

Preferences use the existing `GET/PATCH /api/preferences` and ETag/If-Match
contract. Stale writes return 412 without changing preferences. The dialog retains
its draft, blocks another save, and offers an explicit confirmed reload. After
uncertain network writes, refetch and reconcile rather than replaying. Editing
keyboard settings while a settings draft is open may invalidate its ETag; the
same conflict handling applies. See [preferences API](preferences-export-api.md).

Future #9 stages must define authorized operator capabilities, actual CLI/env/file
precedence, saved versus effective/pending values, coordinated restart, and a
stop/copy/verify/restart storage migration procedure. They are not delivered by
this read-only snapshot and dialog.
