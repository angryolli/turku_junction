"""Tick-by-tick alert timeline for one run, as the live stream would produce it.

    uv run python -m eval.timeline                      # the demo faulty run
    uv run python -m eval.timeline --idv 6 --run 3      # any run from the v6 cache
    uv run python -m eval.timeline --csv path.csv
    uv run python -m eval.timeline --json out.json      # per-tick records for plotting

Prints three views of the same replay:

1. Segments — the contiguous normal/yellow/red bands, so alert positions are exact.
2. The run-up — every tick around the first alert, showing the hot streak building
   to k. This is where you can see why the alert lands on the tick it lands on.
3. Attribution — how many channels were over the gate when each alert opened.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from app.inference.zscore import ZScoreDetector
from eval.score import CACHE_FAULTY, iter_runs, sensor_columns

DEMO = Path(__file__).resolve().parents[1] / "data" / "sources" / "demo_faulty_run.csv"
# TEP test runs inject the fault at sample 160.
TEP_ONSET = 160
BAR = {"normal": "·", "yellow": "y", "red": "R"}


def load_run(args) -> tuple[pd.DataFrame, list[str], str]:
    if args.csv:
        frame = pd.read_csv(args.csv)
        sensors = [c for c in frame.columns if c != "sample" and pd.api.types.is_numeric_dtype(frame[c])]
        return frame, sensors, f"{Path(args.csv).name}"
    if args.idv is not None:
        for key, group in iter_runs(CACHE_FAULTY, limit=100_000):
            if int(key[1]) == args.idv and (args.run is None or int(key[2]) == args.run):
                return group, sensor_columns(group.columns), f"IDV({key[1]}) run {key[2]}"
        raise SystemExit(f"no faulty run for IDV {args.idv} run {args.run}")
    frame = pd.read_csv(DEMO)
    sensors = [c for c in frame.columns if c != "sample"]
    return frame, sensors, "demo_faulty_run.csv (IDV 1, run 32)"


def replay(frame: pd.DataFrame, sensors: list[str]) -> list[dict]:
    """One record per tick, exactly what the engine computes on the live stream."""
    detector = ZScoreDetector()
    X = frame[sensors].to_numpy(np.float64)
    out: list[dict] = []
    for i, row in enumerate(X, start=1):
        verdict = detector.step(dict(zip(sensors, (float(v) for v in row))))
        hot = verdict.hot_channels(detector.yellow_z)
        out.append(
            {
                "tick": i,
                "level": verdict.label,
                "rising": verdict.rising,
                "z_max": None if not np.isfinite(verdict.z_max) else round(verdict.z_max, 3),
                "streak_yellow": verdict.streak_yellow,
                "streak_red": verdict.streak_red,
                "n_hot": verdict.n_hot,
                "hot": [
                    {"field_id": c.field_id, "abs_z": round(c.abs_z, 2)} for c in hot[:6]
                ],
            }
        )
    return out


def segments(ticks: list[dict]) -> list[dict]:
    out: list[dict] = []
    for row in ticks:
        if out and out[-1]["level"] == row["level"]:
            out[-1]["end"] = row["tick"]
            out[-1]["n"] += 1
        else:
            out.append({"level": row["level"], "start": row["tick"], "end": row["tick"], "n": 1})
    return out


def print_segments(ticks: list[dict], onset: int) -> None:
    print("\n1. ALERT SEGMENTS  (contiguous bands over the whole run)")
    print(f"   {'ticks':<16} {'level':<8} {'len':>4}  peak max|z|")
    for seg in segments(ticks):
        window = [t for t in ticks if seg["start"] <= t["tick"] <= seg["end"]]
        peak = max((t["z_max"] or 0.0) for t in window)
        span = f"{seg['start']}-{seg['end']}" if seg["n"] > 1 else str(seg["start"])
        note = ""
        if seg["level"] != "normal" and seg["start"] >= onset:
            note = f"  <- {seg['start'] - onset} ticks after fault onset"
        print(f"   {span:<16} {seg['level']:<8} {seg['n']:>4}  {peak:>6.2f}{note}")


def print_bar(ticks: list[dict], onset: int, width: int = 100) -> None:
    """One character per tick around the fault, so positions are visible at a glance."""
    lo = max(1, onset - 20)
    hi = min(len(ticks), lo + width - 1)
    line = "".join(BAR[t["level"]] for t in ticks if lo <= t["tick"] <= hi)
    marker = " " * (onset - lo) + "^"
    print(f"\n   ticks {lo}..{hi}   (· normal, y yellow, R red)")
    print(f"   {line}")
    print(f"   {marker} fault injected at sample {onset}")


def print_runup(ticks: list[dict], onset: int, k: int) -> None:
    first = next((t["tick"] for t in ticks if t["level"] != "normal"), None)
    if first is None:
        print("\n2. RUN-UP  no alert in this run")
        return
    lo, hi = max(1, first - 12), min(len(ticks), first + 8)
    print(f"\n2. RUN-UP TO THE FIRST ALERT  (k={k} consecutive hot ticks required)")
    print(f"   {'tick':>5}  {'level':<7} {'max|z|':>7} {'hot4':>5} {'hot6':>5} {'#ch':>4}  hottest channels")
    for row in ticks:
        if not (lo <= row["tick"] <= hi):
            continue
        names = ", ".join(f"{h['field_id'].split('::')[-1]}={h['abs_z']}" for h in row["hot"][:3]) or "-"
        flag = ""
        if row["tick"] == onset:
            flag = "  <- fault injected"
        elif row["rising"]:
            flag = f"  <- {row['level'].upper()} opens: streak hit {k}"
        z = "-" if row["z_max"] is None else f"{row['z_max']:.2f}"
        print(f"   {row['tick']:>5}  {row['level']:<7} {z:>7} "
              f"{row['streak_yellow']:>5} {row['streak_red']:>5} {row['n_hot']:>4}  {names}{flag}")


def print_attribution(ticks: list[dict], n_sensors: int) -> None:
    print(f"\n3. ATTRIBUTION AT EACH ALERT  ({n_sensors} sensors in the run)")
    rising = [t for t in ticks if t["rising"]]
    if not rising:
        print("   no alerts")
        return
    for row in rising:
        names = ", ".join(f"{h['field_id'].split('::')[-1]} |z|={h['abs_z']}" for h in row["hot"])
        print(f"   tick {row['tick']:>4} {row['level']:<7} {row['n_hot']:>2} of {n_sensors} sensors over 4 sigma")
        print(f"              hot: {names}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval.timeline", description=__doc__)
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--idv", type=int)
    parser.add_argument("--run", type=int)
    parser.add_argument("--onset", type=int, default=TEP_ONSET)
    parser.add_argument("--json", type=Path, help="write per-tick records here")
    args = parser.parse_args(argv)

    frame, sensors, label = load_run(args)
    frame = frame.sort_values("sample") if "sample" in frame.columns else frame
    detector = ZScoreDetector()
    print(f"{label}: {len(frame)} samples x {len(sensors)} sensors")
    print(f"detector: k={detector.k} yellow=|z|>={detector.yellow_z:g} "
          f"red=|z|>={detector.red_z:g} burn_in={detector.burn_in}")

    ticks = replay(frame, sensors)
    print_segments(ticks, args.onset)
    print_bar(ticks, args.onset)
    print_runup(ticks, args.onset, detector.k)
    print_attribution(ticks, len(sensors))

    if args.json:
        hot_names = sorted({h["field_id"] for t in ticks for h in t["hot"]})
        payload = {
            "label": label,
            "n_samples": len(frame),
            "n_sensors": len(sensors),
            "onset": args.onset,
            "detector": {
                "k": detector.k,
                "yellow_z": detector.yellow_z,
                "red_z": detector.red_z,
                "burn_in": detector.burn_in,
            },
            "ticks": ticks,
            "segments": segments(ticks),
            "traces": {
                name.split("::")[-1]: [round(float(v), 4) for v in frame[name.split("::")[-1]]]
                for name in hot_names
                if name.split("::")[-1] in frame.columns
            },
        }
        args.json.write_text(json.dumps(payload))
        print(f"\nwrote {args.json}  ({len(ticks)} tick records)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
