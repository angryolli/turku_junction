"use client";

import { useEffect, useMemo, useState } from "react";
import { alarmsOldestFirst } from "@/components/monitor-panes";
import { browserGet, type SimulationRunDetail, type SimulationRunSummary } from "@/lib/browser-api";

function fmtTime(value: string) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function PastRunsView() {
  const [runs, setRuns] = useState<SimulationRunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SimulationRunDetail | null>(null);

  useEffect(() => {
    void browserGet<SimulationRunSummary[]>("/simulation/runs")
      .then((rows) => setRuns(rows))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void browserGet<SimulationRunDetail>(`/simulation/runs/${selected}`)
      .then((row) => setDetail(row))
      .catch(() => setDetail(null));
  }, [selected]);

  const archivedAlarms = useMemo(
    () => (detail ? alarmsOldestFirst(detail.alarms) : []),
    [detail],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h2 className="text-sm font-medium">Past simulations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each reset archives the current alarm log and decision log here.
        </p>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived runs yet.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelected(run.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                    selected === run.id
                      ? "border-foreground/30 bg-secondary"
                      : "border-border hover:border-foreground/20"
                  }`}
                >
                  <p className="font-mono">{run.id}</p>
                  <p className="text-muted-foreground">{fmtTime(run.ended_at)}</p>
                  <p className="text-muted-foreground">
                    tick {run.tick} · {run.alarm_count} alarms · {run.decision_count} decisions
                  </p>
                </button>
              </li>
            ))}
          </ul>
          {detail && (
            <div className="space-y-4 rounded-xl border border-border bg-card p-4">
              <div>
                <p className="font-mono text-xs">{detail.id}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {fmtTime(detail.started_at)} → {fmtTime(detail.ended_at)} · tick {detail.tick}
                  {detail.finished ? " · finished" : ""}
                </p>
              </div>
              {detail.sources.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Sources
                  </h3>
                  <ul className="space-y-1 font-mono text-xs text-muted-foreground">
                    {detail.sources.map((source) => (
                      <li key={`${source.id}-${source.file_path}`}>
                        {source.name || source.id} · {source.file_path || "file"} · x=
                        {source.x_column || "—"} · {(source.y_columns ?? []).length} channels
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-sm font-medium">Alarm log</h3>
                <ul className="space-y-2 font-mono text-xs">
                  {archivedAlarms.map((row) => (
                    <li key={`${row.id}-${row.tick}`} className="rounded-md border border-border p-3">
                      <p>
                        {row.id} · {row.level} · tick {row.tick} · z {row.z.toFixed(2)}
                        {row.reason ? ` · ${row.reason}` : ""}
                      </p>
                      <p className="text-muted-foreground">{row.evidence}</p>
                    </li>
                  ))}
                  {archivedAlarms.length === 0 && (
                    <li className="text-muted-foreground">No alarms archived.</li>
                  )}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Decision log</h3>
                <ul className="space-y-2 font-mono text-xs">
                  {detail.decisions.map((entry, index) => (
                    <li key={`${entry.ts}-${index}`} className="rounded-md border border-border p-3">
                      <p>
                        {entry.ts} · {entry.type}
                        {entry.human_overridden ? " · human" : ""}
                      </p>
                      <p className="text-muted-foreground">{entry.evidence_ref}</p>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                        {JSON.stringify(entry.payload)}
                      </pre>
                    </li>
                  ))}
                  {detail.decisions.length === 0 && (
                    <li className="text-muted-foreground">No decisions archived.</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
