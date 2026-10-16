"use client";

import { useEffect, useRef, useState } from "react";
import { StatusChip } from "@/components/status-chip";
import { monitorStreamUrl, type MonitorSnapshot, type RateCard } from "@/lib/browser-api";
import { useSimulation } from "@/components/simulation-context";

function pct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function AlertRow({ row }: { row: RateCard }) {
  const movement = row.direction === "up" ? "resistance up" : row.direction === "down" ? "resistance down" : "";
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm">
          {row.ward_en} · {row.organism}
        </p>
        <StatusChip status={row.level} />
      </div>
      <p className="text-sm text-muted-foreground">
        {row.antibiotic} ({row.antibiotic_code}) · four weeks {pct(row.pct_4w)} of {row.n_4w} · annual{" "}
        {pct(row.pct_year)} of {row.n_year}
        {row.z != null ? ` · z ${row.z.toFixed(2)}` : ""}
        {movement ? ` · ${movement}` : ""}
      </p>
    </li>
  );
}

export function DashboardView() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const { playing, finished, resetRevision } = useSimulation();
  const key = useRef("");

  useEffect(() => {
    setSnap(null);
    key.current = "";
  }, [resetRevision]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: MonitorSnapshot) {
      if (!on) return;
      const next = `${data.tick}:${data.as_of}:${data.open_alerts.length}:${data.playing}`;
      if (next === key.current) return;
      key.current = next;
      setSnap(data);
    }

    function connect() {
      source?.close();
      source = new EventSource(monitorStreamUrl());
      source.addEventListener("snapshot", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot);
        } catch {
          /* ignore */
        }
      });
    }

    function onVis() {
      if (document.hidden) {
        source?.close();
        source = null;
        return;
      }
      connect();
    }

    connect();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      on = false;
      document.removeEventListener("visibilitychange", onVis);
      source?.close();
    };
  }, []);

  const asOf = snap?.as_of;
  const alerts = snap?.open_alerts ?? [];

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4 overflow-y-auto p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Ward susceptibility</h1>
          <p className="text-sm text-muted-foreground">
            {asOf
              ? `Lab day ${asOf}`
              : `Press play. Cultures run ${snap?.date_start ?? "2023-10-02"} to ${snap?.date_end ?? "2026-09-27"}.`}
            {playing ? " · playing" : finished ? " · replay finished" : ""}
          </p>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">{snap?.evidence}</p>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(snap?.wards ?? []).map((ward) => (
          <div key={ward.ward_code} className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm">{ward.ward_en}</p>
              <StatusChip status={ward.status} />
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {ward.ward_code} · {ward.ward_type === "in" ? "inpatient" : "outpatient"} · {ward.n_hot} open
            </p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Open deviations</h2>
        {alerts.length === 0 ? (
          <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
            No ward is far enough from its annual baseline. A rate is shown only after 30 isolates in both windows.
          </p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((row) => (
              <AlertRow
                key={`${row.ward_code}-${row.organism}-${row.antibiotic_code}`}
                row={row}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
