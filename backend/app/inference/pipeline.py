from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.inference.v5_agnostic import V5AgnosticDetector, V5TickVerdict
from app.inference.zscore import (
    LEVEL_NAMES,
    ChannelZ,
    TickVerdict,
    ZScoreDetector,
)

TOP_CONTRIBUTORS = 5
SNAPSHOT_FIELDS = 20


@dataclass
class FieldMoment:
    """One channel as the API exposes it. `score` is this tick's |z| (z-score model)."""

    field_id: str
    n: int
    mean: float
    sd: float
    skew: float
    kurt: float
    score: float


@dataclass
class DiagnosisSignal:
    tick: int
    level: str
    score: float
    z: float
    top_fields: list[dict]
    evidence: str
    """Human-readable detector origin, e.g. `z-score k=6` or `v5 agnostic (moment)`."""
    reason: str = ""
    """Machine tags that produced the plant level, e.g. `zscore`, `moment`."""
    origins: list[str] = field(default_factory=list)


@dataclass
class StatisticalEngine:
    """Live alarm plane: v6 rolling z-score OR v5 moment/freeze/amplitude.

    Either model can open yellow/red. Plant level is the max of the two on each
    tick. A diagnosis row is emitted when that combined level rises (0→yellow,
    0→red, or yellow→red), so v5 adds alarms on top of z-score without replacing it.
    """

    zscore: ZScoreDetector = field(default_factory=ZScoreDetector)
    v5: V5AgnosticDetector = field(default_factory=V5AgnosticDetector)
    last_tick: int = 0
    latest_moments: list[FieldMoment] = field(default_factory=list)
    latest_z: float = 0.0
    latest_score: float = 0.0
    latest_hot: int = 0
    latest_level: int = 0
    latest_models: list[str] = field(default_factory=list)
    latest_v5_hits: list = field(default_factory=list)
    latest_v5_reason: str = ""
    _prev_combined: int = 0

    # Back-compat alias used by older call sites / snapshots.
    @property
    def detector(self) -> ZScoreDetector:
        return self.zscore

    def reset(self) -> None:
        self.zscore.reset()
        self.v5.reset()
        self.last_tick = 0
        self.latest_moments = []
        self.latest_z = 0.0
        self.latest_score = 0.0
        self.latest_hot = 0
        self.latest_level = 0
        self.latest_models = []
        self.latest_v5_hits = []
        self.latest_v5_reason = ""
        self._prev_combined = 0

    @property
    def calibrated(self) -> bool:
        return self.zscore.calibrated or self.v5.calibrated

    def field_ids(self) -> list[str]:
        return sorted(set(self.zscore.field_ids()) | set(self.v5.field_ids()))

    def current_level(self) -> str:
        return LEVEL_NAMES[self.latest_level]

    def drop_fields(self, field_ids: list[str]) -> None:
        self.zscore.drop(field_ids)
        self.v5.drop(field_ids)

    def hot_field_ids(self, limit: int = TOP_CONTRIBUTORS) -> set[str]:
        """Channels that carried this tick's alert across either model."""
        ids: list[str] = []
        if self.latest_level > 0:
            gate = self.zscore.red_z if self.latest_level == 2 else self.zscore.yellow_z
            if self.zscore.level >= self.latest_level:
                ids.extend(
                    row.field_id for row in self.latest_moments if row.score >= gate
                )
            if self.v5.level >= self.latest_level:
                ids.extend(hit.field_id for hit in self.latest_v5_hits)
        if not ids and self.latest_moments:
            ids = [self.latest_moments[0].field_id]
        # preserve order, unique
        seen: set[str] = set()
        ordered: list[str] = []
        for field_id in ids:
            if field_id not in seen:
                seen.add(field_id)
                ordered.append(field_id)
        return set(ordered[:limit])

    def update(self, values: dict[str, float], tick: int) -> DiagnosisSignal | None:
        if not values:
            return None
        self.last_tick = tick
        z_verdict = self.zscore.step(values)
        v5_verdict = self.v5.step(values)

        self.latest_moments = [_as_moment(row) for row in z_verdict.channels]
        self.latest_z = _finite_or_zero(z_verdict.z_max)
        self.latest_score = float(z_verdict.streak_yellow)
        self.latest_hot = z_verdict.n_hot
        self.latest_v5_hits = list(v5_verdict.hits)
        self.latest_v5_reason = v5_verdict.reason

        combined = max(z_verdict.level, v5_verdict.level)
        models: list[str] = []
        if z_verdict.level == combined and combined > 0:
            models.append("zscore")
        if v5_verdict.level == combined and combined > 0:
            models.append(v5_verdict.reason or "v5")
        self.latest_level = combined
        self.latest_models = models

        # Emit when plant color rises, or when a model newly opens at the plant
        # color (v5 can add alarms z-score missed). Do not re-fire when a weaker
        # model opens underneath an already-red plant.
        z_opens = (
            z_verdict.rising
            and z_verdict.level > 0
            and z_verdict.level == combined
        )
        v5_opens = (
            v5_verdict.rising
            and v5_verdict.level > 0
            and v5_verdict.level == combined
        )
        level_rising = combined > self._prev_combined
        self._prev_combined = combined
        if combined == 0 or not (level_rising or z_opens or v5_opens):
            return None
        return self._signal(z_verdict, v5_verdict, combined, models, tick)

    def _signal(
        self,
        z_verdict: TickVerdict,
        v5_verdict: V5TickVerdict,
        combined: int,
        models: list[str],
        tick: int,
    ) -> DiagnosisSignal:
        label = LEVEL_NAMES[combined]
        top_fields = self._top_fields(z_verdict, v5_verdict, combined)
        names = ", ".join(row["field_id"] for row in top_fields[:3]) or "none"
        reason, origins = self._reason_label(models, v5_verdict)

        parts: list[str] = []
        if "zscore" in origins:
            gate = self.zscore.red_z if z_verdict.level == 2 else self.zscore.yellow_z
            streak = z_verdict.streak_red if z_verdict.level == 2 else z_verdict.streak_yellow
            parts.append(
                f"zscore k={self.zscore.k} streak={streak} |z|>={gate:g} "
                f"(max|z|={z_verdict.z_max:.2f})"
            )
        if any(o != "zscore" for o in origins):
            v5_name = v5_verdict.reason or "v5"
            if v5_name == "moment":
                parts.append(f"v5 moment z={v5_verdict.moment_z:.2f}")
            elif v5_name == "freeze":
                parts.append(f"v5 freeze extra={v5_verdict.freeze_extra:.0f}")
            elif v5_name == "amp":
                parts.append(f"v5 amp q90={v5_verdict.amp_q90:.2f}")
            else:
                parts.append(f"v5 {v5_name}")

        evidence = (
            f"{label} at tick {tick} via {reason}: " + "; ".join(parts) + f"; top {names}"
        )
        score = float(
            (
                z_verdict.streak_red
                if z_verdict.level == 2
                else z_verdict.streak_yellow
            )
            if "zscore" in origins
            else max(v5_verdict.moment_z, v5_verdict.freeze_extra, v5_verdict.amp_q90)
        )
        z_val = (
            _finite_or_zero(z_verdict.z_max)
            if "zscore" in origins
            else _finite_or_zero(
                v5_verdict.moment_z
                if (v5_verdict.reason or "") == "moment"
                else v5_verdict.amp_q90
                if (v5_verdict.reason or "") == "amp"
                else v5_verdict.freeze_extra
            )
        )
        return DiagnosisSignal(
            tick=tick,
            level=label,
            score=score,
            z=round(z_val, 3),
            top_fields=top_fields,
            evidence=evidence,
            reason=reason,
            origins=origins,
        )

    def _reason_label(
        self,
        models: list[str],
        v5_verdict: V5TickVerdict,
    ) -> tuple[str, list[str]]:
        origins: list[str] = []
        labels: list[str] = []
        if "zscore" in models:
            origins.append("zscore")
            labels.append(f"z-score k={self.zscore.k}")
        v5_parts = [m for m in models if m != "zscore"]
        if v5_parts:
            channel = v5_verdict.reason if v5_verdict.reason in {"moment", "freeze", "amp"} else (
                v5_parts[0] if v5_parts[0] in {"moment", "freeze", "amp"} else "v5"
            )
            origins.append(channel if channel != "v5" else "v5")
            labels.append(
                f"v5 agnostic ({channel})" if channel != "v5" else "v5 agnostic"
            )
        if not labels:
            return "unknown", []
        return " + ".join(labels), origins

    def _top_fields(
        self,
        z_verdict: TickVerdict,
        v5_verdict: V5TickVerdict,
        combined: int,
    ) -> list[dict]:
        rows: list[dict] = []
        if z_verdict.level == combined and combined > 0:
            gate = self.zscore.red_z if combined == 2 else self.zscore.yellow_z
            hot = z_verdict.hot_channels(gate)[:TOP_CONTRIBUTORS]
            if not hot:
                hot = z_verdict.channels[:TOP_CONTRIBUTORS]
            for row in hot:
                rows.append(
                    {
                        "field_id": row.field_id,
                        "score": _round(row.abs_z),
                        "mean": _round(row.mean),
                        "sd": _round(row.sd),
                        "skew": _round(row.skew),
                        "kurt": _round(row.kurt),
                        "n": row.n,
                        "model": "zscore",
                    }
                )
        if v5_verdict.level == combined and combined > 0:
            for hit in v5_verdict.hits[:TOP_CONTRIBUTORS]:
                if any(r["field_id"] == hit.field_id for r in rows):
                    continue
                rows.append(
                    {
                        "field_id": hit.field_id,
                        "score": _round(hit.score),
                        "mean": _round(hit.mean),
                        "sd": _round(hit.sd),
                        "skew": _round(hit.skew),
                        "kurt": _round(hit.kurt),
                        "n": hit.n,
                        "model": hit.reason or "v5",
                    }
                )
        return rows[:TOP_CONTRIBUTORS]

    def current_snapshot(self) -> dict:
        z = self.zscore
        v5 = self.v5
        return {
            "tick": self.last_tick,
            "n": z.n,
            "score": self.latest_score,
            "z": round(self.latest_z, 3),
            "calibrated": self.calibrated,
            "level": LEVEL_NAMES[self.latest_level],
            "k": z.k,
            "z_yellow": z.yellow_z,
            "z_red": z.red_z,
            "burn_in": z.burn_in,
            "streak_yellow": z.streak_yellow,
            "streak_red": z.streak_red,
            "n_hot": self.latest_hot,
            "models": list(self.latest_models),
            "v5_level": LEVEL_NAMES[v5.level],
            "v5_reason": self.latest_v5_reason,
            "zscore_level": LEVEL_NAMES[z.level],
            "fields": [
                {
                    "field_id": row.field_id,
                    "n": row.n,
                    "mean": _round(row.mean),
                    "sd": _round(row.sd),
                    "skew": _round(row.skew),
                    "kurt": _round(row.kurt),
                    "score": _round(row.score),
                }
                for row in self.latest_moments[:SNAPSHOT_FIELDS]
            ],
        }


def _as_moment(row: ChannelZ) -> FieldMoment:
    return FieldMoment(
        field_id=row.field_id,
        n=row.n,
        mean=row.mean,
        sd=row.sd,
        skew=row.skew,
        kurt=row.kurt,
        score=_finite_or_zero(row.abs_z),
    )


def _finite_or_zero(value: float) -> float:
    return float(value) if math.isfinite(value) else 0.0


def _round(value: float) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), 4)
