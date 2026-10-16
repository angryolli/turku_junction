"""Check the live detector against labels and against the notebook, after the fact.

`app.inference.zscore` runs the v6 rolling z-score one tick at a time so the
server never holds a raw row. The notebook scores a finished run with vectorised
numpy. This module proves the two agree, then reports TPR/FPR against the
`fault_status` column that the detector itself never sees.

Three modes:

    uv run python -m eval.score parity
        Self-contained. Synthetic runs through both implementations, levels compared
        tick by tick. Needs no data files.

    uv run python -m eval.score frames --runs 60
        Real TEP runs from the v6 caches. Compares the per-run summary to the
        notebook's own cache (v6_eval_oor_corr_v3.csv) and reports TPR/FPR.

    uv run python -m eval.score csv <path> [--x-column ts]
        Replay one CSV through the streaming detector and print its alert timeline.

Do not import app.drift or app.quality.
"""

from __future__ import annotations

import argparse
import sys
import warnings
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pandas as pd

from app.inference.zscore import BURN_IN, Z_RED, Z_YELLOW, ZSCORE_K, ZScoreDetector

DATA_DIR = Path(__file__).resolve().parents[2] / "data_processing"
CACHE_NORMAL = DATA_DIR / "v6_df1_normal_1000runs.csv"
CACHE_FAULTY = DATA_DIR / "v6_df2_faulty_50per_idv.csv"
NOTEBOOK_RESULTS = DATA_DIR / "v6_eval_oor_corr_v3.csv"
RUN_KEYS = ["source", "faultNumber", "simulationRun"]
SUMMARY_COLS = ["n_yellow", "n_red", "events_yellow", "events_red", "alarm"]


# --------------------------------------------------------------------------- #
# Reference: verbatim port of zscore_k6_level from v6_normal_faulty_frames.ipynb
# --------------------------------------------------------------------------- #


def _consecutive_streak(hits: np.ndarray) -> np.ndarray:
    h = np.asarray(hits, dtype=bool)
    streak = np.zeros(len(h), dtype=np.int32)
    for t in range(len(h)):
        streak[t] = (streak[t - 1] + 1) if t and h[t] else np.int32(h[t])
    return streak


def _level_from_streaks(
    streak_y: np.ndarray, streak_r: np.ndarray, k_y: int, k_r: int, burn_in: int
) -> np.ndarray:
    level = np.zeros(len(streak_y), dtype=np.int8)
    y = streak_y >= k_y
    r = streak_r >= k_r
    y[:burn_in] = False
    r[:burn_in] = False
    level[y] = 1
    level[r] = 2
    return level


def notebook_levels(
    X: np.ndarray,
    *,
    k: int = ZSCORE_K,
    yellow: float = Z_YELLOW,
    red: float = Z_RED,
    burn_in: int = BURN_IN,
) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised reference. Returns (level, zmax) for a whole run."""
    X = np.asarray(X, dtype=np.float64)
    T = X.shape[0]
    n = np.arange(1, T + 1, dtype=np.float64)[:, None]
    csum = np.cumsum(X, axis=0)
    mean = csum / n
    var = np.maximum(np.cumsum(X * X, axis=0) - mean * csum, 0.0) / np.maximum(n - 1.0, 1.0)
    sd = np.sqrt(var)
    sd[0] = np.nan
    z = np.full_like(X, np.nan)
    floor = np.maximum(1e-6 * np.abs(mean[:-1]), 1e-8)
    with np.errstate(invalid="ignore", divide="ignore"):
        z[1:] = (X[1:] - mean[:-1]) / np.maximum(sd[:-1], floor)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        zmax = np.nanmax(np.abs(z), axis=1)
    z4 = np.isfinite(zmax) & (zmax >= yellow)
    z6 = np.isfinite(zmax) & (zmax >= red)
    z4[:burn_in] = False
    z6[:burn_in] = False
    level = _level_from_streaks(
        _consecutive_streak(z4), _consecutive_streak(z6), k, k, burn_in
    )
    return level, zmax


# --------------------------------------------------------------------------- #
# The thing under test: the streaming detector the server runs
# --------------------------------------------------------------------------- #


def streaming_levels(
    X: np.ndarray,
    columns: list[str],
    *,
    k: int = ZSCORE_K,
    yellow: float = Z_YELLOW,
    red: float = Z_RED,
    burn_in: int = BURN_IN,
) -> tuple[np.ndarray, np.ndarray]:
    """Feed a run through ZScoreDetector one row at a time, as the server does."""
    detector = ZScoreDetector(k=k, yellow_z=yellow, red_z=red, burn_in=burn_in)
    X = np.asarray(X, dtype=np.float64)
    level = np.zeros(len(X), dtype=np.int8)
    zmax = np.full(len(X), np.nan)
    for i, row in enumerate(X):
        verdict = detector.step(dict(zip(columns, (float(v) for v in row))))
        level[i] = verdict.level
        zmax[i] = verdict.z_max
    return level, zmax


def n_events(level: np.ndarray, value: int) -> int:
    prev = np.concatenate([[0], level[:-1]])
    return int(np.sum((level == value) & (prev != value)))


def summarize(level: np.ndarray) -> dict[str, int]:
    return {
        "n_yellow": int((level == 1).sum()),
        "n_red": int((level == 2).sum()),
        "events_yellow": n_events(level, 1),
        "events_red": n_events(level, 2),
        "alarm": int((level > 0).any()),
    }


# --------------------------------------------------------------------------- #
# Mode 1: synthetic parity
# --------------------------------------------------------------------------- #


def synthetic_run(kind: str, rng: np.random.Generator, T: int = 480, S: int = 12) -> np.ndarray:
    """Normal noise, then one of the failure shapes a plant actually shows."""
    base = rng.normal(0.0, 1.0, size=(T, S)) * rng.uniform(0.5, 4.0, size=S) + rng.uniform(
        -50.0, 50.0, size=S
    )
    onset = T // 2
    if kind == "normal":
        return base
    if kind == "step":
        base[onset:, 3] += 9.0 * base[:, 3].std()
    elif kind == "drift":
        ramp = np.linspace(0.0, 12.0, T - onset)
        base[onset:, 5] += ramp * base[:, 5].std()
    elif kind == "variance":
        base[onset:, 7] *= 6.0
    elif kind == "spike":
        base[onset, 2] += 40.0 * base[:, 2].std()
    elif kind == "freeze":
        base[onset:, 9] = base[onset - 1, 9]
    elif kind == "constant":
        base[:, 0] = 7.0
    return base


def mode_parity(seeds: int, verbose: bool) -> int:
    kinds = ["normal", "step", "drift", "variance", "spike", "freeze", "constant"]
    rows: list[dict] = []
    mismatched_ticks = 0
    worst_z = 0.0

    for seed in range(seeds):
        rng = np.random.default_rng(seed)
        for kind in kinds:
            X = synthetic_run(kind, rng)
            columns = [f"c{i}" for i in range(X.shape[1])]
            ref_level, ref_zmax = notebook_levels(X)
            got_level, got_zmax = streaming_levels(X, columns)
            bad = int(np.sum(ref_level != got_level))
            mismatched_ticks += bad
            both = np.isfinite(ref_zmax) & np.isfinite(got_zmax)
            if both.any():
                worst_z = max(worst_z, float(np.max(np.abs(ref_zmax[both] - got_zmax[both]))))
            rows.append(
                {
                    "seed": seed,
                    "kind": kind,
                    "ref": summarize(ref_level)["alarm"],
                    "got": summarize(got_level)["alarm"],
                    "bad_ticks": bad,
                }
            )

    table = pd.DataFrame(rows)
    print(f"synthetic parity  runs={len(table)}  k={ZSCORE_K} yellow={Z_YELLOW} red={Z_RED} burn_in={BURN_IN}")
    if verbose:
        print(table.groupby("kind")[["ref", "got", "bad_ticks"]].sum().to_string())
    print(f"  level mismatches   {mismatched_ticks} ticks")
    print(f"  max |zmax| delta   {worst_z:.3e}  (cumsum reference vs Welford stream)")
    agree = int((table["ref"] == table["got"]).sum())
    print(f"  run verdicts agree {agree} / {len(table)}")
    detected = table.loc[table["kind"] != "normal"].groupby("kind")["got"].sum()
    print("\n  alarms raised per shape (out of {} seeds):".format(seeds))
    for kind, count in detected.items():
        print(f"    {kind:<9} {int(count)}")
    print(f"    {'normal':<9} {int(table.loc[table['kind'] == 'normal', 'got'].sum())}  <- want 0")
    return 0 if mismatched_ticks == 0 and agree == len(table) else 1


# --------------------------------------------------------------------------- #
# Mode 2: real TEP runs vs the notebook cache
# --------------------------------------------------------------------------- #


def sensor_columns(columns) -> list[str]:
    return [c for c in columns if str(c).startswith("xmeas_") or str(c).startswith("xmv_")]


def iter_runs(
    path: Path, limit: int, stride: int = 1, chunksize: int = 200_000
) -> Iterator[tuple[tuple, pd.DataFrame]]:
    """Yield whole runs from a cache CSV without loading the file.

    The caches are already sorted by run, so a group is complete as soon as the
    next key appears. `stride` takes every Nth run; the faulty cache is ordered by
    faultNumber, so stride 50 lands on a different IDV every time.
    """
    header = pd.read_csv(path, nrows=0)
    sensors = sensor_columns(header.columns)
    usecols = RUN_KEYS + ["sample", "fault_status"] + sensors
    pending: pd.DataFrame | None = None
    seen = 0
    emitted = 0

    def take(key, group) -> Iterator[tuple[tuple, pd.DataFrame]]:
        nonlocal seen, emitted
        if seen % max(1, stride) == 0:
            emitted += 1
            yield tuple(key), group.sort_values("sample")
        seen += 1

    for chunk in pd.read_csv(path, usecols=usecols, chunksize=chunksize):
        frame = chunk if pending is None else pd.concat([pending, chunk], ignore_index=True)
        groups = list(frame.groupby(RUN_KEYS, sort=False))
        pending = groups[-1][1] if groups else None
        for key, group in groups[:-1]:
            yield from take(key, group)
            if emitted >= limit:
                return
    if pending is not None and emitted < limit:
        yield from take(tuple(pending[RUN_KEYS].iloc[0]), pending)


def rates(table: pd.DataFrame) -> dict[str, float]:
    faulty = table.loc[table["csv_status"] == "faulty"]
    normal = table.loc[table["csv_status"] == "normal"]
    tpr = float(faulty["alarm"].mean()) if len(faulty) else float("nan")
    fpr = float(normal["alarm"].mean()) if len(normal) else float("nan")
    return {"TPR": tpr, "FPR": fpr, "Youden": tpr - fpr, "n_faulty": len(faulty), "n_normal": len(normal)}


def mode_frames(runs: int, stride: int, verbose: bool) -> int:
    missing = [p for p in (CACHE_NORMAL, CACHE_FAULTY) if not p.is_file()]
    if missing:
        print("missing v6 caches, run notebook section 1 first:")
        for path in missing:
            print(f"  {path}")
        return 2

    per_frame = max(1, runs // 2)
    rows: list[dict] = []
    non_finite = 0
    mismatched_ticks = 0
    worst_z = 0.0

    for path in (CACHE_NORMAL, CACHE_FAULTY):
        for i, (key, group) in enumerate(iter_runs(path, per_frame, stride), start=1):
            sensors = sensor_columns(group.columns)
            X = group[sensors].to_numpy(np.float64)
            non_finite += int(np.sum(~np.isfinite(X)))
            ref_level, ref_zmax = notebook_levels(X)
            got_level, got_zmax = streaming_levels(X, sensors)
            bad = int(np.sum(ref_level != got_level))
            mismatched_ticks += bad
            both = np.isfinite(ref_zmax) & np.isfinite(got_zmax)
            if both.any():
                worst_z = max(worst_z, float(np.max(np.abs(ref_zmax[both] - got_zmax[both]))))
            rows.append(
                {
                    "source": str(key[0]),
                    "IDV": int(key[1]),
                    "run": int(key[2]),
                    "csv_status": str(group["fault_status"].iloc[0]),
                    "samples": len(group),
                    "bad_ticks": bad,
                    **summarize(got_level),
                }
            )
            if verbose and (i == 1 or i % 20 == 0):
                print(f"  scored {path.name} run {i}/{per_frame}")

    table = pd.DataFrame(rows)
    print(f"\nTEP runs scored     {len(table)}  ({table['samples'].sum():,} samples)")
    print(f"non-finite cells    {non_finite}")
    print(f"level mismatches    {mismatched_ticks} ticks  (streaming vs notebook kernel)")
    print(f"max |zmax| delta    {worst_z:.3e}")

    mine = rates(table)
    print(f"\nstreaming detector  TPR={mine['TPR']:.3f}  FPR={mine['FPR']:.3f}  "
          f"(faulty={mine['n_faulty']}, normal={mine['n_normal']})")

    agreed = compare_to_notebook_cache(table, verbose)
    ok = mismatched_ticks == 0 and agreed is not False
    return 0 if ok else 1


def compare_to_notebook_cache(table: pd.DataFrame, verbose: bool) -> bool | None:
    """Join per-run summaries against the notebook's own zscore_k6 output."""
    if not NOTEBOOK_RESULTS.is_file():
        print(f"\nno notebook cache at {NOTEBOOK_RESULTS.name}, skipping cross-check")
        return None
    cache = pd.read_csv(NOTEBOOK_RESULTS)
    cache = cache.loc[cache["method"] == "zscore_k6"].copy()
    if cache.empty:
        print("\nnotebook cache has no zscore_k6 rows, skipping cross-check")
        return None

    print(f"\nnotebook cache      {len(cache)} runs  "
          f"TPR={rates(cache)['TPR']:.3f}  FPR={rates(cache)['FPR']:.3f}")

    keys = ["source", "IDV", "run"]
    merged = table.merge(cache, on=keys, how="inner", suffixes=("_mine", "_nb"))
    if merged.empty:
        print("  no overlapping runs to compare")
        return None

    bad = pd.Series(False, index=merged.index)
    for column in SUMMARY_COLS:
        bad |= merged[f"{column}_mine"] != merged[f"{column}_nb"]
    n_bad = int(bad.sum())
    print(f"  overlap {len(merged)} runs, per-run summary mismatches: {n_bad}")
    if n_bad:
        cols = keys + ["csv_status_mine"] + [f"{c}_{s}" for c in SUMMARY_COLS for s in ("mine", "nb")]
        print(merged.loc[bad, cols].head(12).to_string(index=False))
    elif verbose:
        print(merged[keys + ["csv_status_mine", "n_yellow_mine", "n_red_mine", "alarm_mine"]].head(10).to_string(index=False))
    return n_bad == 0


# --------------------------------------------------------------------------- #
# Mode 3: replay any CSV
# --------------------------------------------------------------------------- #


def mode_csv(path: Path, x_column: str, limit: int) -> int:
    if not path.is_file():
        print(f"no such file: {path}")
        return 2
    frame = pd.read_csv(path, nrows=limit if limit > 0 else None)
    numeric = [
        c
        for c in frame.columns
        if c != x_column and pd.api.types.is_numeric_dtype(frame[c])
    ]
    if not numeric:
        print(f"no numeric columns in {path.name}")
        return 2

    detector = ZScoreDetector()
    print(f"{path.name}: {len(frame)} rows x {len(numeric)} numeric columns, "
          f"k={detector.k} yellow={detector.yellow_z:g} red={detector.red_z:g} "
          f"burn_in={detector.burn_in}")
    alerts = 0
    counts = {"normal": 0, "yellow": 0, "red": 0}
    for i, row in enumerate(frame[numeric].to_numpy(np.float64), start=1):
        verdict = detector.step(dict(zip(numeric, (float(v) for v in row))))
        counts[verdict.label] += 1
        if verdict.rising:
            alerts += 1
            hot = verdict.hot_channels(detector.yellow_z)[:3]
            names = ", ".join(f"{c.field_id} |z|={c.abs_z:.1f}" for c in hot) or "none"
            print(f"  {verdict.label:<6} sample {i:>6}  max|z|={verdict.z_max:6.2f}  {names}")
    print(f"\n  alerts opened {alerts}   samples normal={counts['normal']} "
          f"yellow={counts['yellow']} red={counts['red']}")
    print(f"  verdict: {'FAULTY' if alerts else 'normal'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval.score", description=__doc__)
    sub = parser.add_subparsers(dest="mode")

    p_parity = sub.add_parser("parity", help="synthetic streaming-vs-notebook check")
    p_parity.add_argument("--seeds", type=int, default=12)
    p_parity.add_argument("-v", "--verbose", action="store_true")

    p_frames = sub.add_parser("frames", help="real TEP runs, TPR/FPR, notebook cross-check")
    p_frames.add_argument("--runs", type=int, default=60, help="total runs, split over both caches")
    p_frames.add_argument(
        "--stride", type=int, default=1, help="take every Nth run; 50 spreads over all 20 IDVs"
    )
    p_frames.add_argument("-v", "--verbose", action="store_true")

    p_csv = sub.add_parser("csv", help="replay one CSV and print its alert timeline")
    p_csv.add_argument("path", type=Path)
    p_csv.add_argument("--x-column", default="")
    p_csv.add_argument("--limit", type=int, default=0)

    args = parser.parse_args(argv)
    if args.mode == "frames":
        return mode_frames(args.runs, args.stride, args.verbose)
    if args.mode == "csv":
        return mode_csv(args.path, args.x_column, args.limit)
    return mode_parity(getattr(args, "seeds", 12), getattr(args, "verbose", False))


if __name__ == "__main__":
    sys.exit(main())
