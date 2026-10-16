"""Cut small demo CSVs out of the v6 caches so the live stream has something to flag.

    uv run python -m eval.make_demo_csv

Writes two files the Sources page can point at: one clean run that must stay
normal, and one faulty run that should go yellow then red. Labels are dropped, so
the detector sees exactly what it sees in production.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from eval.score import CACHE_FAULTY, CACHE_NORMAL, iter_runs, sensor_columns

DEST = Path(__file__).resolve().parents[1] / "data" / "sources"


def write_run(path: Path, dest: Path, skip: int) -> Path | None:
    """Take the (skip+1)th run from a cache and write its sensor columns only."""
    for key, group in iter_runs(path, limit=skip + 1):
        if skip > 0:
            skip -= 1
            continue
        sensors = sensor_columns(group.columns)
        frame = group.sort_values("sample")[["sample"] + sensors].reset_index(drop=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(dest, index=False)
        print(
            f"{dest.name:<28} {len(frame):>5} samples x {len(sensors)} sensors  "
            f"<- {path.name} source={key[0]} IDV={key[1]} run={key[2]}"
        )
        return dest
    print(f"could not read a run from {path}")
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval.make_demo_csv", description=__doc__)
    parser.add_argument("--dest", type=Path, default=DEST)
    parser.add_argument("--faulty-skip", type=int, default=0, help="which faulty run to take")
    args = parser.parse_args(argv)

    missing = [p for p in (CACHE_NORMAL, CACHE_FAULTY) if not p.is_file()]
    if missing:
        print("missing v6 caches, run notebook section 1 first:")
        for path in missing:
            print(f"  {path}")
        return 2

    write_run(CACHE_NORMAL, args.dest / "demo_normal_run.csv", 0)
    write_run(CACHE_FAULTY, args.dest / "demo_faulty_run.csv", args.faulty_skip)
    print(f"\npoint a file source at {args.dest} and set x-axis = sample")
    return 0


if __name__ == "__main__":
    sys.exit(main())
