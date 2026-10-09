"""Serve the browser interface and bounded audio uploads from the same origin."""

import asyncio
import pathlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from io import BytesIO
from typing import Annotated

import httpx
from fastapi import (
    Body,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketState
from websockets.exceptions import WebSocketException

from diktator.audio import RecordingInfo, validate_recording
from diktator.chats import (
    Chat,
    ChatService,
    ChatSummary,
    ChatText,
    ChatTitle,
    Recording,
    TitleUpdate,
)
from diktator.config import Settings
from diktator.db.rows import LOCAL_USER_ID
from diktator.effective_settings import EffectiveSettings, effective_settings
from diktator.engine import EngineClient, Transcription
from diktator.errors import (
    ApiFailure,
    StreamErrorEvent,
    error_responses,
    install_error_handlers,
)
from diktator.exports import ExportFormat, ExportPreviewRequest, PreparedExport, format_export
from diktator.group_models import ChatCreate, ChatPlacement, Group, GroupName, PlacementUpdate
from diktator.groups import GroupService
from diktator.models import ModelId, ModelsStatus
from diktator.preferences import Preferences, PreferenceService, PreferenceUpdate
from diktator.recording_policy import PublicRecordingPolicy, RecordingPolicy
from diktator.storage import Storage, open_storage
from diktator.streaming import (
    StreamConnector,
    connect_engine,
    relay_stream,
    stream_failure,
    stream_url,
)

STATIC_DIRECTORY = pathlib.Path(__file__).parent / "static"
MEDIA_TYPES = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}
ChatId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    stream_connector: StreamConnector = connect_engine,
    storage: Storage | None = None,
) -> FastAPI:
    """Create an application with injectable HTTP and streaming engine boundaries."""
    settings = settings or Settings.from_environment()
    client = httpx.AsyncClient(
        base_url=settings.engine_url,
        timeout=httpx.Timeout(
            connect=5,
            pool=5,
            read=settings.recording_policy.batch_timeout_seconds
            + settings.recording_policy.client_timeout_margin_seconds,
            write=settings.recording_policy.upload_timeout_seconds
            + settings.recording_policy.client_timeout_margin_seconds,
        ),
        transport=transport,
        trust_env=False,
    )
    engine = EngineClient(client)

    def store() -> ChatService:
        return app.state.storage.chats

    def groups() -> GroupService:
        return GroupService(store().engine)

    def local_actor() -> str:
        return LOCAL_USER_ID

    Actor = Annotated[str, Depends(local_actor)]

    class TextUpdate(BaseModel):
        text: str = Field(max_length=settings.max_text_characters)

    class DraftExport(BaseModel):
        model_config = ConfigDict(extra="forbid")
        format: ExportFormat = "plain"
        # Length errors use the public 413 code rather than generic Pydantic 422.
        text: str = Field(json_schema_extra={"maxLength": settings.max_text_characters})

    # The bundled interface is small: load once rather than reading files per request.
    html = (STATIC_DIRECTORY / "index.html").read_bytes()
    assets = {
        path.name: path.read_bytes()
        for path in STATIC_DIRECTORY.iterdir()
        if path.suffix in MEDIA_TYPES
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with client:
            owned = storage or await run_in_threadpool(open_storage, settings)
            _app.state.storage = owned
            try:
                yield
            finally:
                await run_in_threadpool(owned.close)
                del _app.state.storage

    app = FastAPI(title="Der Diktator", lifespan=lifespan)
    install_error_handlers(app)

    @app.get("/", include_in_schema=False)
    async def index() -> Response:
        return Response(html, media_type="text/html")

    @app.get("/assets/{filename}", include_in_schema=False)
    async def asset(filename: str) -> Response:
        content = assets.get(filename)
        if content is None:
            raise HTTPException(404, "Asset not found.")
        return Response(content, media_type=MEDIA_TYPES[pathlib.Path(filename).suffix])

    @app.get("/api/health")
    async def health() -> dict[str, bool | int]:
        return {
            "ready": await engine.is_ready(),
            "max_duration_seconds": settings.max_duration_seconds,
        }

    @app.get("/api/models", responses=error_responses(409, 422, 502, 503, 504))
    async def models() -> ModelsStatus:
        return await engine.models()

    @app.post(
        "/api/models/{model}/download",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def download_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "download")

    @app.post(
        "/api/models/{model}/activate",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def activate_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "activate")

    @app.post(
        "/api/models/{model}/delete",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def delete_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "delete")

    async def read_recording(request: Request) -> tuple[bytes, RecordingInfo]:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"audio/wav", "audio/x-wav"}:
            raise ApiFailure("Send the recording as PCM WAV audio.", "unsupported_audio", 415)
        audio = BytesIO()
        try:
            async with asyncio.timeout(settings.recording_policy.upload_timeout_seconds):
                async for chunk in request.stream():
                    if audio.tell() + len(chunk) > settings.max_audio_bytes:
                        raise ApiFailure(
                            "The recording is too large. "
                            f"The limit is {settings.max_audio_bytes} bytes.",
                            "audio_too_large",
                            413,
                        )
                    audio.write(chunk)
        except TimeoutError as error:
            raise ApiFailure(
                "Audio upload timed out. Keep the recording and retry saving.",
                "upload_timeout",
                408,
            ) from error
        # BytesIO.getvalue shares its immutable buffer on CPython; avoid retaining
        # a full bytearray alongside a full bytes copy for long uploads.
        recording = audio.getvalue()
        audio.close()
        try:
            info = await run_in_threadpool(
                validate_recording, recording, max_duration_seconds=settings.max_duration_seconds
            )
        except ValueError as error:
            raise ApiFailure(str(error), "invalid_audio", 400) from error
        return recording, info

    @app.post(
        "/api/transcribe", responses=error_responses(400, 408, 409, 413, 415, 422, 502, 503, 504)
    )
    async def transcribe(request: Request, model: ModelId = "phonon-2") -> Transcription:
        recording, _info = await read_recording(request)
        return await engine.transcribe(recording, model, policy=settings.recording_policy)

    @app.get(
        "/api/settings",
        description=(
            "Read non-secret limits enforced by the running application. Operator fields "
            "are read-only. The revision identifies this snapshot, not engine policy agreement."
        ),
    )
    def get_settings() -> EffectiveSettings:
        return effective_settings(settings)

    def preferences() -> PreferenceService:
        return PreferenceService(
            app.state.storage.engine, hard_limit_seconds=settings.max_duration_seconds
        )

    @app.get("/api/recording-policy", responses=error_responses(503, 504))
    async def get_recording_policy(actor_id: Actor) -> PublicRecordingPolicy:
        await engine.recording_policy(settings.recording_policy)
        preference = await run_in_threadpool(preferences().get, actor_id)
        policy = settings.recording_policy
        return PublicRecordingPolicy(
            **{key: getattr(policy, key) for key in RecordingPolicy.model_fields},
            preference_etag=preference.etag(actor_id),
            recording_interval_seconds=preference.recording_interval_seconds,
            requested_recording_interval_seconds=preference.requested_recording_interval_seconds,
            default_recording_interval_seconds=preference.default_recording_interval_seconds,
            recording_interval_is_default=preference.recording_interval_is_default,
            recording_interval_constrained=preference.recording_interval_constrained,
            recording_interval_constraint_reason=preference.recording_interval_constraint_reason,
        )

    preference_headers = {
        "ETag": {
            "description": "Opaque strong validator for the complete preference representation.",
            "schema": {"type": "string"},
        }
    }

    @app.get(
        "/api/preferences", responses={**error_responses(503), 200: {"headers": preference_headers}}
    )
    def get_preferences(actor_id: Actor, response: Response) -> Preferences:
        result = preferences().get(actor_id)
        response.headers["ETag"] = result.etag(actor_id)
        return result

    @app.patch(
        "/api/preferences",
        responses={**error_responses(412, 422, 428, 503), 200: {"headers": preference_headers}},
        description=(
            "Update the server-resolved user's preferences. If-Match is required; stale "
            "validators return 412 without writes. Omitted fields stay unchanged; reset "
            "lists restore defaults. Refetch after an uncertain write, retaining the local "
            "draft."
        ),
    )
    def update_preferences(
        update: PreferenceUpdate,
        actor_id: Actor,
        response: Response,
        if_match: Annotated[str | None, Header()] = None,
    ) -> Preferences:
        result = preferences().update(actor_id, update, if_match)
        response.headers["ETag"] = result.etag(actor_id)
        return result

    @app.post(
        "/api/exports",
        responses=error_responses(400, 413, 422, 503),
        description=(
            "Prepare an exact unsaved draft. Plain preserves text; with_preamble resolves "
            "this user's preference and wraps the draft in a safe Markdown fence. No chat, "
            "history, clipboard or delivery effects. Whitespace-only input is rejected; "
            "maximum text length is the configured transcript limit (1,000,000 characters "
            "by default). Retain successful output through final copy/share."
        ),
    )
    def prepare_export(draft: DraftExport, actor_id: Actor) -> PreparedExport:
        if len(draft.text) > settings.max_text_characters:
            raise ApiFailure("The text exceeds the export limit.", "text_too_large", 413)
        preamble = (
            preferences().get(actor_id).copy_preamble if draft.format == "with_preamble" else None
        )
        return format_export(draft.text, preamble)

    @app.post(
        "/api/exports/preview",
        responses=error_responses(400, 422),
        description=(
            "Preview an unsaved preamble against a fixed server example; never saves "
            "preferences or chat text."
        ),
    )
    def preview_export(draft: ExportPreviewRequest) -> PreparedExport:
        return format_export("Your dictated text appears here.", draft.copy_preamble)

    group_headers = {
        "ETag": {
            "description": "Opaque strong validator for this private resource.",
            "schema": {"type": "string"},
        }
    }

    def group_response(response: Response, group: Group) -> Group:
        response.headers["ETag"] = group.etag
        return group

    @app.get(
        "/api/groups",
        responses=error_responses(500),
        description="List only the current actor's groups in creation order. "
        "Duplicate names are allowed.",
    )
    def list_groups(actor_id: Actor) -> list[Group]:
        return groups().list(actor_id)

    @app.post(
        "/api/groups",
        status_code=201,
        responses={**error_responses(422, 500), 201: {"headers": group_headers}},
    )
    def create_group(name: GroupName, actor_id: Actor, response: Response) -> Group:
        return group_response(response, groups().create(actor_id, name.name)[0])

    @app.put(
        "/api/groups/{group_id}",
        description="Create a private group with a client-chosen lowercase 32-hex ID and name. "
        "An existing own ID returns the current group without changing its name. "
        "Returns 201 for creation, 200 for an existing own ID, or 409 idempotency_conflict for "
        "an ID owned by another actor. Reuse the same ID after an unknown outcome. "
        "Deleted IDs can create a new incarnation.",
        responses={
            **error_responses(409, 422, 500),
            200: {"headers": group_headers},
            201: {"model": Group, "headers": group_headers},
        },
    )
    def create_group_with_id(
        group_id: ChatId, name: GroupName, actor_id: Actor, response: Response
    ) -> Group:
        group, created = groups().create(actor_id, name.name, group_id)
        response.status_code = 201 if created else 200
        return group_response(response, group)

    @app.get(
        "/api/groups/{group_id}",
        responses={**error_responses(404, 422, 500), 200: {"headers": group_headers}},
    )
    def get_group(group_id: ChatId, actor_id: Actor, response: Response) -> Group:
        return group_response(response, groups().get(actor_id, group_id))

    @app.put(
        "/api/groups/{group_id}/name",
        description="Rename only this actor's group. Trim 1-80 Unicode code points, excluding "
        "controls/line breaks. Invalid names return invalid_group_name. Optional If-Match "
        "uses the group ETag; stale/weak values return 412 revision_conflict. Identical names "
        "change nothing. Renames do not modify any chats, titles, recordings or recency.",
        responses={**error_responses(404, 412, 422, 500), 200: {"headers": group_headers}},
    )
    def rename_group(
        group_id: ChatId,
        name: GroupName,
        actor_id: Actor,
        response: Response,
        if_match: Annotated[str | None, Header()] = None,
    ) -> Group:
        return group_response(response, groups().rename(actor_id, group_id, name.name, if_match))

    @app.delete(
        "/api/groups/{group_id}",
        status_code=204,
        description="Delete this actor's group and atomically move its placements to "
        "Unsorted (null), advancing each private placement revision. Keep every shared "
        "chat, title, text, recording and recency unchanged. Optional If-Match uses the "
        "group validator; stale values write nothing. "
        "The deleted ID can be reused with a fresh validator.",
        responses=error_responses(404, 412, 422, 500),
    )
    def delete_group(
        group_id: ChatId, actor_id: Actor, if_match: Annotated[str | None, Header()] = None
    ) -> None:
        groups().delete(actor_id, group_id, if_match)

    @app.get(
        "/api/chats/{chat_id}/group",
        description="Read the actor-private placement. Its ETag covers placement only, scoped "
        "to actor and chat incarnation. It never validates the shared Chat or its text/title.",
        responses={**error_responses(404, 422, 500), 200: {"headers": group_headers}},
    )
    def get_placement(chat_id: ChatId, actor_id: Actor, response: Response) -> ChatPlacement:
        result = groups().placement(actor_id, chat_id)
        response.headers["ETag"] = result.etag
        return result

    @app.put(
        "/api/chats/{chat_id}/group",
        description="Set this actor's one private group, or null for Unsorted. Require chat "
        "membership and ownership of the destination. Optional If-Match checks the placement "
        "validator atomically; stale values write nothing. An identical placement is a no-op. "
        "Moves leave shared Chat/text/title validators, recency and recordings unchanged.",
        responses={**error_responses(404, 412, 422, 500), 200: {"headers": group_headers}},
    )
    def move_chat(
        chat_id: ChatId,
        placement: PlacementUpdate,
        actor_id: Actor,
        response: Response,
        if_match: Annotated[str | None, Header()] = None,
    ) -> ChatPlacement:
        result = groups().move(actor_id, chat_id, placement.group_id, if_match)
        response.headers["ETag"] = result.etag
        return result

    @app.get(
        "/api/chats",
        description="List accessible chats with a server-issued opaque `etag` per entry. "
        "Use that value in `If-Match` for conditional deletion without reading the full chat. "
        "Each summary also includes actor-private group_id and placement_etag; these are "
        "independent of the shared Chat validator. "
        "Optional `q` filters words in custom names or full transcripts; matching rules and "
        "limits are documented in docs/chat-api.md.",
        responses=error_responses(422, 500),
    )
    def list_chats(
        actor_id: Actor,
        q: Annotated[
            str | None,
            Query(description="Optional words to match in custom names or full transcripts."),
        ] = None,
    ) -> list[ChatSummary]:
        return store().list(actor_id, q)

    validator_headers = {
        "ETag": {
            "description": "Opaque quoted strong validator for the complete Chat.",
            "schema": {"type": "string"},
        },
        "Title-ETag": {
            "description": "Opaque quoted strong validator for the title subresource.",
            "schema": {"type": "string"},
        },
        "Text-ETag": {
            "description": "Opaque quoted strong validator for the text subresource.",
            "schema": {"type": "string"},
        },
    }

    def chat_headers(response: Response, chat: Chat) -> Chat:
        response.headers["ETag"] = chat.etag
        response.headers["Text-ETag"] = chat.text_etag
        response.headers["Title-ETag"] = chat.title_etag
        return chat

    @app.post(
        "/api/chats",
        status_code=201,
        responses={**error_responses(404, 422, 500), 201: {"headers": validator_headers}},
        description="Create an empty chat with a server-chosen ID. Optional group_id places it "
        "in an actor-owned group; omitted/null options default to Unsorted. "
        "Returns the shared Chat "
        "with its `ETag` and independent `Text-ETag` for subsequent text saves.",
    )
    def create_chat(
        actor_id: Actor,
        response: Response,
        options: Annotated[ChatCreate | None, Body()] = None,
    ) -> Chat:
        return chat_headers(
            response, store().create(actor_id, options.group_id if options else None)
        )

    @app.put(
        "/api/chats/{chat_id}",
        description="Create an empty chat using a lowercase 32-hex client ID. Optional group_id "
        "is an actor-owned group or null (Unsorted); omitted bodies/options default to null. "
        "An accessible existing ID ignores creation options and "
        "returns 200 with the current shared Chat after later moves or group deletion. An "
        "inaccessible ID returns 409 idempotency_conflict; "
        "a missing destination for a new ID returns 404 group_not_found. Return 201 for new chats. "
        "Reuse the same ID after a lost response. Deletion permits a fresh "
        "chat incarnation; group placement has its own subresource and validator.",
        responses={
            **error_responses(404, 409, 422, 500),
            200: {"headers": validator_headers},
            201: {"model": Chat, "headers": validator_headers},
        },
    )
    def create_chat_with_id(
        chat_id: ChatId,
        actor_id: Actor,
        response: Response,
        options: Annotated[ChatCreate | None, Body()] = None,
    ) -> Chat:
        result, created = store().create_with_id(
            actor_id, chat_id, options.group_id if options else None
        )
        response.status_code = 201 if created else 200
        return chat_headers(response, result)

    @app.get(
        "/api/chats/{chat_id}",
        description="Read a complete Chat. `ETag` validates the entire returned representation; "
        "`Text-ETag` independently validates its text. Retain quoted header values verbatim. "
        "Validators change across deletion and recreation, even if revisions repeat.",
        responses={**error_responses(404, 422), 200: {"headers": validator_headers}},
    )
    def get_chat(chat_id: ChatId, actor_id: Actor, response: Response) -> Chat:
        return chat_headers(response, store().get(actor_id, chat_id))

    @app.get(
        "/api/chats/{chat_id}/text",
        description="Read the canonical text subresource. Its `ETag` validates only "
        "`{text, text_revision}` and can be sent to text PUT as `If-Match`.",
        responses={
            **error_responses(404, 422),
            200: {"headers": {"ETag": validator_headers["Text-ETag"]}},
        },
    )
    def get_text(chat_id: ChatId, actor_id: Actor, response: Response) -> ChatText:
        chat = store().get(actor_id, chat_id)
        response.headers["ETag"] = chat.text_etag
        return ChatText(text=chat.text, text_revision=chat.text_revision)

    @app.put(
        "/api/chats/{chat_id}/text",
        description="Replace text, checking optional `If-Match` against the text validator "
        "atomically with the write. A stale or weak validator returns 412 `revision_conflict` "
        "and writes nothing; `*` matches an existing accessible chat. No header retains legacy "
        "last-writer-wins behavior. Identical text changes no revisions or recency. Returns a "
        "complete Chat: `ETag` validates that body and `Text-ETag` acknowledges the saved text. "
        "Clients keep drafts after conflict and must not fetch a new validator to overwrite "
        "unseen edits with the same stale draft.",
        responses={**error_responses(404, 412, 422), 200: {"headers": validator_headers}},
    )
    def update_text(
        chat_id: ChatId,
        update: TextUpdate,
        actor_id: Actor,
        response: Response,
        if_match: Annotated[str | None, Header()] = None,
    ) -> Chat:
        return chat_headers(response, store().update_text(actor_id, chat_id, update.text, if_match))

    @app.get(
        "/api/chats/{chat_id}/title",
        description="Read the custom title and its revision. Retain ETag for conditional renames.",
        responses={
            **error_responses(404, 422),
            200: {
                "headers": {
                    "ETag": validator_headers["Title-ETag"],
                }
            },
        },
    )
    def get_title(chat_id: ChatId, actor_id: Actor, response: Response) -> ChatTitle:
        chat = store().get(actor_id, chat_id)
        response.headers["ETag"] = chat.title_etag
        return ChatTitle(custom_title=chat.custom_title, title_revision=chat.title_revision)

    @app.put(
        "/api/chats/{chat_id}/title",
        description="Set a shared title, or null for automatic naming. Optional If-Match checks "
        "only title metadata; transcript edits do not conflict. Returns the complete Chat.",
        responses={**error_responses(404, 412, 422), 200: {"headers": validator_headers}},
    )
    def update_title(
        chat_id: ChatId,
        update: TitleUpdate,
        actor_id: Actor,
        response: Response,
        if_match: Annotated[str | None, Header()] = None,
    ) -> Chat:
        return chat_headers(
            response, store().update_title(actor_id, chat_id, update.custom_title, if_match)
        )

    @app.delete(
        "/api/chats/{chat_id}",
        status_code=204,
        responses=error_responses(404, 412, 422),
        description="Delete a chat and its recordings. Optional `If-Match` checks the whole-chat "
        "validator from a Chat response or list entry, atomically with deletion. A stale "
        "validator returns 412 `revision_conflict` without deleting anything. Missing or "
        "inaccessible chats return 404. Without `If-Match`, deletion is unconditional for "
        "legacy clients. No tombstones are retained.",
    )
    def delete_chat(
        chat_id: ChatId, actor_id: Actor, if_match: Annotated[str | None, Header()] = None
    ) -> None:
        store().delete(actor_id, chat_id, if_match)

    upload_headers = {
        "Chat-ETag": {
            "description": "Opaque whole-chat validator captured atomically with the upload. "
            "This header validates the parent Chat, not the Recording response body.",
            "schema": {"type": "string"},
        },
        "Chat-Revision": {
            "description": "The parent Chat `revision` that `Chat-ETag` validates. A client "
            "adopts `Chat-ETag` only when this upload is the sole change since the version it "
            "last acknowledged.",
            "schema": {"type": "integer"},
        },
    }

    @app.post(
        "/api/chats/{chat_id}/recordings",
        status_code=201,
        responses={
            **error_responses(400, 404, 408, 413, 415, 422),
            201: {"headers": upload_headers},
        },
        description="Store validated PCM WAV as a new recording with a server-chosen ID. "
        "Returns 201 with the Recording and a parent `Chat-ETag`. The upload changes the "
        "chat validator while preserving the text validator; clients retain their "
        "acknowledged text validator. Retain capture buffers until storage is acknowledged.",
    )
    async def add_recording(
        chat_id: ChatId, request: Request, actor_id: Actor, response: Response
    ) -> Recording:
        await run_in_threadpool(store().get, actor_id, chat_id)
        audio, info = await read_recording(request)
        result = await run_in_threadpool(
            store().upload_recording, actor_id, chat_id, audio, info.duration_seconds
        )
        response.headers["Chat-ETag"] = result.chat_etag
        response.headers["Chat-Revision"] = str(result.chat_revision)
        return result.recording

    @app.put(
        "/api/chats/{chat_id}/recordings/{recording_id}",
        responses={
            **error_responses(400, 404, 408, 409, 413, 415, 422),
            200: {"headers": upload_headers},
            201: {"model": Recording, "headers": upload_headers},
        },
        description="Store validated PCM WAV once with a client-chosen lowercase 32-hex ID. "
        "Returns 201 with the Recording on creation and 200 for an exact-byte SHA-256 matching "
        "retry. Different bytes or an ID owned by another chat return 409 `idempotency_conflict` "
        "without overwriting winner audio. `Chat-ETag` is the parent validator captured with "
        "the mutation; it does not validate the Recording body or acknowledge the client's "
        "text. A retry changes no revision or recency. Legacy rows recover identity from "
        "their original audio; missing/unreadable audio returns 404 `recording_not_found` "
        "until restored. Reuse the chosen ID after a lost response and retain capture buffers "
        "until storage is acknowledged. No tombstones are retained.",
    )
    async def put_recording(
        chat_id: ChatId, recording_id: ChatId, request: Request, actor_id: Actor, response: Response
    ) -> Recording:
        await run_in_threadpool(store().get, actor_id, chat_id)
        audio, info = await read_recording(request)
        result = await run_in_threadpool(
            store().upload_recording, actor_id, chat_id, audio, info.duration_seconds, recording_id
        )
        response.status_code = 201 if result.created else 200
        response.headers["Chat-ETag"] = result.chat_etag
        response.headers["Chat-Revision"] = str(result.chat_revision)
        return result.recording

    @app.get("/api/chats/{chat_id}/recordings/{recording_id}", responses=error_responses(404, 422))
    def recording_audio(chat_id: ChatId, recording_id: ChatId, actor_id: Actor) -> Response:
        return Response(
            store().recording_audio(actor_id, chat_id, recording_id), media_type="audio/wav"
        )

    @app.post(
        "/api/chats/{chat_id}/recordings/{recording_id}/transcribe",
        responses=error_responses(400, 404, 408, 409, 413, 415, 422, 502, 503, 504),
    )
    async def transcribe_recording(
        chat_id: ChatId, recording_id: ChatId, actor_id: Actor, model: ModelId = "phonon-2"
    ) -> Transcription:
        audio = await run_in_threadpool(store().recording_audio, actor_id, chat_id, recording_id)
        # Stored clips are revalidated against this process's current policy;
        # a restart with lower limits must not silently truncate earlier audio.
        if len(audio) > settings.max_audio_bytes:
            raise ApiFailure(
                "The stored recording exceeds the current upload limit.", "audio_too_large", 413
            )
        try:
            await run_in_threadpool(
                validate_recording, audio, max_duration_seconds=settings.max_duration_seconds
            )
        except ValueError as error:
            raise ApiFailure(str(error), "invalid_audio", 400) from error
        return await engine.transcribe(audio, model, policy=settings.recording_policy)

    @app.websocket("/api/stream")
    async def live_transcription(browser: WebSocket, model: ModelId = "phonon-2") -> None:
        await browser.accept()
        try:
            await engine.recording_policy(settings.recording_policy)
            async with stream_connector(
                stream_url(settings.engine_url, model, settings.recording_policy.policy_revision)
            ) as upstream:
                await upstream.send('{"sample_rate":16000,"format":"pcm_s16le"}')
                await browser.send_json({"type": "ready"})
                await relay_stream(
                    browser,
                    upstream,
                    settings,
                    finalization_margin_seconds=settings.recording_policy.client_timeout_margin_seconds,
                )
        except WebSocketDisconnect:
            pass
        except (OSError, TimeoutError, WebSocketException, ApiFailure, ValueError) as error:
            failure = stream_failure(error)
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.send_json(
                        StreamErrorEvent(message=str(failure), code=failure.code).model_dump()
                    )
        finally:
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.close()

    return app
