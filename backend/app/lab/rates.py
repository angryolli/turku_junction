from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.lab.table import LabTable

MIN_ISOLATES = 30
FOUR_WEEK_DAYS = 28
ANNUAL_DAYS = 365
Z_YELLOW = 2.0
Z_RED = 3.0


@dataclass
class RateCount:
    ward: int
    organism: int
    drug: int
    n: int
    resistant: int

    @property
    def percent(self) -> float | None:
        if self.n < MIN_ISOLATES:
            return None
        return round(100.0 * self.resistant / self.n, 1)


def window_bounds(as_of_ordinal: int) -> tuple[tuple[int, int], tuple[int, int]]:
    """Return (four-week, annual) as (exclusive start ordinal, inclusive end ordinal)."""
    four = (as_of_ordinal - FOUR_WEEK_DAYS, as_of_ordinal)
    annual = (as_of_ordinal - FOUR_WEEK_DAYS - ANNUAL_DAYS, as_of_ordinal - FOUR_WEEK_DAYS)
    return four, annual


def proportion_z(recent: RateCount, baseline: RateCount) -> float | None:
    """Signed z of the four-week resistance share against the annual share."""
    if recent.n < MIN_ISOLATES or baseline.n < MIN_ISOLATES:
        return None
    pooled = (recent.resistant + baseline.resistant) / (recent.n + baseline.n)
    variance = pooled * (1.0 - pooled) * (1.0 / recent.n + 1.0 / baseline.n)
    if variance <= 1e-12:
        return 0.0
    return (recent.resistant / recent.n - baseline.resistant / baseline.n) / math.sqrt(variance)


def level_for(z: float | None) -> str:
    if z is None:
        return "normal"
    magnitude = abs(z)
    if magnitude >= Z_RED:
        return "red"
    if magnitude >= Z_YELLOW:
        return "yellow"
    return "normal"


def direction_for(z: float | None) -> str:
    if z is None or z == 0:
        return ""
    return "up" if z > 0 else "down"


def _slice(dates: np.ndarray, lo_exclusive: int, hi_inclusive: int) -> tuple[int, int]:
    left = int(np.searchsorted(dates, lo_exclusive, side="right"))
    right = int(np.searchsorted(dates, hi_inclusive, side="right"))
    return left, right


def first_isolate_indices(
    table: LabTable,
    lo_exclusive: int,
    hi_inclusive: int,
    *,
    specimen: int | None = None,
    sex: int | None = None,
    organism: int | None = None,
) -> np.ndarray:
    """Earliest isolate per patient, organism, and specimen inside the date window."""
    left, right = _slice(table.dates, lo_exclusive, hi_inclusive)
    if right <= left:
        return np.empty(0, dtype=np.int32)
    seen: dict[int, int] = {}
    kept: list[int] = []
    patients = table.patient
    organisms = table.organism
    specimens = table.specimen
    sexes = table.sex
    for i in range(left, right):
        if specimen is not None and int(specimens[i]) != specimen:
            continue
        if sex is not None and int(sexes[i]) != sex:
            continue
        if organism is not None and int(organisms[i]) != organism:
            continue
        key = (int(patients[i]) << 16) | (int(organisms[i]) << 8) | int(specimens[i])
        if key in seen:
            continue
        seen[key] = i
        kept.append(i)
    return np.asarray(kept, dtype=np.int32)


def accumulate(
    table: LabTable,
    indices: np.ndarray,
    *,
    ward: int | None = None,
) -> dict[tuple[int, int, int], RateCount]:
    """Count tested and resistant isolates per ward, organism, and antibiotic."""
    if len(indices) == 0:
        return {}
    if ward is not None:
        indices = indices[table.ward[indices] == ward]
        if len(indices) == 0:
            return {}
    counts: dict[tuple[int, int, int], RateCount] = {}
    results = table.results
    wards = table.ward
    organisms = table.organism
    specimens = table.specimen
    urine = table.urine_specimen
    urine_only = table.urine_only
    n_drugs = results.shape[1]
    for raw in indices:
        i = int(raw)
        specimen = int(specimens[i])
        ward_i = int(wards[i])
        organism_i = int(organisms[i])
        row = results[i]
        for drug in range(n_drugs):
            bit = int(row[drug])
            if bit < 0:
                continue
            if bool(urine_only[drug]) and specimen != urine:
                continue
            key = (ward_i, organism_i, drug)
            cell = counts.get(key)
            if cell is None:
                counts[key] = RateCount(ward_i, organism_i, drug, 1, bit)
            else:
                cell.n += 1
                cell.resistant += bit
    return counts
