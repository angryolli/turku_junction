from __future__ import annotations

import csv
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

import pandas as pd

from app.config import SPARKLINE_POINTS

_SKIP_NAME = re.compile(r"(fault|label|idv|class|target|^source$|^run$|^sample$|^unnamed)", re.I)


@dataclass
class DiskReplaySource:
    """Replay a CSV from disk one row per tick. Never loads the full file."""

    path: Path
    tick: int = 0
    source_id: str = ""
    file_name: str = ""
    x_column: str = ""
    numeric_cols: list[str] = field(default_factory=list)
    sparklines: dict[str, deque[float]] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)
    _fh: object | None = None
    _reader: object | None = None
    _header: list[str] = field(default_factory=list)
    _numeric_idx: list[int] = field(default_factory=list)
    file_offset: int = 0
    exhausted: bool = False
    """Set at end of file or when the x-axis column runs out. Replay does not loop."""
    _x_idx: int | None = None

    def open(self, y_cols: list[str] | None = None, x_column: str = "") -> None:
        self.path = Path(self.path)
        if not self.path.is_file():
            raise FileNotFoundError(self.path)
        self.file_name = self.path.name
        self.x_column = x_column.strip()
        with self.path.open("r", newline="", encoding="utf-8", errors="replace") as fh:
            reader = csv.reader(fh)
            header = next(reader, None)
            if not header:
                raise ValueError(f"empty CSV: {self.path}")
            self._header = [str(c).strip() for c in header]
            sample = next(reader, None)
        names = set(self._header)
        if y_cols is not None:
            self.numeric_cols = [
                col for col in y_cols if col in names and col != self.x_column
            ][:80]
        else:
            self.numeric_cols = [
                col for col in _numeric_columns(self._header, sample) if col != self.x_column
            ]
        index = {name: i for i, name in enumerate(self._header)}
        self._numeric_idx = [index[col] for col in self.numeric_cols if col in index]
        self._x_idx = index.get(self.x_column) if self.x_column else None
        self.sparklines = {col: deque(maxlen=SPARKLINE_POINTS) for col in self.numeric_cols}
        self.tick = 0
        self._rewind()

    def _tell(self) -> int:
        fh = self._fh
        if fh is None:
            return self.file_offset
        try:
            return int(fh.tell())
        except Exception:
            return self.file_offset

    def _rewind(self) -> None:
        if self._fh is not None:
            self._fh.close()
        fh = self.path.open("r", newline="", encoding="utf-8", errors="replace")
        reader = csv.reader(fh)
        next(reader, None)
        self._fh = fh
        self._reader = reader
        self.exhausted = False
        self.file_offset = self._tell()

    def _blank(self, row: list[str]) -> bool:
        return not row or all(not str(cell).strip() for cell in row)

    def _x_ended(self, row: list[str]) -> bool:
        if self._x_idx is None:
            return False
        if self._x_idx >= len(row):
            return True
        return not str(row[self._x_idx]).strip()

    def _next_data_row(self) -> list[str] | None:
        """Next row that should become a tick. None when the x-axis or file has ended."""
        reader = self._reader
        if reader is None:
            return None
        while True:
            row = next(reader, None)
            if row is None or self._x_ended(row):
                return None
            if self._blank(row):
                continue
            return row

    def restore(
        self,
        offset: int,
        tick: int,
        sparklines: dict[str, list[float]],
        exhausted: bool = False,
    ) -> None:
        """Replay-read `tick` rows from the header so the cursor matches paused progress."""
        with self.lock:
            for col, values in (sparklines or {}).items():
                if col not in self.numeric_cols:
                    continue
                self.sparklines[col] = deque(
                    (float(v) for v in values[-SPARKLINE_POINTS:]),
                    maxlen=SPARKLINE_POINTS,
                )
            self._rewind()
            remaining = max(0, int(tick or 0))
            consumed = 0
            while remaining > 0:
                if self._next_data_row() is None:
                    self.exhausted = True
                    break
                remaining -= 1
                consumed += 1
            self.tick = consumed if self.exhausted else int(tick or 0)
            if exhausted:
                self.exhausted = True
            self.file_offset = int(offset or self._tell())

    def reset_progress(self) -> None:
        with self.lock:
            self.sparklines = {col: deque(maxlen=SPARKLINE_POINTS) for col in self.numeric_cols}
            self.tick = 0
            self._rewind()

    def progress(self) -> dict:
        with self.lock:
            return {
                "source_id": self.source_id,
                "file_path": str(self.path),
                "file_name": self.file_name,
                "x_column": self.x_column,
                "y_columns": list(self.numeric_cols),
                "tick": self.tick,
                "file_offset": self.file_offset,
                "exhausted": self.exhausted,
                "sparklines": {
                    col: list(self.sparklines.get(col, ())) for col in self.numeric_cols
                },
            }

    def emit(self) -> None:
        with self.lock:
            if self._reader is None or self.exhausted:
                return
            row = self._next_data_row()
            if row is None:
                self.exhausted = True
                self.file_offset = self._tell()
                return
            for col, idx in zip(self.numeric_cols, self._numeric_idx):
                if idx >= len(row):
                    continue
                raw = row[idx]
                if raw == "":
                    continue
                try:
                    self.sparklines[col].append(round(float(raw), 3))
                except (TypeError, ValueError):
                    continue
            self.tick += 1
            self.file_offset = self._tell()

    def latest_values(self) -> dict[str, float]:
        with self.lock:
            out: dict[str, float] = {}
            for col in self.numeric_cols:
                spark = self.sparklines.get(col)
                if spark:
                    out[col] = float(spark[-1])
            return out

    def drop_columns(self, columns: list[str]) -> None:
        drop = {col for col in columns if col}
        if not drop:
            return
        with self.lock:
            self.numeric_cols = [col for col in self.numeric_cols if col not in drop]
            index = {name: i for i, name in enumerate(self._header)}
            self._numeric_idx = [index[col] for col in self.numeric_cols if col in index]
            for col in drop:
                self.sparklines.pop(col, None)

    def cards(self) -> list[tuple[str, list[float], str, str]]:
        with self.lock:
            return [
                (
                    col,
                    list(self.sparklines.get(col, ())),
                    self.file_name,
                    self.source_id,
                )
                for col in self.numeric_cols
            ]

    def latest_batch(self, n: int = 40) -> pd.DataFrame:
        with self.lock:
            cols = list(self.numeric_cols)
            data = {col: list(self.sparklines.get(col, ()))[-n:] for col in cols}
        if not cols:
            return pd.DataFrame()
        length = min((len(values) for values in data.values()), default=0)
        if length == 0:
            return pd.DataFrame(columns=cols)
        return pd.DataFrame({col: values[-length:] for col, values in data.items()})

    def close(self) -> None:
        with self.lock:
            if self._fh is not None:
                self._fh.close()
            self._fh = None
            self._reader = None


def _numeric_columns(header: list[str], sample: list[str] | None) -> list[str]:
    sample = sample or []
    cols: list[str] = []
    for i, name in enumerate(header):
        if not name or _SKIP_NAME.search(name):
            continue
        if i >= len(sample):
            cols.append(name)
            continue
        raw = sample[i].strip()
        if raw == "":
            continue
        try:
            float(raw)
        except ValueError:
            continue
        cols.append(name)
    return cols[:80]


def preview_headers(path: Path) -> dict:
    """Read header + one sample row only. Never loads the rest of the file."""
    path = Path(path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(path)
    with path.open("r", newline="", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if not header:
            raise ValueError(f"empty CSV: {path}")
        sample = next(reader, None)
    columns = [str(c).strip() for c in header if str(c).strip()]
    return {
        "path": str(path.resolve()),
        "file_name": path.name,
        "columns": columns[:120],
        "numeric": _numeric_columns([str(c).strip() for c in header], sample),
    }
