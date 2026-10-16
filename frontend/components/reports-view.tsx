"use client";

import { useEffect, useState } from "react";
import { browserGet, eventsStreamUrl, type SimulationRunSummary } from "@/lib/browser-api";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";
import { useSimulation } from "@/components/simulation-context";

export function ReportsView() {
  const { resetRevision } = useSimulation();
  const [signals, setSignals] = useState<DiagnosisSignal[]>([]);
  const [runs, setRuns] = useState<SimulationRunSummary[]>([]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: DiagnosisSnapshot) {
      if (!on) return;
      setSignals(data.signals ?? data.events ?? []);
    }

    function connect() {
      source?.close();
      source = new EventSource(eventsStreamUrl());
      source.addEventListener("events", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as DiagnosisSnapshot);
        } catch {
          /* ignore */
        }
      });
    }

    connect();
    void browserGet<SimulationRunSummary[]>("/simulation/runs")
      .then((rows) => {
        if (on) setRuns(rows);
      })
      .catch(() => {
        if (on) setRuns([]);
      });
    return () => {
      on = false;
      source?.close();
    };
  }, [resetRevision]);

  const ordered = [...signals].sort((a, b) => a.tick - b.tick || a.created_at.localeCompare(b.created_at));

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-6 overflow-y-auto p-4">
      <section>
        <h1 className="mb-1 text-lg font-medium">Alerts</h1>
        <p className="mb-3 text-sm text-muted-foreground">
          Each row is the moment a ward’s resistance rate moved further from its annual baseline. The same cell does
          not raise a new alert on the following day.
        </p>
        <ul className="space-y-2 text-sm">
          {ordered.length === 0 && (
            <li className="rounded-lg border border-border p-3 text-muted-foreground">No alerts in this replay.</li>
          )}
          {ordered.map((row) => (
            <li key={row.id} className="rounded-lg border border-border p-3">
              <p className="mb-1 font-mono text-xs text-muted-foreground">
                {row.id} · {row.level} · day {row.tick}
                {row.reason ? ` · ${row.reason}` : ""}
              </p>
              <p>{row.evidence}</p>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Archived replays</h2>
        <ul className="space-y-2 text-sm">
          {runs.length === 0 && <li className="text-muted-foreground">Reset archives the current alert log here.</li>}
          {runs.map((run) => (
            <li key={run.id} className="rounded-lg border border-border p-3 font-mono text-xs">
              {run.id} · {run.alarm_count} alerts · tick {run.tick}
              {run.finished ? " · finished" : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
