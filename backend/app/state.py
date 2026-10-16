from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from app.config import (
    DATA_DIR,
    DEFAULT_TICKS_PER_SECOND,
    MAX_TICKS_PER_SECOND,
    MIN_TICKS_PER_SECOND,
    default_dataset,
    demo_data_path,
)
from app.inference.pipeline import StatisticalEngine
from app.ingestion.disk_replay import DiskReplaySource, preview_headers
from app.ingestion.files import dataframe_from_api, materialize_csv, write_csv
from app.models.schemas import (
    Chip,
    ConfigUpdate,
    DataSource,
    DataSourceCreate,
    DataSourceUpdate,
    DecisionAppend,
    DecisionEntry,
    FieldCard,
    MonitorSnapshot,
    RuntimeConfig,
)
from app.storage.artifact_store import ArtifactStore


@dataclass
class AppState:
    replays: list[DiskReplaySource] = field(default_factory=list)
    playing: bool = False
    ticks_per_second: float = DEFAULT_TICKS_PER_SECOND
    store: ArtifactStore = field(default_factory=ArtifactStore)
    dataset_id: str = field(default_factory=default_dataset)
    no_egress: bool = False
    engine: StatisticalEngine = field(default_factory=StatisticalEngine)
    last_signal_id: str | None = None
    signal_count: int = 0
    run_started_at: str = ""
    _monitor_key: tuple | None = None
    _monitor_snap: MonitorSnapshot | None = None

    @property
    def tick_seconds(self) -> float:
        rate = max(self.ticks_per_second, MIN_TICKS_PER_SECOND)
        return 1.0 / rate

    def set_ticks_per_second(self, rate: float) -> float:
        value = float(rate)
        if not (value == value):  # NaN
            raise ValueError("ticks_per_second must be a number")
        self.ticks_per_second = max(MIN_TICKS_PER_SECOND, min(MAX_TICKS_PER_SECOND, value))
        self._monitor_key = None
        return self.ticks_per_second

    @property
    def source(self) -> DiskReplaySource | None:
        return self.replays[0] if self.replays else None

    def boot(self) -> None:
        self.store.seed_data_sources()
        self._purge_generator_sources()
        path = demo_data_path()
        if path is not None:
            try:
                self.dataset_id = self._ensure_disk_source(path)
            except Exception:
                self.dataset_id = "demo_csv"
        else:
            ids = self._source_ids()
            self.dataset_id = ids[0] if ids else ""
        self.playing = False
        self._restore_simulation()
        saved = self.store.get_simulation_state()
        self.run_started_at = str(saved.get("run_started_at") or "")
        if not self.run_started_at:
            self.run_started_at = datetime.now(timezone.utc).isoformat()
            self.store.set_run_started_at(self.run_started_at)
        rows = self.store.list_diagnosis(40)
        self.signal_count = len(rows)
        self.last_signal_id = str(rows[0]["id"]) if rows else None

    def preview_source(self, raw_path: str) -> dict:
        path = Path(raw_path.strip()).expanduser()
        csv_path = materialize_csv(path, DATA_DIR / "sources" / f"_preview_{path.stem}.csv")
        return preview_headers(csv_path)

    def _close_replays(self) -> None:
        for replay in self.replays:
            try:
                replay.close()
            except Exception:
                pass
        self.replays = []

    def _configured_specs(self) -> list[dict]:
        """Sources that participate in the live tick loop.

        A source must declare at least one y-column (a telemetry channel). An
        x-axis alone is not enough — otherwise a huge CSV like te_process with
        only `faultNumber` selected would keep the runner going after shorter
        telemetry CSVs have already ended.
        """
        out: list[dict] = []
        for row in self.store.list_data_sources():
            origin = row.get("origin") or "file"
            if origin not in ("api", "file"):
                continue
            y_columns = [col for col in (row.get("y_columns") or []) if col]
            if not y_columns:
                continue
            try:
                self._csv_path(row)
            except ValueError:
                continue
            out.append(row)
        return out

    def _history_map(self) -> dict[str, dict]:
        return {row["source_id"]: row for row in self.store.list_simulation_sources()}

    def _make_replay(self, spec: dict, history: dict | None) -> DiskReplaySource | None:
        try:
            path = materialize_csv(
                self._csv_path(spec),
                DATA_DIR / "sources" / f"{spec['id']}.csv",
            )
            replay = DiskReplaySource(path, source_id=spec["id"])
            y_cols = spec.get("y_columns") or []
            origin = spec.get("origin") or "file"
            replay.open(
                y_cols=None if origin == "api" and not y_cols else list(y_cols),
                x_column=str(spec.get("x_column") or ""),
            )
            if history:
                replay.restore(
                    int(history.get("file_offset") or 0),
                    int(history.get("tick") or 0),
                    history.get("sparklines") or {},
                    exhausted=bool(history.get("exhausted")),
                )
            return replay
        except Exception:
            return None

    def _open_replays(self, *, resume: bool = True) -> None:
        history = self._history_map() if resume else {}
        self._close_replays()
        opened: list[DiskReplaySource] = []
        for spec in self._configured_specs():
            replay = self._make_replay(spec, history.get(spec["id"]) if resume else None)
            if replay is not None:
                opened.append(replay)
        self.replays = opened
        if opened:
            self.dataset_id = opened[0].source_id or self.dataset_id

    def _attach_replay(self, spec: dict) -> None:
        if any(replay.source_id == spec["id"] for replay in self.replays):
            return
        replay = self._make_replay(spec, None)
        if replay is None:
            return
        self.replays.append(replay)
        if not self.dataset_id:
            self.dataset_id = replay.source_id

    def _sources_snapshot(self) -> list[dict]:
        out: list[dict] = []
        for spec in self._configured_specs():
            out.append(
                {
                    "id": spec.get("id"),
                    "name": spec.get("name"),
                    "file_path": spec.get("file_path") or spec.get("live_path") or "",
                    "x_column": spec.get("x_column") or "",
                    "y_columns": list(spec.get("y_columns") or []),
                }
            )
        return out

    def _persist_simulation(self) -> None:
        tick = self.replays[0].tick if self.replays else 0
        try:
            self.store.save_simulation(
                self.playing,
                tick,
                [],
                [replay.progress() for replay in self.replays],
                run_started_at=self.run_started_at or None,
            )
        except Exception:
            return

    def _restore_simulation(self) -> None:
        saved = self.store.get_simulation_state()
        self._open_replays(resume=True)
        want_play = bool(saved.get("playing"))
        if self.finished():
            self.playing = False
        else:
            self.playing = bool(want_play and self.replays)
        self._persist_simulation()

    def finished(self) -> bool:
        """Every open telemetry replay has reached end of file."""
        active = [replay for replay in self.replays if replay.numeric_cols]
        return bool(active) and all(replay.exhausted for replay in active)

    def _rewind_all(self, *, clear_signals: bool = True) -> None:
        if not self.replays:
            self._open_replays(resume=False)
        else:
            for replay in self.replays:
                replay.reset_progress()
        self.engine.reset()
        if clear_signals:
            self.store.clear_diagnosis()
        self.last_signal_id = None
        self.signal_count = 0

    def _reset_detectors(self, *, clear_signals: bool = True) -> None:
        """Drop plant calibration when the source set changes.

        v5 burn-in (mu/sig) is plant-wide. Keeping it after a CSV swap makes the
        new file look absurdly hot from tick 0 (moment z in the thousands).
        """
        self.engine.reset()
        if clear_signals:
            self.store.clear_diagnosis()
            self.last_signal_id = None
            self.signal_count = 0
        else:
            self.signal_count = len(self.store.list_diagnosis(40))
            if self.signal_count == 0:
                self.last_signal_id = None
        self._monitor_key = None

    def set_playing(self, playing: bool) -> MonitorSnapshot:
        if playing:
            if not self.replays:
                self._open_replays(resume=True)
            # Drop any leftover x-axis-only runners from older sessions.
            self.replays = [replay for replay in self.replays if replay.numeric_cols]
            was_finished = self.finished()
            for spec in self._configured_specs():
                self._attach_replay(spec)
            self.replays = [replay for replay in self.replays if replay.numeric_cols]
            if not self.replays:
                self.playing = False
            else:
                if was_finished:
                    # EOF is a stop, not a lock — Play rewinds and starts again.
                    self._rewind_all()
                self.playing = True
        else:
            self.playing = False
        self._monitor_key = None
        self._persist_simulation()
        return self.monitor()

    def reset_simulation(self) -> tuple[MonitorSnapshot, str | None]:
        tick = self.replays[0].tick if self.replays else 0
        archived_run_id = self.store.archive_current_run(
            tick=tick,
            finished=self.finished(),
            sources=self._sources_snapshot(),
            run_started_at=self.run_started_at,
        )
        self.playing = False
        self._rewind_all(clear_signals=False)
        self.run_started_at = datetime.now(timezone.utc).isoformat()
        self.store.set_run_started_at(self.run_started_at)
        self._monitor_key = None
        self._persist_simulation()
        return self.monitor(), archived_run_id

    def _ensure_disk_source(self, path: Path) -> str:
        resolved = str(path.expanduser().resolve())
        want = path.expanduser().resolve()
        for row in self.store.list_data_sources():
            file_path = row.get("file_path") or row.get("live_path") or ""
            if not file_path:
                continue
            try:
                if Path(file_path).expanduser().resolve() == want:
                    return row["id"]
            except OSError:
                if file_path == resolved:
                    return row["id"]
        source_id = "demo_csv" if "demo_csv" not in set(self._source_ids()) else self._unique_source_id(path.stem)
        self.store.create_data_source(
            {
                "id": source_id,
                "name": path.stem or source_id,
                "kind": "process",
                "description": f"Disk replay {resolved}",
                "generator": "",
                "origin": "file",
                "file_path": resolved,
                "train_path": resolved,
                "live_path": resolved,
            }
        )
        return source_id

    def _purge_generator_sources(self) -> None:
        for row in self.store.list_data_sources():
            origin = row.get("origin") or "generator"
            if origin == "generator":
                self.store.delete_data_source(row["id"])

    def _source_ids(self) -> list[str]:
        return [s["id"] for s in self.store.list_data_sources()]

    def _as_data_source(self, row: dict) -> DataSource:
        payload = dict(row)
        origin = payload.get("origin") or "file"
        payload["origin"] = origin if origin in ("api", "file") else "file"
        payload["generator"] = payload.get("generator") or ""
        payload["x_column"] = payload.get("x_column") or ""
        payload["y_columns"] = list(payload.get("y_columns") or [])
        return DataSource(**payload, active=row["id"] == self.dataset_id)

    def list_data_sources(self) -> list[DataSource]:
        return [self._as_data_source(row) for row in self.store.list_data_sources()]

    def _unique_source_id(self, name: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40] or "source"
        ids = set(self._source_ids())
        if base not in ids:
            return base
        i = 2
        while f"{base}_{i}" in ids:
            i += 1
        return f"{base}_{i}"

    def _csv_path(self, spec: dict) -> Path:
        raw = spec.get("file_path") or spec.get("live_path") or spec.get("train_path") or ""
        path = Path(str(raw)).expanduser()
        if not path.is_file():
            raise ValueError(f"file not found: {path}")
        return path

    def _switch_stream(self, source_id: str) -> None:
        spec = self.store.get_data_source(source_id)
        if spec is None:
            raise ValueError(f"unknown data source {source_id}")
        self.dataset_id = source_id
        if self.playing or self.replays:
            self._attach_replay(spec)

    def _persist_table(self, source_id: str, frame) -> str:
        dest = DATA_DIR / "sources" / f"{source_id}.csv"
        write_csv(frame, dest)
        return str(dest)

    def add_file_source(
        self,
        raw_path: str,
        x_column: str = "",
        y_columns: list[str] | None = None,
    ) -> DataSource:
        path = Path(raw_path.strip()).expanduser()
        csv_path = materialize_csv(path, DATA_DIR / "sources" / f"{path.stem}.csv")
        source_id = self._unique_source_id(path.stem or "file")
        resolved = str(csv_path)
        row = self.store.create_data_source(
            {
                "id": source_id,
                "name": path.stem or source_id,
                "kind": "other",
                "description": f"Disk replay {resolved}",
                "generator": "",
                "origin": "file",
                "api_url": "",
                "file_path": resolved,
                "train_path": resolved,
                "live_path": resolved,
                "x_column": x_column.strip(),
                "y_columns": list(y_columns or []),
            }
        )
        if self.playing or self.replays:
            self._attach_replay(row)
        self._reset_detectors(clear_signals=True)
        self._persist_simulation()
        return self._as_data_source(row)

    def add_api_source(self, api_url: str) -> DataSource:
        url = api_url.strip()
        if not url:
            raise ValueError("API URL is required")
        host = urlparse(url).hostname or "api"
        source_id = self._unique_source_id(host)
        frame = dataframe_from_api(url)
        path = self._persist_table(source_id, frame)
        row = self.store.create_data_source(
            {
                "id": source_id,
                "name": host,
                "kind": "other",
                "description": f"API {url}",
                "generator": "",
                "origin": "api",
                "api_url": url,
                "file_path": path,
                "train_path": path,
                "live_path": path,
            }
        )
        if self.playing or self.replays:
            self._attach_replay(row)
        self._reset_detectors(clear_signals=True)
        self._persist_simulation()
        return self._as_data_source(row)

    def add_data_source(self, body: DataSourceCreate) -> DataSource:
        if body.origin == "api" or body.api_url.strip():
            return self.add_api_source(body.api_url)
        return self.add_file_source(body.file_path, body.x_column, body.y_columns)

    def patch_data_source(self, source_id: str, body: DataSourceUpdate) -> DataSource:
        current = self.store.get_data_source(source_id)
        if current is None:
            raise KeyError(source_id)
        payload = body.model_dump(exclude_unset=True)
        row = self.store.update_data_source(source_id, payload)
        if row is None:
            raise KeyError(source_id)
        # Column / path edits change what feeds the plant detectors.
        if any(key in payload for key in ("y_columns", "x_column", "file_path", "live_path")):
            self._reset_detectors(clear_signals=True)
            self.replays = [r for r in self.replays if r.source_id != source_id]
            if self.playing or self.replays:
                self._attach_replay(row)
        self._persist_simulation()
        return self._as_data_source(row)

    def remove_data_source(self, source_id: str) -> None:
        self.remove_data_sources([source_id])

    def remove_fields(self, items: list[dict]) -> None:
        grouped: dict[str, set[str]] = {}
        for item in items:
            source_id = str(item.get("source_id") or "").strip()
            field_id = str(item.get("field_id") or "").strip()
            if source_id and field_id:
                grouped.setdefault(source_id, set()).add(field_id)
        if not grouped:
            return
        for source_id, fields in grouped.items():
            spec = self.store.get_data_source(source_id)
            if spec is None:
                continue
            current = list(spec.get("y_columns") or [])
            if not current:
                for replay in self.replays:
                    if replay.source_id == source_id:
                        current = list(replay.numeric_cols)
                        break
            remaining = [col for col in current if col not in fields]
            self.store.update_data_source(source_id, {"y_columns": remaining})
            self.engine.drop_fields([f"{source_id}::{col}" for col in fields])
            for replay in self.replays:
                if replay.source_id == source_id:
                    replay.drop_columns(list(fields))
        self._reset_detectors(clear_signals=True)
        self._persist_simulation()

    def remove_data_sources(self, source_ids: list[str]) -> None:
        wanted = [sid for sid in source_ids if sid]
        if not wanted:
            return
        missing = [sid for sid in wanted if self.store.get_data_source(sid) is None]
        if missing:
            raise KeyError(missing[0])
        drop = set(wanted)
        drop_keys = [
            field_id
            for field_id in self.engine.field_ids()
            if any(field_id.startswith(f"{source_id}::") for source_id in drop)
        ]
        self.engine.drop_fields(drop_keys)
        for replay in [item for item in self.replays if item.source_id in drop]:
            try:
                replay.close()
            except Exception:
                pass
        self.replays = [replay for replay in self.replays if replay.source_id not in drop]
        for source_id in wanted:
            if not self.store.delete_data_source(source_id):
                raise KeyError(source_id)
        self.store.clear_diagnosis_for_sources(drop)
        self._reset_detectors(clear_signals=False)
        ids = self._source_ids()
        if self.dataset_id in drop:
            self.dataset_id = ids[0] if ids else ""
        self._persist_simulation()
        self.signal_count = len(self.store.list_diagnosis(40))
        if self.signal_count == 0:
            self.last_signal_id = None

    def runtime_config(self) -> RuntimeConfig:
        return RuntimeConfig(
            dataset_id=self.dataset_id,
            datasets=self._source_ids(),
            calibration_id=None,
            baseline_established=self.engine.calibrated,
            no_egress=self.no_egress,
            demo_data_uri=str(demo_data_path() or ""),
            playing=self.playing,
            ticks_per_second=self.ticks_per_second,
            finished=self.finished(),
        )

    def update_config(self, body: ConfigUpdate) -> RuntimeConfig:
        if body.no_egress is not None:
            self.no_egress = body.no_egress
        if body.ticks_per_second is not None:
            self.set_ticks_per_second(body.ticks_per_second)
        if body.dataset_id and body.dataset_id != self.dataset_id:
            if body.dataset_id not in self._source_ids():
                raise ValueError(f"unknown data source {body.dataset_id}")
            self._switch_stream(body.dataset_id)
        return self.runtime_config()

    def tick_live(self) -> None:
        if not self.playing or not self.replays:
            return
        values: dict[str, float] = {}
        tick = 0
        advanced = False
        for replay in self.replays:
            if not replay.numeric_cols:
                continue
            before = replay.tick
            replay.emit()
            if replay.tick > before:
                advanced = True
            tick = max(tick, replay.tick)
            # Only live (still-advancing or not-yet-exhausted) channels feed the
            # detector. Stale last values from an exhausted CSV must not keep
            # pumping the engine after the file has ended.
            if replay.exhausted and replay.tick == before:
                continue
            for col, value in replay.latest_values().items():
                values[f"{replay.source_id}::{col}"] = value
        if not advanced:
            for replay in self.replays:
                if replay.numeric_cols:
                    replay.exhausted = True
            self.playing = False
            self._monitor_key = None
            self._persist_simulation()
            return
        if not values:
            self._persist_simulation()
            return
        signal = self.engine.update(values, tick)
        if signal is not None:
            row = self.store.append_diagnosis(
                {
                    "tick": signal.tick,
                    "level": signal.level,
                    "score": signal.score,
                    "z": signal.z,
                    "top_fields": signal.top_fields,
                    "evidence": signal.evidence,
                    "reason": signal.reason,
                    "origins": signal.origins,
                }
            )
            self.last_signal_id = str(row.get("id") or "")
            self.signal_count += 1
            try:
                self.store.append(
                    DecisionAppend(
                        type="flag",
                        payload={
                            "id": row.get("id"),
                            "level": signal.level,
                            "tick": signal.tick,
                            "z": signal.z,
                        },
                        evidence_ref=signal.evidence,
                    )
                )
            except Exception:
                pass
        self._persist_simulation()

    def monitor(self) -> MonitorSnapshot:
        telemetry = [replay for replay in self.replays if replay.numeric_cols]
        tick = max((replay.tick for replay in telemetry), default=0)
        key = (
            self.dataset_id,
            tick,
            self.playing,
            self.finished(),
            round(self.ticks_per_second, 3),
            self.last_signal_id,
            round(self.engine.latest_z, 3),
            tuple(replay.source_id for replay in self.replays),
        )
        if self._monitor_snap is not None and self._monitor_key == key:
            return self._monitor_snap
        snap = self._build_monitor(tick)
        self._monitor_key = key
        self._monitor_snap = snap
        return snap

    def _build_monitor(self, tick: int) -> MonitorSnapshot:
        level = self.engine.current_level()
        top_ids = self.engine.hot_field_ids()
        scores = {row.field_id: row.score for row in self.engine.latest_moments}
        cards: list[FieldCard] = []
        traces: list[tuple[str, list[float], str, str]] = []
        for replay in self.replays:
            traces.extend(replay.cards())
        for col, spark, file_name, source_id in traces:
            key = f"{source_id}::{col}"
            status: Chip = "normal"
            evidence = "within its own expanding mean/sd"
            contrib = float(scores.get(key, 0.0))
            if level != "normal" and key in top_ids:
                status = "red" if level == "red" else "yellow"
                evidence = (
                    f"|z|={contrib:.2f} vs expanding mean/sd; "
                    f"sample max |z|={self.engine.latest_z:.2f}"
                )
            cards.append(
                FieldCard(
                    field_id=col,
                    sparkline=spark,
                    status=status,
                    contribution=round(contrib, 3),
                    evidence=evidence,
                    source_file=file_name,
                    source_id=source_id,
                )
            )
        cards.sort(
            key=lambda c: (
                c.source_file,
                int("".join(ch for ch in c.field_id if ch.isdigit()) or "999999"),
                c.field_id,
            )
        )
        return MonitorSnapshot(
            calibration_id=None,
            dataset_id=self.dataset_id,
            tick=tick,
            t2_series=[],
            control_limit=0.0,
            live_boundary=0,
            fields=cards[:80],
            demo_fields=[],
            demo_tick=0,
            exclusion_list=[],
            latest_event_id=self.last_signal_id,
            demo_data_uri=str(demo_data_path() or ""),
            playing=self.playing,
            ticks_per_second=self.ticks_per_second,
            finished=self.finished(),
        )

    def diagnosis_snapshot(self) -> dict:
        signals = self.store.list_diagnosis(40)
        active = {replay.source_id for replay in self.replays if replay.numeric_cols}
        if active:
            # Drop alarms that belong to sources no longer in the live tick loop,
            # so a previous CSV's yellow/red marks cannot haunt a new file.
            signals = [
                row
                for row in signals
                if self._signal_source_ids(row) & active
            ]
        return {
            "signals": signals,
            "events": signals,
            "current": self.engine.current_snapshot(),
            "evidence": (
                "Two detectors share this alarm log. (1) Rolling z-score k="
                f"{self.engine.detector.k}: yellow after k consecutive samples with some "
                f"channel at |z| >= {self.engine.detector.yellow_z:g}, red at "
                f"|z| >= {self.engine.detector.red_z:g}. (2) v5 agnostic: expanding-moment "
                "RMS, freeze streaks on xmeas_*, and amplitude envelope — gates ease from "
                f"burn-in ({self.engine.detector.burn_in}) to sample 300. Plant level is the "
                "max of both; either can open an alarm. No raw rows."
            ),
        }

    @staticmethod
    def _signal_source_ids(signal: dict) -> set[str]:
        out: set[str] = set()
        for field in signal.get("top_fields") or []:
            field_id = str(field.get("field_id") or "")
            if "::" in field_id:
                out.add(field_id.split("::", 1)[0])
        return out

    def events_snapshot(self) -> dict:
        return self.diagnosis_snapshot()

    def events_key(self) -> tuple:
        return (self.last_signal_id, self.signal_count, self.engine.last_tick)

    def log(self, body: DecisionAppend) -> DecisionEntry:
        return self.store.append(body)


STATE = AppState()
