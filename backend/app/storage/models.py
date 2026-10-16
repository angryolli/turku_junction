from __future__ import annotations

from sqlmodel import Field, SQLModel


class ArtifactRecord(SQLModel, table=True):
    __tablename__ = "artifacts"

    kind: str = Field(primary_key=True)
    key: str = Field(primary_key=True)
    json: str
    updated_at: str


class DecisionLogRecord(SQLModel, table=True):
    __tablename__ = "decision_log"

    id: int | None = Field(default=None, primary_key=True)
    ts: str
    type: str = Field(index=True)
    payload: str
    evidence_ref: str = ""
    human_overridden: bool = Field(default=False, index=True)


class ChatConversationRecord(SQLModel, table=True):
    __tablename__ = "chat_conversations"

    id: str = Field(primary_key=True)
    title: str = ""
    created_at: str
    updated_at: str = Field(index=True)


class ChatMessageRecord(SQLModel, table=True):
    __tablename__ = "chat_messages"

    id: str = Field(primary_key=True)
    conversation_id: str = Field(index=True, foreign_key="chat_conversations.id")
    seq: int
    role: str
    content: str = ""
    ui_json: str = "{}"
    created_at: str


class DataSourceRecord(SQLModel, table=True):
    __tablename__ = "data_sources"

    id: str = Field(primary_key=True)
    name: str
    kind: str = "process"
    description: str = ""
    generator: str = "industrial"
    origin: str = "generator"
    api_url: str = ""
    file_path: str = ""
    train_path: str = ""
    live_path: str = ""
    x_column: str = ""
    y_columns: str = "[]"
    created_at: str
    updated_at: str


class SimulationStateRecord(SQLModel, table=True):
    __tablename__ = "simulation_state"

    id: str = Field(primary_key=True, default="current")
    playing: bool = False
    tick: int = 0
    t2_history: str = "[]"
    run_started_at: str = ""
    updated_at: str = ""


class SimulationRunRecord(SQLModel, table=True):
    __tablename__ = "simulation_runs"

    id: str = Field(primary_key=True)
    started_at: str = ""
    ended_at: str = ""
    tick: int = 0
    finished: bool = False
    sources_json: str = "[]"
    alarm_count: int = 0
    decision_count: int = 0


class SimulationRunAlarmRecord(SQLModel, table=True):
    __tablename__ = "simulation_run_alarms"

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(index=True, foreign_key="simulation_runs.id")
    signal_id: str = ""
    tick: int = 0
    level: str = "yellow"
    score: float = 0.0
    z: float = 0.0
    top_fields: str = "[]"
    evidence: str = ""
    reason: str = ""
    origins: str = "[]"
    created_at: str = ""


class SimulationRunDecisionRecord(SQLModel, table=True):
    __tablename__ = "simulation_run_decisions"

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(index=True, foreign_key="simulation_runs.id")
    ts: str = ""
    type: str = Field(index=True)
    payload: str = "{}"
    evidence_ref: str = ""
    human_overridden: bool = False


class SimulationSourceHistoryRecord(SQLModel, table=True):
    __tablename__ = "simulation_source_history"

    source_id: str = Field(primary_key=True)
    file_path: str = ""
    file_name: str = ""
    x_column: str = ""
    y_columns: str = "[]"
    tick: int = 0
    file_offset: int = 0
    exhausted: bool = False
    sparklines: str = "{}"
    updated_at: str = ""


class DiagnosisSignalRecord(SQLModel, table=True):
    __tablename__ = "diagnosis_signals"

    id: str = Field(primary_key=True)
    tick: int = 0
    level: str = "yellow"
    score: float = 0.0
    z: float = 0.0
    top_fields: str = "[]"
    evidence: str = ""
    reason: str = ""
    origins: str = "[]"
    created_at: str = ""
