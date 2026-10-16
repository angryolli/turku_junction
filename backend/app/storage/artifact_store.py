from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from pydantic import BaseModel
from sqlalchemy import func, text
from sqlmodel import Session, SQLModel, col, create_engine, select

from app.config import ARTIFACT_DIR, DEFAULT_DATA_SOURCES
from app.models.schemas import DecisionAppend, DecisionEntry
from app.storage.models import (
    ArtifactRecord,
    ChatConversationRecord,
    ChatMessageRecord,
    DataSourceRecord,
    DecisionLogRecord,
    DiagnosisSignalRecord,
    SimulationRunAlarmRecord,
    SimulationRunDecisionRecord,
    SimulationRunRecord,
    SimulationSourceHistoryRecord,
    SimulationStateRecord,
)

DB_PATH = ARTIFACT_DIR / "monitor.sqlite"


class ArtifactStore:
    def __init__(self, path: Path | None = None) -> None:
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        self.path = path or DB_PATH
        self._lock = Lock()
        self._engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
        )
        with self._engine.connect() as conn:
            conn.execute(text("PRAGMA journal_mode=WAL"))
            conn.execute(text("PRAGMA foreign_keys=ON"))
            conn.commit()
        SQLModel.metadata.create_all(self._engine)
        self._migrate_data_sources()
        self._migrate_simulation_history()
        self._migrate_simulation_state()
        self._migrate_diagnosis_signals()
        self._migrate_run_alarms()

    def _session(self) -> Session:
        return Session(self._engine, expire_on_commit=False)

    def _migrate_data_sources(self) -> None:
        with self._engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(data_sources)")).fetchall()
            names = {row[1] for row in rows}
            additions = {
                "origin": "TEXT DEFAULT 'file'",
                "api_url": "TEXT DEFAULT ''",
                "file_path": "TEXT DEFAULT ''",
                "x_column": "TEXT DEFAULT ''",
                "y_columns": "TEXT DEFAULT '[]'",
            }
            for col_name, ddl in additions.items():
                if col_name not in names:
                    conn.execute(text(f"ALTER TABLE data_sources ADD COLUMN {col_name} {ddl}"))
            conn.commit()

    def _migrate_simulation_history(self) -> None:
        with self._engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(simulation_source_history)")).fetchall()
            names = {row[1] for row in rows}
            if names and "exhausted" not in names:
                conn.execute(
                    text(
                        "ALTER TABLE simulation_source_history "
                        "ADD COLUMN exhausted BOOLEAN DEFAULT 0"
                    )
                )
            conn.commit()

    def _migrate_simulation_state(self) -> None:
        with self._engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(simulation_state)")).fetchall()
            names = {row[1] for row in rows}
            if names and "run_started_at" not in names:
                conn.execute(
                    text("ALTER TABLE simulation_state ADD COLUMN run_started_at TEXT DEFAULT ''")
                )
            conn.commit()

    def _migrate_diagnosis_signals(self) -> None:
        with self._engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(diagnosis_signals)")).fetchall()
            names = {row[1] for row in rows}
            if not names:
                return
            if "reason" not in names:
                conn.execute(
                    text("ALTER TABLE diagnosis_signals ADD COLUMN reason TEXT DEFAULT ''")
                )
            if "origins" not in names:
                conn.execute(
                    text("ALTER TABLE diagnosis_signals ADD COLUMN origins TEXT DEFAULT '[]'")
                )
            conn.commit()

    def _migrate_run_alarms(self) -> None:
        with self._engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(simulation_run_alarms)")).fetchall()
            names = {row[1] for row in rows}
            if not names:
                return
            if "reason" not in names:
                conn.execute(
                    text("ALTER TABLE simulation_run_alarms ADD COLUMN reason TEXT DEFAULT ''")
                )
            if "origins" not in names:
                conn.execute(
                    text("ALTER TABLE simulation_run_alarms ADD COLUMN origins TEXT DEFAULT '[]'")
                )
            conn.commit()

    def put(self, kind: str, key: str, payload: BaseModel | dict) -> None:
        if isinstance(payload, BaseModel):
            raw = payload.model_dump_json()
        else:
            raw = json.dumps(payload)
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            row = session.get(ArtifactRecord, (kind, key))
            if row is None:
                session.add(
                    ArtifactRecord(kind=kind, key=key, json=raw, updated_at=now)
                )
            else:
                row.json = raw
                row.updated_at = now
            session.commit()

    def write_json(self, calibration_id: str, name: str, artifact: BaseModel) -> None:
        self.put(name, calibration_id, artifact)

    def get(self, kind: str, key: str) -> dict | None:
        with self._lock, self._session() as session:
            row = session.get(ArtifactRecord, (kind, key))
            if row is None:
                return None
            return json.loads(row.json)

    def append(self, body: DecisionAppend) -> DecisionEntry:
        entry = DecisionEntry(
            ts=datetime.now(timezone.utc).isoformat(),
            type=body.type,
            payload=body.payload,
            evidence_ref=body.evidence_ref,
            human_overridden=body.human_overridden,
        )
        with self._lock, self._session() as session:
            session.add(
                DecisionLogRecord(
                    ts=entry.ts,
                    type=entry.type,
                    payload=json.dumps(entry.payload),
                    evidence_ref=entry.evidence_ref,
                    human_overridden=entry.human_overridden,
                )
            )
            session.commit()
        return entry

    def page(
        self,
        type_filter: str | None = None,
        human_only: bool = False,
        limit: int = 80,
    ) -> tuple[list[DecisionEntry], int]:
        with self._lock, self._session() as session:
            total = session.exec(
                select(func.count()).select_from(DecisionLogRecord)
            ).one()
            stmt = select(DecisionLogRecord)
            if type_filter:
                stmt = stmt.where(col(DecisionLogRecord.type) == type_filter)
            if human_only:
                stmt = stmt.where(col(DecisionLogRecord.human_overridden).is_(True))
            stmt = stmt.order_by(col(DecisionLogRecord.id).desc()).limit(limit)
            rows = session.exec(stmt).all()
        entries = [
            DecisionEntry(
                ts=row.ts,
                type=row.type,  # type: ignore[arg-type]
                payload=json.loads(row.payload),
                evidence_ref=row.evidence_ref,
                human_overridden=bool(row.human_overridden),
            )
            for row in rows
        ]
        return entries, int(total)

    def list_chats(self) -> list[dict]:
        with self._lock, self._session() as session:
            rows = session.exec(
                select(ChatConversationRecord).order_by(
                    col(ChatConversationRecord.updated_at).desc()
                )
            ).all()
            return [
                {
                    "id": row.id,
                    "title": row.title,
                    "created_at": row.created_at,
                    "updated_at": row.updated_at,
                }
                for row in rows
            ]

    def create_chat(self, title: str = "New chat") -> dict:
        now = datetime.now(timezone.utc).isoformat()
        chat_id = uuid.uuid4().hex
        label = (title.strip() or "New chat")[:80]
        row = ChatConversationRecord(
            id=chat_id,
            title=label,
            created_at=now,
            updated_at=now,
        )
        with self._lock, self._session() as session:
            session.add(row)
            session.commit()
        return {
            "id": chat_id,
            "title": label,
            "created_at": now,
            "updated_at": now,
            "messages": [],
        }

    def get_chat(self, chat_id: str) -> dict | None:
        with self._lock, self._session() as session:
            conv = session.get(ChatConversationRecord, chat_id)
            if conv is None:
                return None
            rows = session.exec(
                select(ChatMessageRecord)
                .where(col(ChatMessageRecord.conversation_id) == chat_id)
                .order_by(col(ChatMessageRecord.seq))
            ).all()
            messages = [json.loads(row.ui_json) for row in rows]
            return {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at,
                "updated_at": conv.updated_at,
                "messages": messages,
            }

    def save_chat_messages(self, chat_id: str, messages: list[dict]) -> dict | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            conv = session.get(ChatConversationRecord, chat_id)
            if conv is None:
                return None
            existing = session.exec(
                select(ChatMessageRecord).where(
                    col(ChatMessageRecord.conversation_id) == chat_id
                )
            ).all()
            for row in existing:
                session.delete(row)
            title = conv.title
            for seq, msg in enumerate(messages):
                parts = msg.get("parts") or []
                texts = [
                    str(p.get("text", ""))
                    for p in parts
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                content = "\n".join(t for t in texts if t)
                if title in ("", "New chat") and msg.get("role") == "user" and content:
                    title = content.strip().split("\n", 1)[0][:80]
                mid = str(msg.get("id") or uuid.uuid4().hex)
                session.add(
                    ChatMessageRecord(
                        id=f"{chat_id}:{mid}",
                        conversation_id=chat_id,
                        seq=seq,
                        role=str(msg.get("role") or "user"),
                        content=content,
                        ui_json=json.dumps(msg),
                        created_at=now,
                    )
                )
            conv.title = title
            conv.updated_at = now
            session.commit()
            return {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at,
                "updated_at": conv.updated_at,
            }

    def delete_chat(self, chat_id: str) -> bool:
        with self._lock, self._session() as session:
            conv = session.get(ChatConversationRecord, chat_id)
            if conv is None:
                return False
            rows = session.exec(
                select(ChatMessageRecord).where(
                    col(ChatMessageRecord.conversation_id) == chat_id
                )
            ).all()
            for row in rows:
                session.delete(row)
            session.flush()
            session.delete(conv)
            session.commit()
            return True

    def _source_dict(self, row: DataSourceRecord) -> dict:
        raw_y = getattr(row, "y_columns", None) or "[]"
        try:
            y_columns = json.loads(raw_y) if isinstance(raw_y, str) else list(raw_y)
        except (TypeError, ValueError):
            y_columns = []
        if not isinstance(y_columns, list):
            y_columns = []
        return {
            "id": row.id,
            "name": row.name,
            "kind": row.kind,
            "description": row.description,
            "generator": row.generator,
            "origin": getattr(row, "origin", None) or "file",
            "api_url": getattr(row, "api_url", None) or "",
            "file_path": getattr(row, "file_path", None) or "",
            "train_path": row.train_path,
            "live_path": row.live_path,
            "x_column": getattr(row, "x_column", None) or "",
            "y_columns": [str(c) for c in y_columns],
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }

    def seed_data_sources(self) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            existing = session.exec(select(DataSourceRecord)).first()
            if existing is not None:
                return
            for spec in DEFAULT_DATA_SOURCES:
                session.add(
                    DataSourceRecord(
                        id=spec["id"],
                        name=spec["name"],
                        kind=spec["kind"],
                        description=spec["description"],
                        generator=spec["generator"],
                        origin=spec.get("origin") or "file",
                        api_url=spec.get("api_url") or "",
                    file_path=spec.get("file_path") or "",
                    train_path=spec["train_path"],
                    live_path=spec["live_path"],
                    x_column=spec.get("x_column") or "",
                    y_columns=json.dumps(spec.get("y_columns") or []),
                        created_at=now,
                        updated_at=now,
                    )
                )
            session.commit()

    def list_data_sources(self) -> list[dict]:
        with self._lock, self._session() as session:
            rows = session.exec(select(DataSourceRecord).order_by(DataSourceRecord.created_at)).all()
            return [self._source_dict(row) for row in rows]

    def get_data_source(self, source_id: str) -> dict | None:
        with self._lock, self._session() as session:
            row = session.get(DataSourceRecord, source_id)
            return None if row is None else self._source_dict(row)

    def create_data_source(self, body: dict) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            session.add(
                DataSourceRecord(
                    id=body["id"],
                    name=body["name"],
                    kind=body.get("kind") or "process",
                    description=body.get("description") or "",
                    generator=body.get("generator") or "industrial",
                    origin=body.get("origin") or "file",
                    api_url=body.get("api_url") or "",
                    file_path=body.get("file_path") or "",
                    train_path=body["train_path"],
                    live_path=body["live_path"],
                    x_column=body.get("x_column") or "",
                    y_columns=json.dumps(body.get("y_columns") or []),
                    created_at=now,
                    updated_at=now,
                )
            )
            session.commit()
            row = session.get(DataSourceRecord, body["id"])
            assert row is not None
            return self._source_dict(row)

    def update_data_source(self, source_id: str, body: dict) -> dict | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            row = session.get(DataSourceRecord, source_id)
            if row is None:
                return None
            if "name" in body and body["name"] is not None:
                row.name = body["name"]
            if "kind" in body and body["kind"] is not None:
                row.kind = body["kind"]
            if "description" in body and body["description"] is not None:
                row.description = body["description"]
            if "generator" in body and body["generator"] is not None:
                row.generator = body["generator"]
            if "origin" in body and body["origin"] is not None:
                row.origin = body["origin"]
            if "api_url" in body and body["api_url"] is not None:
                row.api_url = body["api_url"]
            if "file_path" in body and body["file_path"] is not None:
                row.file_path = body["file_path"]
            if "x_column" in body and body["x_column"] is not None:
                row.x_column = body["x_column"]
            if "y_columns" in body and body["y_columns"] is not None:
                cols = body["y_columns"]
                row.y_columns = json.dumps(cols if isinstance(cols, list) else [])
            row.updated_at = now
            session.add(row)
            session.commit()
            session.refresh(row)
            return self._source_dict(row)

    def delete_data_source(self, source_id: str) -> bool:
        with self._lock, self._session() as session:
            row = session.get(DataSourceRecord, source_id)
            if row is None:
                return False
            hist = session.get(SimulationSourceHistoryRecord, source_id)
            if hist is not None:
                session.delete(hist)
            session.delete(row)
            session.commit()
            return True

    def get_simulation_state(self) -> dict:
        with self._lock, self._session() as session:
            row = session.get(SimulationStateRecord, "current")
            if row is None:
                return {"playing": False, "tick": 0, "t2_history": [], "run_started_at": ""}
            try:
                t2_history = json.loads(row.t2_history or "[]")
            except (TypeError, ValueError):
                t2_history = []
            if not isinstance(t2_history, list):
                t2_history = []
            return {
                "playing": bool(row.playing),
                "tick": int(row.tick or 0),
                "t2_history": [float(v) for v in t2_history],
                "run_started_at": str(getattr(row, "run_started_at", None) or ""),
            }

    def set_run_started_at(self, started_at: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            row = session.get(SimulationStateRecord, "current")
            if row is None:
                session.add(
                    SimulationStateRecord(
                        id="current",
                        playing=False,
                        tick=0,
                        t2_history="[]",
                        run_started_at=started_at,
                        updated_at=now,
                    )
                )
            else:
                row.run_started_at = started_at
                row.updated_at = now
                session.add(row)
            session.commit()

    def list_simulation_sources(self) -> list[dict]:
        with self._lock, self._session() as session:
            rows = session.exec(select(SimulationSourceHistoryRecord)).all()
            return [self._history_dict(row) for row in rows]

    def delete_simulation_source(self, source_id: str) -> None:
        with self._lock, self._session() as session:
            row = session.get(SimulationSourceHistoryRecord, source_id)
            if row is None:
                return
            session.delete(row)
            session.commit()

    def save_simulation(
        self,
        playing: bool,
        tick: int,
        t2_history: list,
        sources: list[dict],
        *,
        run_started_at: str | None = None,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            state = session.get(SimulationStateRecord, "current")
            payload = json.dumps([float(v) for v in t2_history[-60:]])
            if state is None:
                session.add(
                    SimulationStateRecord(
                        id="current",
                        playing=playing,
                        tick=tick,
                        t2_history=payload,
                        run_started_at=run_started_at or now,
                        updated_at=now,
                    )
                )
            else:
                state.playing = playing
                state.tick = tick
                state.t2_history = payload
                if run_started_at is not None:
                    state.run_started_at = run_started_at
                elif not state.run_started_at:
                    state.run_started_at = now
                state.updated_at = now
                session.add(state)
            keep = {str(item.get("source_id") or "") for item in sources}
            keep.discard("")
            existing = session.exec(select(SimulationSourceHistoryRecord)).all()
            for row in existing:
                if row.source_id not in keep:
                    session.delete(row)
            for item in sources:
                source_id = str(item.get("source_id") or "")
                if not source_id:
                    continue
                y_columns = item.get("y_columns") or []
                sparklines = item.get("sparklines") or {}
                rec = session.get(SimulationSourceHistoryRecord, source_id)
                if rec is None:
                    session.add(
                        SimulationSourceHistoryRecord(
                            source_id=source_id,
                            file_path=str(item.get("file_path") or ""),
                            file_name=str(item.get("file_name") or ""),
                            x_column=str(item.get("x_column") or ""),
                            y_columns=json.dumps(y_columns if isinstance(y_columns, list) else []),
                            tick=int(item.get("tick") or 0),
                            file_offset=int(item.get("file_offset") or 0),
                            exhausted=bool(item.get("exhausted")),
                            sparklines=json.dumps(sparklines if isinstance(sparklines, dict) else {}),
                            updated_at=now,
                        )
                    )
                else:
                    rec.file_path = str(item.get("file_path") or "")
                    rec.file_name = str(item.get("file_name") or "")
                    rec.x_column = str(item.get("x_column") or "")
                    rec.y_columns = json.dumps(y_columns if isinstance(y_columns, list) else [])
                    rec.tick = int(item.get("tick") or 0)
                    rec.file_offset = int(item.get("file_offset") or 0)
                    rec.exhausted = bool(item.get("exhausted"))
                    rec.sparklines = json.dumps(sparklines if isinstance(sparklines, dict) else {})
                    rec.updated_at = now
                    session.add(rec)
            session.commit()

    def _history_dict(self, row: SimulationSourceHistoryRecord) -> dict:
        try:
            y_columns = json.loads(row.y_columns or "[]")
        except (TypeError, ValueError):
            y_columns = []
        if not isinstance(y_columns, list):
            y_columns = []
        try:
            sparklines = json.loads(row.sparklines or "{}")
        except (TypeError, ValueError):
            sparklines = {}
        if not isinstance(sparklines, dict):
            sparklines = {}
        return {
            "source_id": row.source_id,
            "file_path": row.file_path,
            "file_name": row.file_name,
            "x_column": row.x_column,
            "y_columns": [str(c) for c in y_columns],
            "tick": int(row.tick or 0),
            "file_offset": int(row.file_offset or 0),
            "exhausted": bool(getattr(row, "exhausted", False)),
            "sparklines": {
                str(col): [float(v) for v in values]
                for col, values in sparklines.items()
                if isinstance(values, list)
            },
        }

    def append_diagnosis(self, body: dict) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        row_id = str(body.get("id") or f"sig_{uuid.uuid4().hex[:10]}")
        rec = DiagnosisSignalRecord(
            id=row_id,
            tick=int(body.get("tick") or 0),
            level=str(body.get("level") or "yellow"),
            score=float(body.get("score") or 0),
            z=float(body.get("z") or 0),
            top_fields=json.dumps(body.get("top_fields") or []),
            evidence=str(body.get("evidence") or ""),
            reason=str(body.get("reason") or ""),
            origins=json.dumps(body.get("origins") or []),
            created_at=now,
        )
        with self._lock, self._session() as session:
            session.add(rec)
            session.commit()
        return self._diagnosis_dict(rec)

    def list_diagnosis(self, limit: int = 40) -> list[dict]:
        with self._lock, self._session() as session:
            rows = session.exec(
                select(DiagnosisSignalRecord)
                .order_by(col(DiagnosisSignalRecord.created_at).desc())
                .limit(limit)
            ).all()
            return [self._diagnosis_dict(row) for row in rows]

    def clear_diagnosis(self) -> None:
        with self._lock, self._session() as session:
            rows = session.exec(select(DiagnosisSignalRecord)).all()
            for row in rows:
                session.delete(row)
            session.commit()

    def clear_diagnosis_for_sources(self, source_ids: set[str]) -> int:
        """Delete live alarms whose top channels belong to the given sources."""
        if not source_ids:
            return 0
        removed = 0
        with self._lock, self._session() as session:
            rows = session.exec(select(DiagnosisSignalRecord)).all()
            for row in rows:
                try:
                    fields = json.loads(row.top_fields or "[]")
                except json.JSONDecodeError:
                    fields = []
                touched = {
                    str(item.get("field_id") or "").split("::", 1)[0]
                    for item in fields
                    if isinstance(item, dict) and "::" in str(item.get("field_id") or "")
                }
                if touched & source_ids:
                    session.delete(row)
                    removed += 1
            if removed:
                session.commit()
        return removed

    def clear_decision_log(self) -> None:
        with self._lock, self._session() as session:
            rows = session.exec(select(DecisionLogRecord)).all()
            for row in rows:
                session.delete(row)
            session.commit()

    def archive_current_run(
        self,
        *,
        tick: int,
        finished: bool,
        sources: list[dict],
        run_started_at: str,
    ) -> str | None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._session() as session:
            alarms = session.exec(select(DiagnosisSignalRecord)).all()
            decisions = session.exec(select(DecisionLogRecord)).all()
            if tick <= 0 and not alarms and not decisions:
                return None
            run_id = f"run_{uuid.uuid4().hex[:10]}"
            started = run_started_at or now
            session.add(
                SimulationRunRecord(
                    id=run_id,
                    started_at=started,
                    ended_at=now,
                    tick=int(tick or 0),
                    finished=bool(finished),
                    sources_json=json.dumps(sources),
                    alarm_count=len(alarms),
                    decision_count=len(decisions),
                )
            )
            session.flush()
            for row in alarms:
                session.add(
                    SimulationRunAlarmRecord(
                        run_id=run_id,
                        signal_id=row.id,
                        tick=int(row.tick or 0),
                        level=str(row.level or "yellow"),
                        score=float(row.score or 0),
                        z=float(row.z or 0),
                        top_fields=row.top_fields or "[]",
                        evidence=str(row.evidence or ""),
                        reason=str(getattr(row, "reason", None) or ""),
                        origins=str(getattr(row, "origins", None) or "[]"),
                        created_at=str(row.created_at or now),
                    )
                )
                session.delete(row)
            for row in decisions:
                session.add(
                    SimulationRunDecisionRecord(
                        run_id=run_id,
                        ts=row.ts,
                        type=row.type,
                        payload=row.payload,
                        evidence_ref=row.evidence_ref,
                        human_overridden=bool(row.human_overridden),
                    )
                )
                session.delete(row)
            session.commit()
            return run_id

    def list_simulation_runs(self, limit: int = 50) -> list[dict]:
        with self._lock, self._session() as session:
            rows = session.exec(
                select(SimulationRunRecord)
                .order_by(col(SimulationRunRecord.ended_at).desc())
                .limit(limit)
            ).all()
            return [self._run_dict(row) for row in rows]

    def get_simulation_run(self, run_id: str) -> dict | None:
        with self._lock, self._session() as session:
            row = session.get(SimulationRunRecord, run_id)
            if row is None:
                return None
            alarms = session.exec(
                select(SimulationRunAlarmRecord)
                .where(col(SimulationRunAlarmRecord.run_id) == run_id)
                .order_by(col(SimulationRunAlarmRecord.tick).desc())
            ).all()
            decisions = session.exec(
                select(SimulationRunDecisionRecord)
                .where(col(SimulationRunDecisionRecord.run_id) == run_id)
                .order_by(col(SimulationRunDecisionRecord.id).desc())
            ).all()
            return {
                **self._run_dict(row),
                "alarms": [self._run_alarm_dict(item) for item in alarms],
                "decisions": [self._run_decision_dict(item) for item in decisions],
            }

    def _run_dict(self, row: SimulationRunRecord) -> dict:
        try:
            sources = json.loads(row.sources_json or "[]")
        except (TypeError, ValueError):
            sources = []
        if not isinstance(sources, list):
            sources = []
        return {
            "id": row.id,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
            "tick": int(row.tick or 0),
            "finished": bool(row.finished),
            "sources": sources,
            "alarm_count": int(row.alarm_count or 0),
            "decision_count": int(row.decision_count or 0),
        }

    def _run_alarm_dict(self, row: SimulationRunAlarmRecord) -> dict:
        try:
            top_fields = json.loads(row.top_fields or "[]")
        except (TypeError, ValueError):
            top_fields = []
        if not isinstance(top_fields, list):
            top_fields = []
        try:
            origins = json.loads(getattr(row, "origins", None) or "[]")
        except (TypeError, ValueError):
            origins = []
        if not isinstance(origins, list):
            origins = []
        reason = str(getattr(row, "reason", None) or "")
        if not reason:
            reason = _reason_from_evidence(str(row.evidence or ""))
        return {
            "id": row.signal_id,
            "tick": int(row.tick or 0),
            "level": row.level,
            "score": float(row.score or 0),
            "z": float(row.z or 0),
            "top_fields": top_fields,
            "evidence": row.evidence,
            "reason": reason,
            "origins": [str(item) for item in origins],
            "created_at": row.created_at,
        }

    def _run_decision_dict(self, row: SimulationRunDecisionRecord) -> dict:
        try:
            payload = json.loads(row.payload or "{}")
        except (TypeError, ValueError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        return {
            "ts": row.ts,
            "type": row.type,
            "payload": payload,
            "evidence_ref": row.evidence_ref,
            "human_overridden": bool(row.human_overridden),
        }

    def _diagnosis_dict(self, row: DiagnosisSignalRecord) -> dict:
        try:
            top_fields = json.loads(row.top_fields or "[]")
        except (TypeError, ValueError):
            top_fields = []
        if not isinstance(top_fields, list):
            top_fields = []
        try:
            origins = json.loads(getattr(row, "origins", None) or "[]")
        except (TypeError, ValueError):
            origins = []
        if not isinstance(origins, list):
            origins = []
        reason = str(getattr(row, "reason", None) or "")
        if not reason:
            reason = _reason_from_evidence(str(row.evidence or ""))
        return {
            "id": row.id,
            "tick": int(row.tick or 0),
            "level": row.level,
            "score": float(row.score or 0),
            "z": float(row.z or 0),
            "top_fields": top_fields,
            "evidence": row.evidence,
            "reason": reason,
            "origins": [str(item) for item in origins],
            "created_at": row.created_at,
        }


def _reason_from_evidence(evidence: str) -> str:
    """Best-effort label for alarms stored before the reason column existed."""
    text = evidence.lower()
    labels: list[str] = []
    if "zscore" in text or "z-score" in text or "k=6" in text:
        labels.append("z-score k=6")
    if "moment" in text:
        labels.append("v5 agnostic (moment)")
    elif "freeze" in text:
        labels.append("v5 agnostic (freeze)")
    elif "amp" in text:
        labels.append("v5 agnostic (amp)")
    elif "v5" in text:
        labels.append("v5 agnostic")
    return " + ".join(labels)
