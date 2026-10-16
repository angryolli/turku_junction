"""v6 rolling z-score detector, k consecutive ticks.

Matches `zscore_k6_level` in data_processing/v6_normal_faulty_frames.ipynb (§5).
Each channel studentizes the new sample against the expanding mean and sd of the
samples before it: `z_t = (x_t - mean_{t-1}) / max(sd_{t-1}, floor)`. A tick is
hot at four sigma when any channel reaches `|z| >= 4`, and hot at six sigma when
any channel reaches `|z| >= 6`. Yellow needs the last k ticks all hot at four,
red the last k all hot at six, and red replaces yellow. Nothing fires inside the
burn-in, so a lone spike never alerts.

The notebook scores a finished run with cumulative-sum numpy; here the same
recursion runs tick by tick over Welford accumulators, so the detector holds four
floats per channel and never retains a raw row. Two deliberate differences from
the notebook, both about degenerate input rather than the rule:

* Welford replaces `cumsum(x) / cumsum(x*x)`, which is the same quantity computed
  without the catastrophic cancellation that hurts a long stream.
* A non-finite sample is skipped instead of poisoning that channel's cumulative
  sums for the rest of the run.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


ZSCORE_K = max(1, _env_int("ZSCORE_K", 6))
Z_YELLOW = _env_float("ZSCORE_YELLOW", 4.0)
Z_RED = _env_float("ZSCORE_RED", 6.0)
BURN_IN = max(0, _env_int("ZSCORE_BURN_IN", 20))

SD_FLOOR_REL = 1e-6
SD_FLOOR_ABS = 1e-8
NAN = float("nan")

LEVEL_NAMES = {0: "normal", 1: "yellow", 2: "red"}


@dataclass
class OnlineMoments:
    """Expanding mean, sd, skew and kurtosis of one channel in O(1) memory.

    mean and sd drive the detector; skew and kurtosis are carried for the
    diagnosis artifact only. Sample conventions match `pandas.Series.std/skew/kurt`
    (ddof=1, adjusted Fisher-Pearson skew, unbiased excess kurtosis).
    """

    n: int = 0
    mean: float = 0.0
    m2: float = 0.0
    m3: float = 0.0
    m4: float = 0.0

    def push(self, x: float) -> None:
        prev = self.n
        self.n = n = prev + 1
        delta = x - self.mean
        delta_n = delta / n
        delta_n2 = delta_n * delta_n
        term = delta * delta_n * prev
        self.mean += delta_n
        self.m4 += (
            term * delta_n2 * (n * n - 3 * n + 3)
            + 6.0 * delta_n2 * self.m2
            - 4.0 * delta_n * self.m3
        )
        self.m3 += term * delta_n * (n - 2) - 3.0 * delta_n * self.m2
        self.m2 += term

    @property
    def sd(self) -> float:
        if self.n < 2:
            return NAN
        return math.sqrt(max(self.m2, 0.0) / (self.n - 1))

    @property
    def skew(self) -> float:
        n = self.n
        if n < 3 or self.m2 <= 0.0:
            return NAN
        g1 = math.sqrt(n) * self.m3 / self.m2**1.5
        return g1 * math.sqrt(n * (n - 1.0)) / (n - 2.0)

    @property
    def kurt(self) -> float:
        n = self.n
        if n < 4 or self.m2 <= 0.0:
            return NAN
        g2 = n * self.m4 / (self.m2 * self.m2) - 3.0
        return ((n + 1.0) * g2 + 6.0) * (n - 1.0) / ((n - 2.0) * (n - 3.0))

    def zscore(self, x: float) -> float:
        """Studentize x against the samples already pushed.

        NaN until two samples exist, matching the notebook's `sd[0] = nan`: the
        first sample has no reference and the second has no spread to divide by.
        """
        if self.n < 2:
            return NAN
        floor = max(SD_FLOOR_REL * abs(self.mean), SD_FLOOR_ABS)
        sd = self.sd
        denom = sd if sd > floor else floor
        z = (x - self.mean) / denom
        return z if math.isfinite(z) else NAN


@dataclass
class ChannelZ:
    """One channel's studentized sample plus the reference it was scored against."""

    field_id: str
    z: float
    n: int
    mean: float
    sd: float
    skew: float
    kurt: float

    @property
    def abs_z(self) -> float:
        return abs(self.z) if math.isfinite(self.z) else NAN


@dataclass
class TickVerdict:
    index: int
    """0-based position in the run. Equals the notebook's `t`."""

    level: int
    rising: bool
    """True when this tick opens a new alert, rather than continuing one."""

    z_max: float
    streak_yellow: int
    streak_red: int
    n_hot: int
    """Channels at or above the yellow gate on this tick."""

    channels: list[ChannelZ]
    """Every channel seen this tick, hottest first."""

    @property
    def label(self) -> str:
        return LEVEL_NAMES[self.level]

    def hot_channels(self, gate: float) -> list[ChannelZ]:
        return [row for row in self.channels if math.isfinite(row.z) and row.abs_z >= gate]


@dataclass
class ZScoreDetector:
    """Streaming `zscore_k6_level`. One `step` per tick, in arrival order."""

    k: int = ZSCORE_K
    yellow_z: float = Z_YELLOW
    red_z: float = Z_RED
    burn_in: int = BURN_IN
    stats: dict[str, OnlineMoments] = field(default_factory=dict)
    index: int = -1
    streak_yellow: int = 0
    streak_red: int = 0
    level: int = 0

    def reset(self) -> None:
        self.stats.clear()
        self.index = -1
        self.streak_yellow = 0
        self.streak_red = 0
        self.level = 0

    def drop(self, field_ids: list[str]) -> None:
        for field_id in field_ids:
            self.stats.pop(field_id, None)

    def field_ids(self) -> list[str]:
        return list(self.stats)

    @property
    def n(self) -> int:
        """Ticks consumed since the last reset."""
        return self.index + 1

    @property
    def calibrated(self) -> bool:
        """True once the burn-in is behind us and a hit could count."""
        return self.index >= self.burn_in

    def step(self, values: dict[str, float]) -> TickVerdict:
        self.index += 1
        channels: list[ChannelZ] = []
        z_max = NAN
        n_hot = 0

        for field_id in sorted(values):
            x = float(values[field_id])
            stat = self.stats.setdefault(field_id, OnlineMoments())
            z = stat.zscore(x) if math.isfinite(x) else NAN
            channels.append(
                ChannelZ(
                    field_id=field_id,
                    z=z,
                    n=stat.n,
                    mean=stat.mean if stat.n else NAN,
                    sd=stat.sd,
                    skew=stat.skew,
                    kurt=stat.kurt,
                )
            )
            if math.isfinite(x):
                stat.push(x)
            if not math.isfinite(z):
                continue
            magnitude = abs(z)
            if not math.isfinite(z_max) or magnitude > z_max:
                z_max = magnitude
            if magnitude >= self.yellow_z:
                n_hot += 1

        channels.sort(key=lambda row: (-row.abs_z if math.isfinite(row.z) else 1.0, row.field_id))

        hit_yellow = math.isfinite(z_max) and z_max >= self.yellow_z
        hit_red = math.isfinite(z_max) and z_max >= self.red_z
        if self.index < self.burn_in:
            hit_yellow = hit_red = False

        self.streak_yellow = self.streak_yellow + 1 if hit_yellow else 0
        self.streak_red = self.streak_red + 1 if hit_red else 0

        if self.streak_red >= self.k:
            level = 2
        elif self.streak_yellow >= self.k:
            level = 1
        else:
            level = 0

        rising = level > self.level and level > 0
        self.level = level
        return TickVerdict(
            index=self.index,
            level=level,
            rising=rising,
            z_max=z_max,
            streak_yellow=self.streak_yellow,
            streak_red=self.streak_red,
            n_hot=n_hot,
            channels=channels,
        )
