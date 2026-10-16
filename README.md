# Trustworthy process monitor

FastAPI is the compute plane (raw data stays there). Next.js is the reasoning plane (LLM sees artifacts only).

First time: `cd backend && uv sync`, then `cd frontend && npm install`. Copy `frontend/.env.example` to `frontend/.env`.

**Backend** (from `backend/`):

```bash
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 2
```

Keep `--timeout-graceful-shutdown 2`. Without it, `--reload` hangs on "Waiting for connections to close" whenever a browser tab holds the SSE streams open.

**Frontend** (from `frontend/`):

```bash
npm run dev
```

The backend emits a rolling unlabeled data-source stream while it runs. Manage sources on the Data page — same pipeline code, different CSV pointer.

Alerts come from the v6 rolling z-score (`zscore_k6_level` in `data_processing/v6_normal_faulty_frames.ipynb`): each channel is studentized against its own expanding mean and sd, and yellow/red need 6 consecutive samples past 4 / 6 sigma. See `backend/README.md` for the rule and the checks that keep the streaming port honest.

Two demo CSVs to point a source at, cut from real TEP runs with the labels dropped:

```bash
cd backend && uv run python -m eval.make_demo_csv
```

`demo_faulty_run.csv` goes yellow at sample 169 and red at 174; `demo_normal_run.csv` stays silent. Set the x-axis to `sample`.

A stream plays to end of file and stops there rather than looping, because the detector's expanding statistics treat the whole replay as one run. Press play again to start the run over with a fresh detector.
