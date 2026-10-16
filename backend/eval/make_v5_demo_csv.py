"""Cut two extra demo CSVs from the v5 1,000-run sample.

    PYTHONPATH=. python -m eval.make_v5_demo_csv

Does not touch `demo_faulty_run.csv` / `demo_normal_run.csv`. Writes:

* `demo_train_idv11_run213.csv` — train IDV(11) run 213 (faulty)
* `demo_test_idv3_run466.csv` — test IDV(3) run 466 (CSV-labeled faulty,
  v5 detector silent)

Reads `data_processing/v5_sample1000_runs_s42_native.csv`, not `te_process.csv`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

DEST = Path(__file__).resolve().parents[1] / "data" / "sources"
V5_SAMPLE = Path(__file__).resolve().parents[2] / "data_processing" / "v5_sample1000_runs_s42_native.csv"

# dest name, source, IDV, simulationRun, expected samples
DEMO_RUNS = (
    ("demo_train_idv11_run213.csv", "train", 11, 213, 500),
    ("demo_test_idv3_run466.csv", "test", 3, 466, 960),
)


def sensor_columns(columns) -> list[str]:
    return [c for c in columns if str(c).startswith("xmeas_") or str(c).startswith("xmv_")]


def extract_runs(path: Path, chunksize: int = 80_000) -> dict[tuple[str, int, int], pd.DataFrame]:
    header = pd.read_csv(path, nrows=0)
    sensors = sensor_columns(header.columns)
    usecols = ["source", "faultNumber", "simulationRun", "sample"] + sensors
    wanted = {(source, idv, run): n for _, source, idv, run, n in DEMO_RUNS}
    parts: dict[tuple[str, int, int], list[pd.DataFrame]] = {key: [] for key in wanted}
    counts = {key: 0 for key in wanted}

    for chunk in pd.read_csv(path, usecols=usecols, chunksize=chunksize):
        src = chunk["source"].astype(str)
        idv = chunk["faultNumber"].astype(int)
        run = chunk["simulationRun"].astype(int)
        for key, need in wanted.items():
            if counts[key] >= need:
                continue
            hit = chunk.loc[src.eq(key[0]) & idv.eq(key[1]) & run.eq(key[2])]
            if hit.empty:
                continue
            parts[key].append(hit)
            counts[key] += len(hit)
        if all(counts[k] >= n for k, n in wanted.items()):
            break

    out: dict[tuple[str, int, int], pd.DataFrame] = {}
    for key, frames in parts.items():
        if not frames:
            continue
        frame = pd.concat(frames, ignore_index=True).sort_values("sample")
        out[key] = frame[["sample"] + sensors].reset_index(drop=True)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval.make_v5_demo_csv", description=__doc__)
    parser.add_argument("--dest", type=Path, default=DEST)
    parser.add_argument("--sample", type=Path, default=V5_SAMPLE)
    args = parser.parse_args(argv)

    if not args.sample.is_file():
        print("missing v5 sample cache (from v5_only_statistical.ipynb, seed 42):")
        print(f"  {args.sample}")
        return 2

    args.dest.mkdir(parents=True, exist_ok=True)
    found = extract_runs(args.sample)
    missing = False
    for name, source, idv, run, expect in DEMO_RUNS:
        frame = found.get((source, idv, run))
        if frame is None:
            print(f"could not find {source} IDV={idv} run={run} in {args.sample.name}")
            missing = True
            continue
        dest = args.dest / name
        frame.to_csv(dest, index=False)
        print(
            f"{dest.name:<32} {len(frame):>5} samples x {frame.shape[1] - 1} sensors  "
            f"<- {args.sample.name} source={source} IDV={idv} run={run}"
            + ("" if len(frame) == expect else f"  (expected {expect})")
        )
    if missing:
        return 1
    print(f"\npoint a file source at {args.dest} and set x-axis = sample")
    return 0


if __name__ == "__main__":
    sys.exit(main())
