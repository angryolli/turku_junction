"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusChip } from "@/components/status-chip";
import {
  browserGet,
  eventsStreamUrl,
  monitorStreamUrl,
  type Chip,
  type MonitorSnapshot,
  type RateCard,
  type SimulationRunSummary,
} from "@/lib/browser-api";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";
import { useSimulation } from "@/components/simulation-context";
import { cn } from "@/lib/utils";

type SortDir = "asc" | "desc";

type LogRow = {
  id: string;
  tick: number;
  date: string;
  level: Chip;
  ward: string;
  organism: string;
  drug: string;
  z: number;
  direction: string;
  evidence: string;
};

function pct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function parseLog(row: DiagnosisSignal): LogRow {
  const field = row.top_fields?.[0]?.field_id ?? "";
  const [ward = "", organism = "", drug = ""] = field.split(" · ");
  const level: Chip = row.level === "red" ? "red" : "yellow";
  return {
    id: row.id,
    tick: row.tick,
    date: row.evidence.slice(0, 10),
    level,
    ward,
    organism,
    drug,
    z: row.z,
    direction: row.reason || "",
    evidence: row.evidence,
  };
}

function matches(query: string, parts: Array<string | number>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join(" ").toLowerCase().includes(needle);
}

function compare(a: unknown, b: unknown, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a ?? "").localeCompare(String(b ?? "")) * factor;
}

export function ReportsView() {
  const { resetRevision } = useSimulation();
  const [signals, setSignals] = useState<DiagnosisSignal[]>([]);
  const [openAlerts, setOpenAlerts] = useState<RateCard[]>([]);
  const [runs, setRuns] = useState<SimulationRunSummary[]>([]);
  const [query, setQuery] = useState("");
  const [openSort, setOpenSort] = useState<{ key: keyof RateCard; dir: SortDir }>({ key: "z", dir: "desc" });
  const [logSort, setLogSort] = useState<{ key: keyof LogRow; dir: SortDir }>({ key: "tick", dir: "desc" });

  useEffect(() => {
    let on = true;
    let events: EventSource | null = null;
    let monitor: EventSource | null = null;

    function connect() {
      events?.close();
      monitor?.close();
      events = new EventSource(eventsStreamUrl());
      events.addEventListener("events", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as DiagnosisSnapshot;
          if (on) setSignals(data.signals ?? data.events ?? []);
        } catch {
          /* ignore */
        }
      });
      monitor = new EventSource(monitorStreamUrl());
      monitor.addEventListener("snapshot", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot;
          if (on) setOpenAlerts(data.open_alerts ?? []);
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
      events?.close();
      monitor?.close();
    };
  }, [resetRevision]);

  const openRows = useMemo(() => {
    const filtered = openAlerts.filter((row) =>
      matches(query, [row.ward_code, row.ward_en, row.organism, row.antibiotic, row.antibiotic_code, row.level, row.direction]),
    );
    const { key, dir } = openSort;
    return [...filtered].sort((a, b) => compare(a[key] ?? "", b[key] ?? "", dir));
  }, [openAlerts, openSort, query]);

  const logRows = useMemo(() => {
    const parsed = signals.map(parseLog).filter((row) =>
      matches(query, [row.id, row.date, row.level, row.ward, row.organism, row.drug, row.direction, row.evidence]),
    );
    const { key, dir } = logSort;
    return [...parsed].sort((a, b) => compare(a[key], b[key], dir));
  }, [logSort, query, signals]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-4 overflow-hidden p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Alerts</h1>
          <p className="text-sm text-muted-foreground">
            Open rows are rates that are off their annual baseline right now. The log is each time a rate crossed further away.
          </p>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ward, organism, drug…"
          className="h-8 w-64 rounded-md border border-input bg-background px-2 font-mono text-xs"
        />
      </header>

      <DataTable
        title={`Open now · ${openRows.length}`}
        columns={[
          ["ward_code", "Ward"],
          ["organism", "Organism"],
          ["antibiotic_code", "Drug"],
          ["pct_4w", "4 weeks"],
          ["n_4w", "n"],
          ["pct_year", "Annual"],
          ["n_year", "n"],
          ["z", "z"],
          ["direction", "Direction"],
          ["level", "Level"],
        ]}
        sort={openSort}
        onSort={(key) =>
          setOpenSort((current) => ({
            key,
            dir: current.key === key && current.dir === "asc" ? "desc" : "asc",
          }))
        }
        empty="No open deviations."
      >
        {openRows.map((row) => (
          <tr key={`${row.ward_code}-${row.organism}-${row.antibiotic_code}`} className="border-t border-border">
            <td className="px-3 py-1.5 font-mono">{row.ward_code}</td>
            <td className="px-3 py-1.5">{row.organism}</td>
            <td className="px-3 py-1.5 font-mono">{row.antibiotic_code}</td>
            <td className="px-3 py-1.5 font-mono">{pct(row.pct_4w)}</td>
            <td className="px-3 py-1.5 font-mono text-muted-foreground">{row.n_4w}</td>
            <td className="px-3 py-1.5 font-mono">{pct(row.pct_year)}</td>
            <td className="px-3 py-1.5 font-mono text-muted-foreground">{row.n_year}</td>
            <td className="px-3 py-1.5 font-mono">{row.z == null ? "—" : row.z.toFixed(2)}</td>
            <td className="px-3 py-1.5">{row.direction === "up" ? "up" : row.direction === "down" ? "down" : "—"}</td>
            <td className="px-3 py-1.5">
              <StatusChip status={row.level} />
            </td>
          </tr>
        ))}
      </DataTable>

      <DataTable
        title={`Log · ${logRows.length}`}
        columns={[
          ["tick", "Day"],
          ["date", "Date"],
          ["level", "Level"],
          ["ward", "Ward"],
          ["organism", "Organism"],
          ["drug", "Drug"],
          ["z", "z"],
          ["direction", "Direction"],
        ]}
        sort={logSort}
        onSort={(key) =>
          setLogSort((current) => ({
            key,
            dir: current.key === key && current.dir === "asc" ? "desc" : "asc",
          }))
        }
        empty="No alerts in this replay."
      >
        {logRows.map((row) => (
          <tr key={row.id} className="border-t border-border" title={row.evidence}>
            <td className="px-3 py-1.5 font-mono">{row.tick}</td>
            <td className="px-3 py-1.5 font-mono">{row.date}</td>
            <td className="px-3 py-1.5">
              <StatusChip status={row.level} />
            </td>
            <td className="px-3 py-1.5 font-mono">{row.ward}</td>
            <td className="px-3 py-1.5">{row.organism}</td>
            <td className="px-3 py-1.5 font-mono">{row.drug}</td>
            <td className="px-3 py-1.5 font-mono">{row.z.toFixed(2)}</td>
            <td className="px-3 py-1.5">{row.direction.replace("resistance ", "")}</td>
          </tr>
        ))}
      </DataTable>

      {runs.length > 0 && (
        <p className="font-mono text-xs text-muted-foreground">
          Archived replays: {runs.map((run) => `${run.id} (${run.alarm_count})`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function DataTable<Key extends string>({
  title,
  columns,
  sort,
  onSort,
  empty,
  children,
}: {
  title: string;
  columns: Array<[Key, string]>;
  sort: { key: Key; dir: SortDir };
  onSort: (key: Key) => void;
  empty: string;
  children: ReactNode;
}) {
  const count = Array.isArray(children) ? children.length : 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
      <h2 className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">{title}</h2>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} className="px-3 py-2 font-medium">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(key)}>
                    {label}
                    <span
                      aria-hidden
                      className={cn("font-mono", sort.key === key ? "text-foreground" : "opacity-0")}
                    >
                      {sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {count === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-muted-foreground">
                  {empty}
                </td>
              </tr>
            )}
            {children}
          </tbody>
        </table>
      </div>
    </section>
  );
}
