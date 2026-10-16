from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

import pandas as pd

EXCEL_SUFFIXES = {".xlsx", ".xls", ".xlsm"}
CSV_SUFFIXES = {".csv", ".txt"}


def _series_to_row(row: pd.Series) -> dict:
    out: dict = {}
    for key, value in row.items():
        name = str(key)
        if value is None or (isinstance(value, float) and pd.isna(value)):
            out[name] = None
        elif hasattr(value, "isoformat"):
            out[name] = value.isoformat()
        else:
            try:
                if pd.isna(value):
                    out[name] = None
                    continue
            except (TypeError, ValueError):
                pass
            if hasattr(value, "item"):
                try:
                    out[name] = value.item()
                    continue
                except (ValueError, AttributeError):
                    pass
            out[name] = value
    return out


def dataframe_to_rows(df: pd.DataFrame) -> list[dict]:
    return [_series_to_row(row) for _, row in df.iterrows()]


def dataframe_from_bytes(filename: str, data: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    buf = io.BytesIO(data)
    if suffix in EXCEL_SUFFIXES:
        return _read_excel(buf)
    if suffix in CSV_SUFFIXES or suffix == "":
        buf.seek(0)
        return pd.read_csv(buf)
    buf.seek(0)
    try:
        return _read_excel(buf)
    except Exception:
        buf.seek(0)
        return pd.read_csv(buf)


def _read_excel(buf: io.BytesIO) -> pd.DataFrame:
    try:
        return pd.read_excel(buf, engine="openpyxl")
    except ImportError as exc:
        raise RuntimeError(
            "Excel ingest needs openpyxl. From backend/: uv sync"
        ) from exc


def dataframe_from_api(url: str, timeout: float = 8.0) -> pd.DataFrame:
    req = Request(url, headers={"Accept": "application/json, text/csv, */*"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            content_type = (resp.headers.get("Content-Type") or "").lower()
            final_url = resp.geturl()
    except URLError as exc:
        raise ValueError(f"API request failed: {exc}") from exc
    return dataframe_from_payload(raw, content_type, final_url)


def dataframe_from_payload(raw: bytes, content_type: str, url: str) -> pd.DataFrame:
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    if "csv" in content_type or suffix == ".csv":
        return pd.read_csv(io.BytesIO(raw))
    if suffix in EXCEL_SUFFIXES or "spreadsheet" in content_type or "excel" in content_type:
        return dataframe_from_bytes("book.xlsx", raw)
    text = raw.decode("utf-8-sig", errors="replace").strip()
    if text.startswith("{") or text.startswith("["):
        payload = json.loads(text)
        if isinstance(payload, list):
            return pd.DataFrame(payload)
        if isinstance(payload, dict):
            for key in ("data", "items", "results", "rows", "records"):
                nested = payload.get(key)
                if isinstance(nested, list):
                    return pd.DataFrame(nested)
            return pd.DataFrame([payload])
        raise ValueError("API JSON did not contain a table")
    return pd.read_csv(io.StringIO(text))


def write_csv(df: pd.DataFrame, dest: Path) -> Path:
    if df.empty:
        raise ValueError("no rows in the uploaded data")
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(dest, index=False)
    return dest


def materialize_csv(path: Path, dest: Path | None = None) -> Path:
    """Return a CSV path for disk replay. Excel is converted once; CSV is used in place."""
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"file not found: {path}")
    suffix = resolved.suffix.lower()
    if suffix in CSV_SUFFIXES:
        return resolved
    if suffix in EXCEL_SUFFIXES:
        target = dest or resolved.with_suffix(".csv")
        frame = dataframe_from_bytes(resolved.name, resolved.read_bytes())
        write_csv(frame, target)
        return target
    raise ValueError("expected a .csv or Excel file")
