"""End-to-end check of the live path: CSV on disk -> replay -> detector -> HTTP.

    uv run python -m eval.integration

Drives the real `AppState` and the real FastAPI app against an isolated sqlite
file, so it never touches the dev database. Ticks are pumped synchronously rather
than waiting on STREAM_TICK_SECONDS, so 960 samples take about a second.

Asserts the two things that matter: the faulty demo run raises yellow then red
shortly after fault onset, the clean run stays silent for its whole length, and
every payload the frontend reads still carries the keys it reads.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from app.storage.artifact_store import ArtifactStore

SOURCES = Path(__file__).resolve().parents[1] / "data" / "sources"
FAULTY = SOURCES / "demo_faulty_run.csv"
NORMAL = SOURCES / "demo_normal_run.csv"

# TEP test runs introduce the fault at sample 160. k=6 consecutive hot samples
# after that, so an honest detector cannot speak before 166.
FAULT_ONSET = 160
ONSET_TOLERANCE = 80


async def asgi(app, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
    """Call the ASGI app once and decode the JSON response."""
    payload = b"" if body is None else json.dumps(body).encode()
    headers = [(b"host", b"test"), (b"accept", b"application/json")]
    if body is not None:
        headers += [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode()),
        ]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("test", 1),
        "server": ("test", 80),
    }
    messages: list[dict] = []
    delivered = False

    async def receive() -> dict:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message: dict) -> None:
        messages.append(message)

    await app(scope, receive, send)
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, (json.loads(raw) if raw else None)


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def ok(self, label: str, condition: bool, detail: str = "") -> None:
        mark = "ok  " if condition else "FAIL"
        print(f"  [{mark}] {label}{f'  — {detail}' if detail else ''}")
        if not condition:
            self.failures.append(label)

    def require(self, label: str, payload: object, keys: list[str]) -> None:
        if not isinstance(payload, dict):
            self.ok(label, False, f"not an object: {type(payload).__name__}")
            return
        missing = [k for k in keys if k not in payload]
        self.ok(label, not missing, "missing " + ", ".join(missing) if missing else "")


def sensor_columns(path: Path) -> tuple[str, list[str]]:
    header = path.read_text(encoding="utf-8").split("\n", 1)[0].strip().split(",")
    columns = [c.strip() for c in header]
    return columns[0], columns[1:]


async def replay(state, app, path: Path, ticks: int, label: str, checks: Checks) -> list[dict]:
    """Add one CSV as a file source, pump `ticks` samples, return the signals raised."""
    state.reset_simulation()
    for source in state.list_data_sources():
        state.remove_data_source(source.id)
    state.engine.reset()

    x_column, y_columns = sensor_columns(path)
    source = state.add_file_source(str(path), x_column, y_columns)
    state.set_playing(True)
    print(f"\n{label}: {path.name} as source '{source.id}', "
          f"x={x_column}, {len(y_columns)} channels")

    # Overshoot the file so end-of-file handling is exercised, not just the last row.
    for _ in range(ticks + 40):
        state.tick_live()

    status, diagnosis = await asgi(app, "GET", "/diagnosis")
    checks.ok(f"{label}: /diagnosis 200", status == 200, f"got {status}")
    signals = diagnosis["signals"] if isinstance(diagnosis, dict) else []
    current = diagnosis["current"] if isinstance(diagnosis, dict) else {}
    print(f"  ticks pumped {ticks}, engine samples {current.get('n')}, "
          f"level {current.get('level')}, max|z| {current.get('z')}")
    return signals


async def main() -> int:
    missing = [p for p in (FAULTY, NORMAL) if not p.is_file()]
    if missing:
        print("missing demo CSVs. Run: uv run python -m eval.make_demo_csv")
        for path in missing:
            print(f"  {path}")
        return 2

    import app.main as main_module

    app = main_module.app
    state = main_module.STATE
    checks = Checks()

    with tempfile.TemporaryDirectory() as tmp:
        state.store = ArtifactStore(path=Path(tmp) / "integration.sqlite")
        state.boot()

        # ---------- faulty run: must escalate, and only after the fault ----------
        signals = await replay(state, app, FAULTY, 960, "faulty", checks)
        levels = [s["level"] for s in signals]
        first = min((s["tick"] for s in signals), default=0)
        checks.ok("faulty: raised at least one alert", bool(signals), f"{len(signals)} signals")
        checks.ok("faulty: reached yellow", "yellow" in levels, f"levels={sorted(set(levels))}")
        checks.ok("faulty: escalated to red", "red" in levels)
        checks.ok(
            "faulty: first alert near fault onset",
            bool(signals) and FAULT_ONSET <= first <= FAULT_ONSET + ONSET_TOLERANCE,
            f"first alert at sample {first}, onset {FAULT_ONSET}",
        )
        for signal in signals[:3]:
            print(f"    {signal['level']:<6} tick {signal['tick']:>4}  z={signal['z']}  "
                  f"{signal['evidence'][:96]}")

        newest = signals[0] if signals else {}
        checks.require(
            "faulty: signal keys the UI reads",
            newest,
            ["id", "tick", "level", "score", "z", "top_fields", "evidence", "created_at"],
        )
        contributor = (newest.get("top_fields") or [{}])[0]
        checks.require(
            "faulty: contributor keys the UI reads",
            contributor,
            ["field_id", "score", "mean", "sd", "skew", "kurt", "n"],
        )

        status, diagnosis = await asgi(app, "GET", "/diagnosis")
        checks.require(
            "faulty: current snapshot keys",
            diagnosis.get("current"),
            ["tick", "n", "score", "z", "calibrated", "level", "k", "z_yellow", "z_red", "burn_in"],
        )
        checks.ok("faulty: reports calibrated", bool(diagnosis["current"]["calibrated"]))

        status, monitor = await asgi(app, "GET", "/monitor/snapshot")
        checks.ok("faulty: /monitor/snapshot 200", status == 200, f"got {status}")
        checks.require("faulty: monitor keys", monitor, ["tick", "playing", "fields", "dataset_id"])
        card = (monitor.get("fields") or [{}])[0]
        checks.require(
            "faulty: field card keys",
            card,
            ["field_id", "sparkline", "status", "contribution", "evidence", "source_file", "source_id"],
        )
        chips = {c["status"] for c in monitor["fields"]}
        checks.ok("faulty: chips are valid levels", chips <= {"normal", "yellow", "red"}, str(chips))

        status, config = await asgi(app, "GET", "/config")
        checks.ok("faulty: /config baseline_established", bool(config["baseline_established"]))

        status, events = await asgi(app, "GET", "/events")
        checks.ok("faulty: /events mirrors /diagnosis", status == 200 and "signals" in events)

        # ---------- end of file stops the stream, it does not loop ----------
        n_at_eof = diagnosis["current"]["n"]
        checks.ok(
            "eof: consumed the file exactly once",
            n_at_eof == 960,
            f"engine saw {n_at_eof} samples from a 960-row file",
        )
        checks.ok("eof: stream auto-paused", state.finished() and not state.playing)
        status, monitor = await asgi(app, "GET", "/monitor/snapshot")
        checks.ok("eof: snapshot reports paused", monitor["playing"] is False)
        checks.ok("eof: tick parked at the last row", monitor["tick"] == 960, f"tick {monitor['tick']}")

        before = len(diagnosis["signals"])
        status, monitor = await asgi(app, "POST", "/stream/control", {"playing": True})
        checks.ok(
            "eof: play refused until reset",
            monitor["playing"] is False and monitor.get("finished") is True,
            f"playing={monitor.get('playing')} finished={monitor.get('finished')} tick={monitor.get('tick')}",
        )
        checks.ok("eof: play does not rewind", monitor["tick"] == 960, f"tick {monitor['tick']}")

        status, reset_body = await asgi(app, "POST", "/stream/reset", {})
        monitor = reset_body["snapshot"] if isinstance(reset_body, dict) else reset_body
        checks.ok("eof: reset archives the finished run", bool(reset_body.get("archived_run_id")))
        checks.ok("eof: reset parks at tick 0", monitor["tick"] == 0, f"tick {monitor['tick']}")
        checks.ok("eof: reset clears finished", monitor.get("finished") is False)
        status, monitor = await asgi(app, "POST", "/stream/control", {"playing": True})
        checks.ok("eof: play after reset starts from the top", monitor["tick"] == 0, f"tick {monitor['tick']}")
        status, diagnosis = await asgi(app, "GET", "/diagnosis")
        checks.ok(
            "eof: reset clears the old run",
            diagnosis["signals"] == [] and not diagnosis["current"]["calibrated"],
            f"had {before} signals before reset",
        )

        # ---------- clean run: must stay silent for its whole length ----------
        quiet = await replay(state, app, NORMAL, 960, "normal", checks)
        checks.ok(
            "normal: no alerts over 960 samples",
            not quiet,
            f"{len(quiet)} unexpected signals" if quiet else "",
        )
        for signal in quiet[:3]:
            print(f"    unexpected {signal['level']} at tick {signal['tick']}: {signal['evidence'][:96]}")

        # ---------- reset must clear the detector and the signal table ----------
        state.reset_simulation()
        status, diagnosis = await asgi(app, "GET", "/diagnosis")
        checks.ok("reset: signal table cleared", diagnosis["signals"] == [])
        checks.ok("reset: detector back to burn-in", not diagnosis["current"]["calibrated"])
        checks.ok("reset: level back to normal", diagnosis["current"]["level"] == "normal")

        for source in state.list_data_sources():
            state.remove_data_source(source.id)

    print()
    if checks.failures:
        print(f"{len(checks.failures)} check(s) failed:")
        for name in checks.failures:
            print(f"  - {name}")
        return 1
    print("all integration checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
