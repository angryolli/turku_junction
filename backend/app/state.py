from __future__ import annotations

import threading
from datetime import datetime, timezone

from app.config import DEFAULT_TICKS_PER_SECOND, MAX_TICKS_PER_SECOND, MIN_TICKS_PER_SECOND
from app.lab.monitor import LabMonitor, RateRow
from app.lab.rates import MIN_ISOLATES
from app.lab.table import load_lab
from app.models.schemas import (
    AntibiogramResponse,
    ConfigUpdate,
    DecisionAppend,
    MonitorSnapshot,
    RateCard,
    RuntimeConfig,
    SituationResponse,
    WardCard,
)
from app.storage.artifact_store import ArtifactStore

WINDOW_TEXT = (
    "Four-week rate uses the previous 28 days. "
    "Annual rate uses the 365 days before that window. "
    "Each window keeps the first isolate per patient, organism, and specimen. "
    f"A percentage is published only when at least {MIN_ISOLATES} isolates were tested."
)


def _rate_card(row: RateRow, *, sparkline: bool = False) -> RateCard:
    return RateCard(
        ward_code=row.ward_code,
        ward_en=row.ward_en,
        organism=row.organism,
        antibiotic=row.antibiotic,
        antibiotic_code=row.antibiotic_code,
        n_4w=row.n_4w,
        pct_4w=row.pct_4w,
        n_year=row.n_year,
        pct_year=row.pct_year,
        z=row.z,
        level=row.level,  # type: ignore[arg-type]
        direction=row.direction,
        sparkline=row.sparkline if sparkline else [],
    )


class AppState:
    def __init__(self) -> None:
        self.store = ArtifactStore()
        self.lab = LabMonitor(load_lab())
        self.playing = False
        self.ticks_per_second = DEFAULT_TICKS_PER_SECOND
        self.no_egress = False
        self.run_started_at = ""
        self._lock = threading.Lock()
        self._snap: MonitorSnapshot | None = None

    @property
    def tick(self) -> int:
        return 0 if self.lab.cursor < 0 else self.lab.cursor + 1

    @property
    def tick_seconds(self) -> float:
        rate = max(self.ticks_per_second, MIN_TICKS_PER_SECOND)
        return 1.0 / rate

    def boot(self) -> None:
        saved = self.store.get_simulation_state()
        self.run_started_at = str(saved.get("run_started_at") or "")
        if not self.run_started_at:
            self.run_started_at = datetime.now(timezone.utc).isoformat()
            self.store.set_run_started_at(self.run_started_at)
        self.playing = False
        self._snap = None

    def set_ticks_per_second(self, rate: float) -> float:
        value = float(rate)
        if value != value:
            raise ValueError("ticks_per_second must be a number")
        self.ticks_per_second = max(MIN_TICKS_PER_SECOND, min(MAX_TICKS_PER_SECOND, value))
        self._snap = None
        return self.ticks_per_second

    def set_playing(self, playing: bool) -> None:
        with self._lock:
            if playing and self.lab.finished:
                return
            self.playing = bool(playing)
            self._snap = None

    def tick_live(self) -> None:
        alerts = []
        with self._lock:
            if not self.playing or self.lab.finished:
                return
            alerts = self.lab.step()
            if self.lab.finished:
                self.playing = False
            self._snap = None
        for alert in alerts:
            self.store.append_diagnosis(
                {
                    "id": (
                        f"alt_{alert.tick}_{alert.ward_code}_"
                        f"{''.join(ch for ch in alert.organism if ch.isalnum())[:24]}_"
                        f"{alert.antibiotic_code}"
                    ),
                    "tick": alert.tick,
                    "level": alert.level,
                    "score": alert.score,
                    "z": alert.z,
                    "top_fields": [
                        {
                            "field_id": alert.field_id,
                            "score": alert.score,
                            "n": alert.n_4w,
                            "mean": alert.pct_4w,
                            "sd": alert.pct_year,
                        }
                    ],
                    "evidence": alert.evidence,
                    "reason": "resistance up" if alert.direction == "up" else "resistance down",
                    "origins": ["proportion"],
                }
            )

    def runtime_config(self) -> RuntimeConfig:
        table = self.lab.table
        as_of = self.lab.as_of
        return RuntimeConfig(
            dataset_id="lab",
            datasets=["lab"],
            calibration_id="lab",
            baseline_established=self.tick > 0,
            no_egress=self.no_egress,
            playing=self.playing,
            ticks_per_second=self.ticks_per_second,
            finished=self.lab.finished,
            as_of=None if as_of is None else as_of.isoformat(),
            date_start=table.days[0].isoformat(),
            date_end=table.days[-1].isoformat(),
        )

    def update_config(self, body: ConfigUpdate) -> RuntimeConfig:
        if body.ticks_per_second is not None:
            self.set_ticks_per_second(body.ticks_per_second)
        if body.no_egress is not None:
            self.no_egress = bool(body.no_egress)
        return self.runtime_config()

    def monitor(self) -> MonitorSnapshot:
        with self._lock:
            if self._snap is not None:
                return self._snap
            self._snap = self._build_snapshot()
            return self._snap

    def antibiogram(
        self,
        *,
        ward: str | None = None,
        specimen: str | None = None,
        organism: str | None = None,
        sex: str | None = None,
    ) -> AntibiogramResponse:
        with self._lock:
            as_of = self.lab.as_of
            rows = self.lab.profile(ward=ward, specimen=specimen, organism=organism, sex=sex)
        return AntibiogramResponse(
            as_of=None if as_of is None else as_of.isoformat(),
            rows=[_rate_card(row, sparkline=True) for row in rows],
        )

    def situation(self, ward: str | None = None) -> SituationResponse:
        with self._lock:
            as_of = self.lab.as_of
            wards = self._ward_cards()
            open_alerts = [_rate_card(row) for row in self.lab.hot[:80]]
            published: list[RateCard] = []
            if ward:
                published = [
                    _rate_card(row)
                    for row in self.lab.profile(ward=ward)
                    if row.pct_4w is not None
                ][:400]
        log = self.diagnosis_snapshot()["signals"][:40]
        return SituationResponse(
            as_of=None if as_of is None else as_of.isoformat(),
            tick=self.tick,
            playing=self.playing,
            finished=self.lab.finished,
            window=WINDOW_TEXT,
            min_isolates=MIN_ISOLATES,
            wards=wards,
            open_alerts=open_alerts,
            published_rates=published,
            alert_log=log,
            evidence=WINDOW_TEXT + " No raw culture rows.",
        )

    def diagnosis_snapshot(self) -> dict:
        signals = self.store.list_diagnosis(40)
        as_of = self.lab.as_of
        return {
            "signals": signals,
            "events": signals,
            "current": {
                "tick": self.tick,
                "as_of": None if as_of is None else as_of.isoformat(),
                "level": self._plant_level(),
                "calibrated": self.tick > 0,
            },
            "evidence": WINDOW_TEXT,
        }

    def events_snapshot(self) -> dict:
        return self.diagnosis_snapshot()

    def events_key(self) -> tuple:
        rows = self.store.list_diagnosis(1)
        if not rows:
            return (0, None)
        return (rows[0]["id"], rows[0]["tick"])

    def reset_simulation(self) -> tuple[MonitorSnapshot, str | None]:
        with self._lock:
            tick = self.tick
            finished = self.lab.finished
            self.playing = False
        archived = self.store.archive_current_run(
            tick=tick,
            finished=finished,
            sources=[{"id": "lab", "name": "Synthetic microbiology"}],
            run_started_at=self.run_started_at,
        )
        with self._lock:
            self.lab.reset()
            self.run_started_at = datetime.now(timezone.utc).isoformat()
            self._snap = None
        self.store.set_run_started_at(self.run_started_at)
        return self.monitor(), archived

    def log(self, body: DecisionAppend):
        return self.store.append(body)

    def catalog(self) -> dict:
        table = self.lab.table
        return {
            "wards": [
                {"code": code, "en": name, "type": kind}
                for code, name, kind in zip(table.ward_codes, table.ward_names, table.ward_types, strict=True)
            ],
            "organisms": table.organism_names,
            "specimens": [name for name in table.specimen_names if name != "U"],
            "sexes": [name for name in table.sex_names if name in {"F", "M"}],
            "antibiotics": [
                {"code": code, "name": name, "urine_only": bool(flag)}
                for code, name, flag in zip(table.drug_codes, table.drug_names, table.urine_only, strict=True)
            ],
            "date_start": table.days[0].isoformat(),
            "date_end": table.days[-1].isoformat(),
        }

    def _plant_level(self) -> str:
        rank = {"normal": 0, "yellow": 1, "red": 2}
        level = "normal"
        for row in self.lab.hot:
            if rank[row.level] > rank[level]:
                level = row.level
        return level

    def _ward_cards(self) -> list[WardCard]:
        table = self.lab.table
        status = {code: "normal" for code in table.ward_codes}
        counts = {code: 0 for code in table.ward_codes}
        rank = {"normal": 0, "yellow": 1, "red": 2}
        for row in self.lab.hot:
            counts[row.ward_code] = counts.get(row.ward_code, 0) + 1
            if rank[row.level] > rank[status.get(row.ward_code, "normal")]:
                status[row.ward_code] = row.level
        return [
            WardCard(
                ward_code=code,
                ward_en=name,
                ward_type=kind,
                status=status[code],  # type: ignore[arg-type]
                n_hot=counts[code],
            )
            for code, name, kind in zip(table.ward_codes, table.ward_names, table.ward_types, strict=True)
        ]

    def _build_snapshot(self) -> MonitorSnapshot:
        as_of = self.lab.as_of
        table = self.lab.table
        return MonitorSnapshot(
            dataset_id="lab",
            tick=self.tick,
            as_of=None if as_of is None else as_of.isoformat(),
            date_start=table.days[0].isoformat(),
            date_end=table.days[-1].isoformat(),
            playing=self.playing,
            ticks_per_second=self.ticks_per_second,
            finished=self.lab.finished,
            wards=self._ward_cards(),
            open_alerts=[_rate_card(row, sparkline=True) for row in self.lab.hot[:80]],
            evidence=WINDOW_TEXT,
        )


STATE = AppState()
