from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import date

from app.lab.rates import (
    RateCount,
    accumulate,
    direction_for,
    first_isolate_indices,
    level_for,
    proportion_z,
    window_bounds,
)
from app.lab.table import LabTable

SPARKLINE = 40
CellKey = tuple[int, int, int]


@dataclass
class RateRow:
    ward_code: str
    ward_en: str
    organism: str
    antibiotic: str
    antibiotic_code: str
    n_4w: int
    pct_4w: float | None
    n_year: int
    pct_year: float | None
    z: float | None
    level: str
    direction: str
    sparkline: list[float] = field(default_factory=list)


@dataclass
class AlertEvent:
    tick: int
    as_of: str
    level: str
    z: float
    score: float
    ward_code: str
    organism: str
    antibiotic: str
    antibiotic_code: str
    n_4w: int
    pct_4w: float
    n_year: int
    pct_year: float
    direction: str
    evidence: str

    @property
    def field_id(self) -> str:
        return f"{self.ward_code} · {self.organism} · {self.antibiotic_code}"


@dataclass
class LabMonitor:
    table: LabTable
    cursor: int = -1
    levels: dict[CellKey, str] = field(default_factory=dict)
    sparklines: dict[CellKey, deque[float]] = field(default_factory=dict)
    hot: list[RateRow] = field(default_factory=list)
    rows: list[RateRow] = field(default_factory=list)

    @property
    def as_of(self) -> date | None:
        if self.cursor < 0:
            return None
        return self.table.days[self.cursor]

    @property
    def finished(self) -> bool:
        return self.cursor >= len(self.table.days) - 1 and self.cursor >= 0

    def reset(self) -> None:
        self.cursor = -1
        self.levels.clear()
        self.sparklines.clear()
        self.hot.clear()
        self.rows.clear()

    def step(self) -> list[AlertEvent]:
        if self.cursor + 1 >= len(self.table.days):
            return []
        self.cursor += 1
        return self._evaluate()

    def profile(
        self,
        *,
        ward: str | None = None,
        specimen: str | None = None,
        organism: str | None = None,
        sex: str | None = None,
    ) -> list[RateRow]:
        as_of = self.as_of
        if as_of is None:
            return []
        narrow = specimen not in (None, "", "all") or sex not in (None, "", "all")
        if not narrow:
            rows = self.rows
            if ward not in (None, "", "all"):
                rows = [row for row in rows if row.ward_code == ward]
            if organism not in (None, "", "all"):
                rows = [row for row in rows if row.organism == organism]
            return rows
        four, annual = window_bounds(as_of.toordinal())
        rows = self._rows(
            four,
            annual,
            ward=self.table.name_index(self.table.ward_codes, ward),
            specimen=self.table.name_index(self.table.specimen_names, specimen),
            organism=self.table.name_index(self.table.organism_names, organism),
            sex=self.table.name_index(self.table.sex_names, sex),
            attach_sparkline=specimen in (None, "", "all") and sex in (None, "", "all"),
        )
        return rows

    def _evaluate(self) -> list[AlertEvent]:
        as_of = self.as_of
        assert as_of is not None
        four, annual = window_bounds(as_of.toordinal())
        rows = self._rows(four, annual, record=True)
        alerts: list[AlertEvent] = []
        seen: set[CellKey] = set()
        hot: list[RateRow] = []
        for row in rows:
            key = (
                self.table.ward_codes.index(row.ward_code),
                self.table.organism_names.index(row.organism),
                self.table.drug_codes.index(row.antibiotic_code),
            )
            seen.add(key)
            previous = self.levels.get(key, "normal")
            self.levels[key] = row.level
            if _rose(previous, row.level) and row.z is not None and row.pct_4w is not None and row.pct_year is not None:
                alerts.append(_alert(self.cursor + 1, as_of, row))
            if row.level != "normal":
                hot.append(row)
        for key in list(self.levels):
            if key not in seen:
                self.levels[key] = "normal"
        hot.sort(key=lambda row: abs(row.z or 0.0), reverse=True)
        self.hot = hot
        self.rows = rows
        return alerts

    def _rows(
        self,
        four: tuple[int, int],
        annual: tuple[int, int],
        *,
        ward: int | None = None,
        specimen: int | None = None,
        organism: int | None = None,
        sex: int | None = None,
        record: bool = False,
        attach_sparkline: bool = False,
    ) -> list[RateRow]:
        four_idx = first_isolate_indices(
            self.table,
            four[0],
            four[1],
            specimen=specimen,
            sex=sex,
            organism=organism,
        )
        year_idx = first_isolate_indices(
            self.table,
            annual[0],
            annual[1],
            specimen=specimen,
            sex=sex,
            organism=organism,
        )
        recent = accumulate(self.table, four_idx, ward=ward)
        baseline = accumulate(self.table, year_idx, ward=ward)
        keys = set(recent) | set(baseline)
        rows: list[RateRow] = []
        for key in keys:
            ward_i, organism_i, drug_i = key
            recent_cell = recent.get(key) or RateCount(ward_i, organism_i, drug_i, 0, 0)
            base_cell = baseline.get(key) or RateCount(ward_i, organism_i, drug_i, 0, 0)
            z = proportion_z(recent_cell, base_cell)
            level = level_for(z)
            sparkline: list[float] = []
            if record and recent_cell.observed is not None:
                series = self.sparklines.get(key)
                if series is None:
                    series = deque(maxlen=SPARKLINE)
                    self.sparklines[key] = series
                series.append(recent_cell.observed)
            if record or attach_sparkline:
                series = self.sparklines.get(key)
                sparkline = list(series) if series is not None else []
            rows.append(
                RateRow(
                    ward_code=self.table.ward_codes[ward_i],
                    ward_en=self.table.ward_names[ward_i],
                    organism=self.table.organism_names[organism_i],
                    antibiotic=self.table.drug_names[drug_i],
                    antibiotic_code=self.table.drug_codes[drug_i],
                    n_4w=recent_cell.n,
                    pct_4w=recent_cell.percent,
                    n_year=base_cell.n,
                    pct_year=base_cell.percent,
                    z=None if z is None else round(z, 2),
                    level=level,
                    direction=direction_for(z),
                    sparkline=sparkline,
                )
            )
        rows.sort(key=lambda row: (row.organism, self.table.drug_codes.index(row.antibiotic_code), row.ward_code))
        return rows


def _rank(level: str) -> int:
    return {"normal": 0, "yellow": 1, "red": 2}[level]


def _rose(previous: str, current: str) -> bool:
    return _rank(current) > _rank(previous)


def _alert(tick: int, as_of: date, row: RateRow) -> AlertEvent:
    assert row.z is not None and row.pct_4w is not None and row.pct_year is not None
    movement = "resistance up" if row.direction == "up" else "resistance down"
    evidence = (
        f"{as_of.isoformat()} {row.ward_en} · {row.organism} · {row.antibiotic} ({row.antibiotic_code}): "
        f"four-week {row.pct_4w:.1f}% resistant ({row.n_4w} isolates) vs annual {row.pct_year:.1f}% "
        f"({row.n_year}). z={row.z:.2f}, {movement}."
    )
    return AlertEvent(
        tick=tick,
        as_of=as_of.isoformat(),
        level=row.level,
        z=row.z,
        score=abs(row.z),
        ward_code=row.ward_code,
        organism=row.organism,
        antibiotic=row.antibiotic,
        antibiotic_code=row.antibiotic_code,
        n_4w=row.n_4w,
        pct_4w=row.pct_4w,
        n_year=row.n_year,
        pct_year=row.pct_year,
        direction=row.direction,
        evidence=evidence,
    )
