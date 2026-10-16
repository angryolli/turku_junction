from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from app.models.schemas import (
    ChatCreateRequest,
    ChatDetail,
    ChatSaveRequest,
    ChatSummary,
    ConfigUpdate,
    DataSource,
    DataSourceBulkDelete,
    DataSourceCreate,
    DataSourceFileCreate,
    DataSourcePreview,
    DataSourcePreviewRequest,
    DataSourceUpdate,
    DecisionAppend,
    DecisionLogPage,
    HealthResponse,
    MonitorSnapshot,
    RuntimeConfig,
    SimulationRunDetail,
    SimulationRunSummary,
    StreamControl,
    StreamResetResponse,
)
from app.state import STATE


_snapshot_subs: set[asyncio.Queue[MonitorSnapshot | None]] = set()
_event_subs: set[asyncio.Queue[dict | None]] = set()
_events_key: tuple | None = None
_stopping = False


def _wake(queues: set[asyncio.Queue]) -> None:
    for queue in list(queues):
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _stopping
    _stopping = False
    STATE.boot()
    task = asyncio.create_task(_stream())
    try:
        yield
    finally:
        _stopping = True
        _wake(_snapshot_subs)
        _wake(_event_subs)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def _push(queue: asyncio.Queue, item: Any) -> None:
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        pass


async def _stream() -> None:
    global _events_key
    while not _stopping:
        STATE.tick_live()
        snap = STATE.monitor()
        for queue in list(_snapshot_subs):
            _push(queue, snap)
        key = STATE.events_key()
        if key != _events_key:
            _events_key = key
            payload = STATE.events_snapshot()
            for queue in list(_event_subs):
                _push(queue, payload)
        await asyncio.sleep(STATE.tick_seconds)


def _broadcast_snapshot() -> MonitorSnapshot:
    snap = STATE.monitor()
    for queue in list(_snapshot_subs):
        _push(queue, snap)
    return snap


def _broadcast_events() -> dict:
    payload = STATE.events_snapshot()
    for queue in list(_event_subs):
        _push(queue, payload)
    return payload


def _sse(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


def _sse_snapshot(snap: MonitorSnapshot) -> str:
    return _sse("snapshot", snap.model_dump_json())


def _sse_events(payload: dict) -> str:
    return _sse("events", json.dumps(payload))


class _SkipStreamGZip:
    """Gzip JSON, but never event streams (gzip buffers and breaks SSE)."""

    def __init__(self, app: ASGIApp, minimum_size: int = 500) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = str(scope.get("path") or "")
        if scope["type"] == "http" and path.endswith("/stream"):
            await self.app(scope, receive, send)
            return
        await self.gzip(scope, receive, send)


app = FastAPI(title="Trustworthy process monitor — compute plane", lifespan=lifespan)
app.add_middleware(_SkipStreamGZip, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    tick = STATE.source.tick if STATE.source is not None else 0
    return HealthResponse(
        status="ok",
        stream_tick=tick,
        live_rows=tick,
    )


@app.get("/config", response_model=RuntimeConfig)
def get_config() -> RuntimeConfig:
    return STATE.runtime_config()


@app.post("/config", response_model=RuntimeConfig)
def post_config(body: ConfigUpdate) -> RuntimeConfig:
    try:
        return STATE.update_config(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/data-sources", response_model=list[DataSource])
def data_sources_list() -> list[DataSource]:
    return STATE.list_data_sources()


@app.post("/data-sources", response_model=DataSource)
def data_sources_create(body: DataSourceCreate) -> DataSource:
    try:
        return STATE.add_data_source(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/data-sources/preview", response_model=DataSourcePreview)
def data_sources_preview(body: DataSourcePreviewRequest) -> DataSourcePreview:
    if not body.path.strip():
        raise HTTPException(400, "file path is required")
    try:
        return DataSourcePreview(**STATE.preview_source(body.path))
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/data-sources/api", response_model=DataSource)
def data_sources_api(body: DataSourceCreate) -> DataSource:
    try:
        return STATE.add_api_source(body.api_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/data-sources/file", response_model=DataSource)
def data_sources_file(body: DataSourceFileCreate) -> DataSource:
    if not body.path.strip():
        raise HTTPException(400, "file path is required")
    if not body.x_column.strip():
        raise HTTPException(400, "x-axis column is required")
    if not body.y_columns:
        raise HTTPException(400, "at least one data column is required")
    try:
        return STATE.add_file_source(body.path, body.x_column, body.y_columns)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.put("/data-sources/{source_id}", response_model=DataSource)
def data_sources_update(source_id: str, body: DataSourceUpdate) -> DataSource:
    try:
        return STATE.patch_data_source(source_id, body)
    except KeyError as exc:
        raise HTTPException(404, "unknown data source") from exc


@app.delete("/data-sources/{source_id}")
def data_sources_delete(source_id: str) -> dict:
    try:
        STATE.remove_data_source(source_id)
    except KeyError as exc:
        raise HTTPException(404, "unknown data source") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@app.post("/data-sources/bulk-delete")
def data_sources_bulk_delete(body: DataSourceBulkDelete) -> MonitorSnapshot:
    if not body.fields:
        raise HTTPException(400, "no data sources selected")
    STATE.remove_fields([item.model_dump() for item in body.fields])
    return _broadcast_snapshot()


@app.post("/stream/control", response_model=MonitorSnapshot)
def stream_control(body: StreamControl) -> MonitorSnapshot:
    if body.ticks_per_second is not None:
        try:
            STATE.set_ticks_per_second(body.ticks_per_second)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    if body.playing is not None:
        STATE.set_playing(body.playing)
    return _broadcast_snapshot()


@app.post("/stream/reset", response_model=StreamResetResponse)
def stream_reset() -> StreamResetResponse:
    snap, archived_run_id = STATE.reset_simulation()
    _broadcast_events()
    _broadcast_snapshot()
    return StreamResetResponse(snapshot=snap, archived_run_id=archived_run_id)


@app.get("/simulation/runs", response_model=list[SimulationRunSummary])
def simulation_runs(limit: int = Query(default=50, ge=1, le=200)) -> list[SimulationRunSummary]:
    return [SimulationRunSummary(**row) for row in STATE.store.list_simulation_runs(limit)]


@app.get("/simulation/runs/{run_id}", response_model=SimulationRunDetail)
def simulation_run(run_id: str) -> SimulationRunDetail:
    row = STATE.store.get_simulation_run(run_id)
    if row is None:
        raise HTTPException(404, f"unknown simulation run {run_id}")
    return SimulationRunDetail(**row)


@app.get("/diagnosis")
def diagnosis() -> dict:
    return STATE.diagnosis_snapshot()


@app.get("/events")
def events() -> dict:
    return STATE.events_snapshot()


@app.get("/events/stream")
async def events_stream() -> StreamingResponse:
    async def frames():
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=1)
        _event_subs.add(queue)
        try:
            yield _sse_events(STATE.events_snapshot())
            while not _stopping:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=0.4)
                except asyncio.TimeoutError:
                    continue
                if payload is None:
                    break
                yield _sse_events(payload)
        finally:
            _event_subs.discard(queue)

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/monitor/snapshot", response_model=MonitorSnapshot)
def monitor() -> MonitorSnapshot:
    return STATE.monitor()


@app.get("/monitor/stream")
async def monitor_stream() -> StreamingResponse:
    async def events():
        queue: asyncio.Queue[MonitorSnapshot | None] = asyncio.Queue(maxsize=1)
        _snapshot_subs.add(queue)
        try:
            yield _sse_snapshot(STATE.monitor())
            while not _stopping:
                try:
                    snap = await asyncio.wait_for(queue.get(), timeout=0.4)
                except asyncio.TimeoutError:
                    continue
                if snap is None:
                    break
                yield _sse_snapshot(snap)
        finally:
            _snapshot_subs.discard(queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/decision-log/append")
def log_append(body: DecisionAppend):
    return STATE.log(body)


@app.get("/decision-log", response_model=DecisionLogPage)
def log_get(
    type: str | None = Query(default=None),
    human_overridden: bool = False,
) -> DecisionLogPage:
    entries, total = STATE.store.page(type, human_overridden)
    return DecisionLogPage(entries=entries, total=total)


@app.get("/chats", response_model=list[ChatSummary])
def chats_list() -> list[ChatSummary]:
    return [ChatSummary(**row) for row in STATE.store.list_chats()]


@app.post("/chats", response_model=ChatDetail)
def chats_create(body: ChatCreateRequest | None = None) -> ChatDetail:
    row = STATE.store.create_chat((body.title if body else "New chat"))
    return ChatDetail(**row)


@app.get("/chats/{chat_id}", response_model=ChatDetail)
def chats_get(chat_id: str) -> ChatDetail:
    row = STATE.store.get_chat(chat_id)
    if row is None:
        raise HTTPException(404, "unknown chat")
    return ChatDetail(**row)


@app.put("/chats/{chat_id}/messages", response_model=ChatSummary)
def chats_save(chat_id: str, body: ChatSaveRequest) -> ChatSummary:
    row = STATE.store.save_chat_messages(
        chat_id,
        [m.model_dump() for m in body.messages],
    )
    if row is None:
        raise HTTPException(404, "unknown chat")
    return ChatSummary(**row)


@app.delete("/chats/{chat_id}")
def chats_delete(chat_id: str) -> dict:
    if not STATE.store.delete_chat(chat_id):
        raise HTTPException(404, "unknown chat")
    return {"ok": True}
