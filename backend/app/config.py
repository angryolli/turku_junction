from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
DATA_DIR = ROOT / "data"


def _load_dotenv() -> None:
    for path in (
        ROOT / ".env",
        REPO_ROOT / ".env",
        REPO_ROOT / "frontend" / ".env",
    ):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()

# Overridable so a throwaway instance can keep its sqlite out of the dev one.
ARTIFACT_DIR = Path(os.getenv("ARTIFACT_DIR", "").strip() or ROOT / "artifacts").expanduser()

TICK_SECONDS = float(os.getenv("STREAM_TICK_SECONDS", "0.45"))
# Default rate the UI and stream loop start from. Overridable at runtime.
DEFAULT_TICKS_PER_SECOND = round(1.0 / max(TICK_SECONDS, 1e-3), 2)
MIN_TICKS_PER_SECOND = 0.5
MAX_TICKS_PER_SECOND = 50.0
LIVE_BUFFER = int(os.getenv("LIVE_BUFFER", "400"))
SPARKLINE_POINTS = 100
MAX_ARTIFACT_BYTES = 20_000
TOP_CORR_PAIRS = 20
TOP_RANK = 10
PCA_MAX_COMPONENTS = 5


def demo_data_path() -> Path | None:
    raw = os.getenv("DEMO_DATA_URI", "").strip().strip("'").strip('"')
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_dir():
        csvs = sorted(p for p in path.iterdir() if p.suffix.lower() == ".csv")
        return csvs[0] if csvs else None
    if path.is_file():
        return path
    return None


def default_data_sources() -> list[dict]:
    path = demo_data_path()
    if path is None:
        return []
    resolved = str(path)
    return [
        {
            "id": "demo_csv",
            "name": path.stem,
            "kind": "process",
            "description": f"Disk replay {resolved}",
            "generator": "",
            "origin": "file",
            "api_url": "",
            "file_path": resolved,
            "train_path": resolved,
            "live_path": resolved,
        }
    ]


DEFAULT_DATA_SOURCES = default_data_sources()
DATASETS = {s["id"]: s for s in DEFAULT_DATA_SOURCES}


def default_dataset() -> str:
    return os.getenv("DATASET_ID", "demo_csv")
