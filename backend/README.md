# Compute plane

Raw rows stay here. The reasoning plane only ever reads the derived artifacts this
service publishes.

## The detector

`app/inference/zscore.py` is the v6 rolling z-score from
`data_processing/v6_normal_faulty_frames.ipynb` (§5, `zscore_k6_level`), rewritten
to run one sample at a time.

Each channel is studentized against its own expanding mean and sd over every
earlier sample in the run:

```
z_t = (x_t - mean_{t-1}) / max(sd_{t-1}, floor)
```

A sample is *hot* when any channel reaches `|z| >= 4`. **Yellow** needs the last
`k = 6` samples all hot; **red** needs the last `k` samples all at `|z| >= 6`. Red
replaces yellow, and nothing fires in the first 20 samples. A single spike
therefore never raises an alert — an alert always means a sustained excursion.

The notebook scores a finished run with cumulative-sum numpy. Here the same
recursion runs over Welford accumulators, so the detector holds four floats per
channel and never retains a raw row. Welford replaces `cumsum` (same quantity,
without the cancellation that hurts a long stream), and a non-finite sample is
skipped rather than poisoning that channel for the rest of the run.

A signal is written when the level *rises*, which is the transition the notebook's
`n_events` counts. `app/inference/pipeline.py` wraps the detector into the
`/diagnosis` and `/monitor/snapshot` payloads; a channel's `score` is its `|z|`.

The expanding statistics are what make the notebook's "this run only" rule work, so
a replay is one run: it plays to end of file and stops there instead of looping, and
`playing` goes false on its own. Pressing play again starts the run over with a
fresh detector, the same as `/stream/reset` followed by play. `max |z|` is pooled
across every channel of every active source, so several CSVs at once produce one
alert stream for the whole plant.

Override the gates with `ZSCORE_K`, `ZSCORE_YELLOW`, `ZSCORE_RED`, `ZSCORE_BURN_IN`.

Known blind spots, inherited from the rule itself: very slow drift (the expanding
sd absorbs it) and a frozen channel (`z = 0` while it is stuck). The notebook's
out-of-range and correlation detectors cover those, and are not wired in here.

## Run it

```bash
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 2
```

`--timeout-graceful-shutdown 2` is not optional in practice. Without it, `--reload`
deadlocks against the SSE endpoints: uvicorn waits for `/monitor/stream` and
`/events/stream` to finish, those generators run until the app signals shutdown,
and the app only signals shutdown after connections close. Every edit then parks
the server on "Waiting for connections to close" until you close the browser tab.

## Check it

```bash
# streaming detector vs the notebook kernel, synthetic, no data files needed
uv run python -m eval.score parity

# real TEP runs: parity, TPR/FPR, and a per-run cross-check against the
# notebook's own cache (v6_eval_oor_corr_v3.csv)
uv run python -m eval.score frames --runs 80 --stride 25

# cut demo CSVs out of the v6 caches, then replay one and print its alerts
uv run python -m eval.make_demo_csv
uv run python -m eval.score csv data/sources/demo_faulty_run.csv --x-column sample

# CSV -> replay -> detector -> HTTP, against an isolated sqlite file
uv run python -m eval.integration
```

`eval.score frames` is the load-bearing one: it compares `n_yellow`, `n_red`,
`events_yellow`, `events_red` and `alarm` per run against the notebook, so a drift
in the port shows up as a nonzero mismatch count rather than a plausible-looking
rate.
