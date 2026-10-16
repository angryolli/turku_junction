"""v5 agnostic detector: expanding-moment RMS, freeze streaks, amplitude.

Matches `detect_alarms` / `analyze_run` in data_processing/v5_only_statistical.ipynb.
Three independent scores can raise yellow/red; plant level is the max. Thresholds
ease from burn-in to sample 300 (smoothstep). Streaming form keeps O(channels)
state — last value, freeze streak, a short amplitude window — never the full run.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from app.inference.zscore import LEVEL_NAMES, OnlineMoments

NAN = float("nan")

MIN_T = 8
BURNIN = 20
SENSOR_Q = 0.90
EASE_T1 = 300

YELLOW_Z0, YELLOW_Z1 = 5.0, 2.8
RED_Z0, RED_Z1 = 8.0, 4.8

FREEZE_Q = 0.75
FREEZE_FRAC = 0.02
FREEZE_LEN_Y0, FREEZE_LEN_Y1 = 14, 5
FREEZE_LEN_R0, FREEZE_LEN_R1 = 22, 9

AMP_WINDOW = 16
AMP_LOG = 0.45
AMP_Y0, AMP_Y1 = 3.2, 2.05
AMP_R0, AMP_R1 = 4.8, 3.1
AMP_N_Y0, AMP_N_Y1 = 5, 3
AMP_N_R0, AMP_N_R1 = 9, 5
AMP_HOT_GATE = 2.0


def _ease_01(t: int, t0: int = BURNIN, t1: int = EASE_T1) -> float:
    u = max(0.0, min(1.0, (t - t0) / max(t1 - t0, 1)))
    return u * u * (3.0 - 2.0 * u)


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def _is_meas(field_id: str) -> bool:
    return field_id.split("::")[-1].startswith("xmeas_")


def _quantile(values: list[float], q: float) -> float:
    xs = sorted(v for v in values if math.isfinite(v))
    if not xs:
        return NAN
    if len(xs) == 1:
        return xs[0]
    pos = q * (len(xs) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return xs[lo]
    w = pos - lo
    return xs[lo] * (1.0 - w) + xs[hi] * w


def _nanquantile(values: list[float], q: float) -> float:
    return _quantile(values, q)


@dataclass
class _Channel:
    moments: OnlineMoments = field(default_factory=OnlineMoments)
    last_x: float | None = None
    freeze_streak: int = 0
    burn_absd: list[float] = field(default_factory=list)
    burn_streak_max: int = 0
    freeze_eps: float = NAN
    freeze_l0: int = 0
    window: deque[float] = field(default_factory=lambda: deque(maxlen=AMP_WINDOW))
    burn_ptps: list[float] = field(default_factory=list)
    amp_base: float = NAN
    is_meas: bool = False


@dataclass
class V5ChannelHit:
    field_id: str
    score: float
    reason: str
    mean: float
    sd: float
    skew: float
    kurt: float
    n: int


@dataclass
class V5TickVerdict:
    index: int
    level: int
    rising: bool
    reason: str
    moment_level: int
    freeze_level: int
    amp_level: int
    moment_z: float
    freeze_extra: float
    amp_q90: float
    hits: list[V5ChannelHit]

    @property
    def label(self) -> str:
        return LEVEL_NAMES[self.level]


@dataclass
class V5AgnosticDetector:
    """Streaming port of the notebook's three-score plant flag."""

    channels: dict[str, _Channel] = field(default_factory=dict)
    index: int = -1
    level: int = 0
    prev_raw_moment: int = 0
    score_mu: float = 0.0
    score_sig: float = 0.25
    calibrated: bool = False
    burn_scores: list[float] = field(default_factory=list)
    _prev_level: int = 0

    def reset(self) -> None:
        self.channels.clear()
        self.index = -1
        self.level = 0
        self.prev_raw_moment = 0
        self.score_mu = 0.0
        self.score_sig = 0.25
        self.calibrated = False
        self.burn_scores = []
        self._prev_level = 0

    def drop(self, field_ids: list[str]) -> None:
        for field_id in field_ids:
            self.channels.pop(field_id, None)

    def field_ids(self) -> list[str]:
        return list(self.channels)

    @property
    def n(self) -> int:
        return self.index + 1

    def step(self, values: dict[str, float]) -> V5TickVerdict:
        self.index += 1
        t = self.index
        u = _ease_01(t)
        y_z = _lerp(YELLOW_Z0, YELLOW_Z1, u)
        r_z = _lerp(RED_Z0, RED_Z1, u)
        y_len = int(round(_lerp(FREEZE_LEN_Y0, FREEZE_LEN_Y1, u)))
        r_len = int(round(_lerp(FREEZE_LEN_R0, FREEZE_LEN_R1, u)))
        y_amp = _lerp(AMP_Y0, AMP_Y1, u)
        r_amp = _lerp(AMP_R0, AMP_R1, u)
        y_n = int(round(_lerp(AMP_N_Y0, AMP_N_Y1, u)))
        r_n = int(round(_lerp(AMP_N_R0, AMP_N_R1, u)))

        sensor_scores: list[tuple[str, float]] = []
        freeze_extras: list[tuple[str, float]] = []
        amp_ratios: list[tuple[str, float]] = []
        hits_meta: dict[str, _Channel] = {}

        for field_id in sorted(values):
            x = float(values[field_id])
            if not math.isfinite(x):
                continue
            ch = self.channels.get(field_id)
            if ch is None:
                ch = _Channel(is_meas=_is_meas(field_id))
                self.channels[field_id] = ch
            hits_meta[field_id] = ch

            # --- moment influence (studentize vs samples already pushed) ---
            z = ch.moments.zscore(x)
            if math.isfinite(z):
                z = max(-20.0, min(20.0, z))
                parts = [
                    abs(z),
                    abs(z * z - 1.0) / math.sqrt(2.0),
                    abs(z**3) / math.sqrt(15.0),
                    abs(z**4 - 3.0) / math.sqrt(96.0),
                ]
                sensor_scores.append(
                    (field_id, math.sqrt(sum(p * p for p in parts) / 4.0))
                )
            ch.moments.push(x)

            # --- freeze (measurements only) ---
            if ch.is_meas:
                if ch.last_x is not None:
                    absd = abs(x - ch.last_x)
                    if t < BURNIN:
                        ch.burn_absd.append(absd)
                    frozen = False
                    if self.calibrated and math.isfinite(ch.freeze_eps):
                        frozen = absd < ch.freeze_eps
                    elif t < BURNIN:
                        # provisional eps from what we have so far (finalize at burn-in)
                        eps = self._provisional_eps(ch)
                        frozen = absd < eps
                    ch.freeze_streak = ch.freeze_streak + 1 if frozen else 0
                    if t < BURNIN:
                        ch.burn_streak_max = max(ch.burn_streak_max, ch.freeze_streak)
                    extra = float(ch.freeze_streak - ch.freeze_l0)
                    freeze_extras.append((field_id, extra))
                ch.last_x = x

                # --- amplitude window ---
                ch.window.append(x)
                if len(ch.window) >= AMP_WINDOW:
                    ptp = max(ch.window) - min(ch.window)
                    if t < BURNIN:
                        ch.burn_ptps.append(ptp)
                    if self.calibrated and math.isfinite(ch.amp_base) and ch.amp_base > 0:
                        allow = 1.0 + AMP_LOG * math.log(max(t + 1, BURNIN) / BURNIN)
                        ratio = (ptp / ch.amp_base) / allow
                        if math.isfinite(ratio):
                            amp_ratios.append((field_id, ratio))

        # finalize burn-in calibration on the last burn-in sample
        plant_score = _nanquantile([s for _, s in sensor_scores], SENSOR_Q)
        if t < BURNIN and math.isfinite(plant_score) and t >= MIN_T - 1:
            self.burn_scores.append(plant_score)
        if t == BURNIN - 1:
            self._finalize_calibration()

        moment_z = NAN
        raw_mom = 0
        mom_level = 0
        # Notebook zeros z[:BURNIN] and only loops t in [BURNIN, T). Do not
        # alarm on the finalize tick itself either — calibration uses samples
        # 0..BURNIN-1 as the quiet baseline.
        if self.calibrated and t >= BURNIN and math.isfinite(plant_score):
            moment_z = (plant_score - self.score_mu) / self.score_sig
            if moment_z >= r_z:
                raw_mom = 2
            elif moment_z >= y_z:
                raw_mom = 1
            if raw_mom == 2:
                mom_level = 2
            elif raw_mom == 1 and self.prev_raw_moment >= 1:
                mom_level = 1
        self.prev_raw_moment = raw_mom

        freeze_level = 0
        freeze_extra = 0.0
        freeze_who = ""
        if self.calibrated and freeze_extras and t >= BURNIN:
            freeze_who, freeze_extra = max(freeze_extras, key=lambda row: row[1])
            if freeze_extra >= r_len:
                freeze_level = 2
            elif freeze_extra >= y_len:
                freeze_level = 1

        amp_level = 0
        amp_q90 = NAN
        amp_who = ""
        if self.calibrated and amp_ratios and t >= BURNIN:
            amp_q90 = _nanquantile([r for _, r in amp_ratios], 0.90)
            n_hot = sum(1 for _, r in amp_ratios if r >= AMP_HOT_GATE)
            amp_who, _ = max(amp_ratios, key=lambda row: row[1])
            if math.isfinite(amp_q90):
                if amp_q90 >= r_amp and n_hot >= r_n:
                    amp_level = 2
                elif amp_q90 >= y_amp and n_hot >= y_n:
                    amp_level = 1

        level = max(mom_level, freeze_level, amp_level)
        reason = ""
        if level > 0:
            # Prefer the channel family that produced the plant level (notebook who=argmax).
            candidates = [
                (mom_level, "moment"),
                (freeze_level, "freeze"),
                (amp_level, "amp"),
            ]
            reason = max(candidates, key=lambda row: row[0])[1]

        rising = level > self._prev_level
        self._prev_level = level
        self.level = level

        hits = self._hits(
            reason=reason,
            sensor_scores=sensor_scores,
            freeze_who=freeze_who,
            freeze_extra=freeze_extra,
            amp_who=amp_who,
            amp_ratios=amp_ratios,
            hits_meta=hits_meta,
        )

        return V5TickVerdict(
            index=t,
            level=level,
            rising=rising,
            reason=reason,
            moment_level=mom_level,
            freeze_level=freeze_level,
            amp_level=amp_level,
            moment_z=moment_z if math.isfinite(moment_z) else 0.0,
            freeze_extra=freeze_extra,
            amp_q90=amp_q90 if math.isfinite(amp_q90) else 0.0,
            hits=hits,
        )

    def _provisional_eps(self, ch: _Channel) -> float:
        if not ch.burn_absd:
            return 1e-8
        q = _quantile(ch.burn_absd, FREEZE_Q)
        medx = _quantile([abs(v) for v in ch.window] or [0.0], 0.5)
        return max(FREEZE_FRAC * q, 1e-6 * max(medx, 1.0))

    def _finalize_calibration(self) -> None:
        if self.burn_scores:
            mu = _quantile(self.burn_scores, 0.5)
            mad = _quantile([abs(s - mu) for s in self.burn_scores], 0.5)
            sig = 1.4826 * mad
        else:
            mu, sig = 0.0, 0.25
        if not math.isfinite(mu):
            mu = 0.0
        if not math.isfinite(sig) or sig < 0.25:
            sig = 0.25
        self.score_mu = mu
        self.score_sig = sig

        for ch in self.channels.values():
            if not ch.is_meas:
                continue
            if ch.burn_absd:
                q = _quantile(ch.burn_absd, FREEZE_Q)
                medx = abs(ch.last_x) if ch.last_x is not None else 1.0
                ch.freeze_eps = max(FREEZE_FRAC * q, 1e-6 * max(medx, 1.0))
            else:
                ch.freeze_eps = 1e-8
            ch.freeze_l0 = int(ch.burn_streak_max)
            if ch.burn_ptps:
                base = _quantile(ch.burn_ptps, 0.5)
                ch.amp_base = max(base, 1e-12) if math.isfinite(base) else 1e-12
            else:
                ch.amp_base = 1e-12
        self.calibrated = True

    def _hits(
        self,
        *,
        reason: str,
        sensor_scores: list[tuple[str, float]],
        freeze_who: str,
        freeze_extra: float,
        amp_who: str,
        amp_ratios: list[tuple[str, float]],
        hits_meta: dict[str, _Channel],
    ) -> list[V5ChannelHit]:
        out: list[V5ChannelHit] = []

        def pack(field_id: str, score: float, why: str) -> V5ChannelHit:
            ch = hits_meta.get(field_id) or self.channels.get(field_id)
            m = ch.moments if ch else OnlineMoments()
            return V5ChannelHit(
                field_id=field_id,
                score=float(score),
                reason=why,
                mean=m.mean if m.n else NAN,
                sd=m.sd,
                skew=m.skew,
                kurt=m.kurt,
                n=m.n,
            )

        if reason == "moment":
            for field_id, score in sorted(sensor_scores, key=lambda row: -row[1])[:5]:
                out.append(pack(field_id, score, "moment"))
        elif reason == "freeze" and freeze_who:
            out.append(pack(freeze_who, freeze_extra, "freeze"))
        elif reason == "amp":
            for field_id, score in sorted(amp_ratios, key=lambda row: -row[1])[:5]:
                out.append(pack(field_id, score, "amp"))
            if amp_who and not any(h.field_id == amp_who for h in out):
                ratio = next((r for f, r in amp_ratios if f == amp_who), 0.0)
                out.insert(0, pack(amp_who, ratio, "amp"))
        return out[:5]
