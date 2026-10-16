from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.config import MAX_ARTIFACT_BYTES, SPARKLINE_POINTS, TOP_CORR_PAIRS, TOP_RANK

Status = Literal["pass", "fail", "warn"]
RoleKind = Literal["measured", "actuator", "ambiguous"]
Chip = Literal["normal", "yellow", "red"]
LogType = Literal["inference", "flag", "diagnosis", "override", "question", "model_call"]


class SizedArtifact(BaseModel):
    @model_validator(mode="after")
    def enforce_byte_ceiling(self):
        n = len(self.model_dump_json().encode("utf-8"))
        if n > MAX_ARTIFACT_BYTES:
            raise ValueError(
                f"{type(self).__name__} is {n} bytes (ceiling {MAX_ARTIFACT_BYTES})"
            )
        return self


class HealthResponse(BaseModel):
    status: str
    role: str = "compute-plane"
    stream_tick: int = 0
    live_rows: int = 0


class RuntimeConfig(BaseModel):
    dataset_id: str
    datasets: list[str]
    calibration_id: str | None = None
    baseline_established: bool = False
    no_egress: bool = False
    demo_data_uri: str = ""
    playing: bool = False
    ticks_per_second: float = 2.0
    finished: bool = False


class ConfigUpdate(BaseModel):
    dataset_id: str | None = None
    no_egress: bool | None = None
    ticks_per_second: float | None = None


class CalibrateRequest(BaseModel):
    dataset_id: str | None = None


class CalibrateResponse(BaseModel):
    calibration_id: str
    dataset_id: str
    n_fields: int
    n_rows_used: int
    baseline_established: bool
    evidence: str


class DataSource(BaseModel):
    id: str
    name: str
    kind: Literal["process", "business", "other"] = "process"
    description: str = ""
    generator: str = ""
    origin: Literal["api", "file"] = "file"
    api_url: str = ""
    file_path: str = ""
    train_path: str = ""
    live_path: str = ""
    x_column: str = ""
    y_columns: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    active: bool = False


class DataSourceCreate(BaseModel):
    origin: Literal["api", "file"] = "file"
    api_url: str = ""
    file_path: str = ""
    x_column: str = ""
    y_columns: list[str] = Field(default_factory=list)


class DataSourceFileCreate(BaseModel):
    path: str
    x_column: str = ""
    y_columns: list[str] = Field(default_factory=list)


class DataSourcePreviewRequest(BaseModel):
    path: str


class DataSourcePreview(BaseModel):
    path: str
    file_name: str
    columns: list[str] = Field(default_factory=list)
    numeric: list[str] = Field(default_factory=list)


class StreamControl(BaseModel):
    playing: bool | None = None
    ticks_per_second: float | None = None


class DataSourceFieldRef(BaseModel):
    source_id: str
    field_id: str


class DataSourceBulkDelete(BaseModel):
    fields: list[DataSourceFieldRef] = Field(default_factory=list)


class DataSourceUpdate(BaseModel):
    name: str | None = None
    kind: Literal["process", "business", "other"] | None = None
    description: str | None = None


class FieldProfile(BaseModel):
    field_id: str
    n: int
    mean: float | None = None
    std: float | None = None
    min: float | None = None
    max: float | None = None
    skew: float | None = None
    kurtosis: float | None = None
    missing_rate: float = 0.0
    unique_ratio: float = 0.0
    frozen_rate: float = 0.0
    lag1_autocorr: float | None = None
    stationary: bool = True
    stationarity_evidence: str = ""
    dominant_fft: float | None = None
    evidence: str = ""


class ProfileArtifact(SizedArtifact):
    calibration_id: str
    fields: list[FieldProfile] = Field(default_factory=list, max_length=80)


class CorrelationPair(BaseModel):
    a: str
    b: str
    pearson: float
    spearman: float
    best_lag: int = 0
    lagged_corr: float | None = None
    evidence: str = ""


class Cluster(BaseModel):
    cluster_id: str
    members: list[str] = Field(max_length=40)
    evidence: str = ""


class CorrelationArtifact(SizedArtifact):
    calibration_id: str
    pairs: list[CorrelationPair] = Field(default_factory=list, max_length=TOP_CORR_PAIRS)
    clusters: list[Cluster] = Field(default_factory=list, max_length=12)


class StructuralRole(BaseModel):
    field_id: str
    role: RoleKind
    quantization_score: float
    bounded_range_score: float
    lag_centrality_score: float
    evidence: str


class RolesArtifact(SizedArtifact):
    calibration_id: str
    roles: list[StructuralRole] = Field(default_factory=list, max_length=80)


class RuleSchema(BaseModel):
    column: str
    condition: Literal["gt", "lt", "abs_gt", "stuck", "missing_rate"]
    threshold: float
    window: int = 20
    severity: Literal["info", "warn", "fail"] = "warn"
    rule_text: str = ""


class CompileRuleRequest(BaseModel):
    calibration_id: str
    rule: RuleSchema


class CompileRuleResponse(BaseModel):
    rule_id: str
    compiled: bool
    dry_run_result: Status
    evidence: str


class QualityCheckRequest(BaseModel):
    calibration_id: str
    batch_range: str = "latest"


class QualityItem(BaseModel):
    name: str
    status: Status
    evidence: str
    affected_fields: list[str] = Field(default_factory=list, max_length=20)
    originating_rule_id: str = "baseline"
    field_fault: bool = False


class QualityReport(SizedArtifact):
    calibration_id: str
    batch_id: str
    checks: list[QualityItem] = Field(default_factory=list, max_length=40)
    exclusion_list: list[str] = Field(default_factory=list, max_length=40)


class DriftScoreRequest(BaseModel):
    calibration_id: str
    batch_range: str = "latest"
    exclusion_list: list[str] = Field(default_factory=list)


class Contribution(BaseModel):
    field_id: str
    contribution_score: float
    evidence: str


class DriftEvent(BaseModel):
    event_id: str
    t_start: int
    t_end: int
    t2: float
    spe: float
    control_limit: float
    flagged: bool
    contributions: list[Contribution] = Field(default_factory=list, max_length=TOP_RANK)
    evidence: str


class DriftArtifact(SizedArtifact):
    calibration_id: str
    batch_id: str
    composite_t2: float
    composite_spe: float
    control_limit: float
    cusum: float
    series: list[float] = Field(default_factory=list, max_length=60)
    events: list[DriftEvent] = Field(default_factory=list, max_length=8)
    latest_event_id: str | None = None


class RankingArtifact(SizedArtifact):
    event_id: str
    calibration_id: str
    ranked: list[dict] = Field(default_factory=list, max_length=TOP_RANK)
    evidence: str
    confidence: float = 0.0


class DecisionAppend(BaseModel):
    type: LogType
    payload: dict = Field(default_factory=dict)
    evidence_ref: str = ""
    human_overridden: bool = False


class DecisionEntry(BaseModel):
    ts: str
    type: LogType
    payload: dict
    evidence_ref: str = ""
    human_overridden: bool = False


class DecisionLogPage(BaseModel):
    entries: list[DecisionEntry] = Field(default_factory=list, max_length=100)
    total: int = 0


class DiagnosisContributor(BaseModel):
    field_id: str
    score: float = 0.0
    mean: float | None = None
    sd: float | None = None
    skew: float | None = None
    kurt: float | None = None
    n: int = 0


class DiagnosisSignal(BaseModel):
    id: str
    tick: int
    level: str = "yellow"
    score: float = 0.0
    z: float = 0.0
    top_fields: list[DiagnosisContributor] = Field(default_factory=list)
    evidence: str = ""
    reason: str = ""
    origins: list[str] = Field(default_factory=list)
    created_at: str = ""


class DiagnosisSnapshot(BaseModel):
    signals: list[DiagnosisSignal] = Field(default_factory=list)
    events: list[DiagnosisSignal] = Field(default_factory=list)
    current: dict = Field(default_factory=dict)
    evidence: str = "Rolling z-score over expanding per-channel mean/sd. No raw rows."


class SimulationRunSummary(BaseModel):
    id: str
    started_at: str
    ended_at: str
    tick: int = 0
    finished: bool = False
    sources: list[dict] = Field(default_factory=list)
    alarm_count: int = 0
    decision_count: int = 0


class SimulationRunDetail(SimulationRunSummary):
    alarms: list[DiagnosisSignal] = Field(default_factory=list)
    decisions: list[DecisionEntry] = Field(default_factory=list)


class FieldCard(BaseModel):
    field_id: str
    sparkline: list[float] = Field(default_factory=list, max_length=SPARKLINE_POINTS)
    status: Chip
    contribution: float = 0.0
    evidence: str = ""
    source_file: str = ""
    source_id: str = ""


class MonitorSnapshot(BaseModel):
    calibration_id: str | None = None
    dataset_id: str
    tick: int
    t2_series: list[float] = Field(default_factory=list, max_length=60)
    control_limit: float = 0.0
    live_boundary: int = 0
    fields: list[FieldCard] = Field(default_factory=list, max_length=80)
    demo_fields: list[FieldCard] = Field(default_factory=list, max_length=80)
    demo_tick: int = 0
    exclusion_list: list[str] = Field(default_factory=list, max_length=20)
    latest_event_id: str | None = None
    demo_data_uri: str = ""
    playing: bool = False
    ticks_per_second: float = 2.0
    finished: bool = False
    evidence: str = "Monitor snapshot is aggregated windows, not raw row dumps."


class StreamResetResponse(BaseModel):
    snapshot: MonitorSnapshot
    archived_run_id: str | None = None


class ChatMessageBody(BaseModel):
    id: str
    role: str
    parts: list[Any] = Field(default_factory=list)


class ChatSaveRequest(BaseModel):
    messages: list[ChatMessageBody]


class ChatCreateRequest(BaseModel):
    title: str = "New chat"


class ChatSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class ChatDetail(ChatSummary):
    messages: list[Any] = Field(default_factory=list)
