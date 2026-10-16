"use client";

import { useEffect, useState } from "react";
import { StatusChip } from "@/components/status-chip";
import {
  browserGet,
  monitorStreamUrl,
  type AntibiogramResponse,
  type LabCatalog,
  type MonitorSnapshot,
  type RateCard,
} from "@/lib/browser-api";
import { RateChartModal } from "@/components/rate-chart-modal";
import { useSimulation } from "@/components/simulation-context";

function pct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function Spark({
  values,
  onClick,
}: {
  values: number[];
  onClick: (origin: { left: number; top: number; width: number; height: number }) => void;
}) {
  if (values.length < 1) return <span className="text-muted-foreground">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const d = values
    .map((value, index) => {
      const x = values.length === 1 ? 36 : (index / (values.length - 1)) * 72;
      const y = 18 - ((value - min) / span) * 16;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <button
      type="button"
      className="block rounded-sm hover:bg-muted"
      aria-label="Open rolling rate"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onClick({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }}
    >
      <svg viewBox="0 0 72 20" className="h-5 w-20 text-foreground">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

export function AntibiogramView() {
  const { resetRevision } = useSimulation();
  const [catalog, setCatalog] = useState<LabCatalog | null>(null);
  const [ward, setWard] = useState("all");
  const [specimen, setSpecimen] = useState("all");
  const [organism, setOrganism] = useState("all");
  const [sex, setSex] = useState("all");
  const [asOf, setAsOf] = useState<string | null>(null);
  const [rows, setRows] = useState<RateCard[]>([]);
  const [error, setError] = useState("");
  const [chart, setChart] = useState<{
    row: RateCard;
    origin: { left: number; top: number; width: number; height: number };
  } | null>(null);

  useEffect(() => {
    void browserGet<LabCatalog>("/catalog")
      .then(setCatalog)
      .catch(() => setError("Catalog unavailable"));
  }, []);

  useEffect(() => {
    setRows([]);
    setAsOf(null);
  }, [resetRevision]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function connect() {
      source?.close();
      source = new EventSource(monitorStreamUrl());
      source.addEventListener("snapshot", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot;
          if (on) setAsOf(data.as_of);
        } catch {
          /* ignore */
        }
      });
    }

    connect();
    return () => {
      on = false;
      source?.close();
    };
  }, [resetRevision]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (ward !== "all") params.set("ward", ward);
    if (specimen !== "all") params.set("specimen", specimen);
    if (organism !== "all") params.set("organism", organism);
    if (sex !== "all") params.set("sex", sex);
    const query = params.toString();
    void browserGet<AntibiogramResponse>(`/antibiogram${query ? `?${query}` : ""}`)
      .then((data) => {
        setRows(data.rows);
        setError("");
      })
      .catch((err: unknown) => {
        setRows([]);
        setError(err instanceof Error ? err.message : "Antibiogram unavailable");
      });
  }, [asOf, ward, specimen, organism, sex, resetRevision]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-3 overflow-hidden p-4">
      <header>
        <h1 className="text-lg font-medium">Antibiogram</h1>
        <p className="text-sm text-muted-foreground">
          {asOf ? `Through ${asOf}` : "Press play to move the lab day forward."} The percentage stays blank below 30
          isolates. The line still draws the four-week rate on those days. Click a line to expand it.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Filter label="Ward" value={ward} onChange={setWard} options={[
          ["all", "All wards"],
          ...(catalog?.wards ?? []).map((item) => [item.code, item.en] as [string, string]),
        ]} />
        <Filter label="Specimen" value={specimen} onChange={setSpecimen} options={[
          ["all", "All specimens"],
          ...(catalog?.specimens ?? []).map((item) => [item, item] as [string, string]),
        ]} />
        <Filter label="Organism" value={organism} onChange={setOrganism} options={[
          ["all", "All organisms"],
          ...(catalog?.organisms ?? []).map((item) => [item, item] as [string, string]),
        ]} />
        <Filter label="Sex" value={sex} onChange={setSex} options={[
          ["all", "All sexes"],
          ["F", "Female"],
          ["M", "Male"],
        ]} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Ward</th>
              <th className="px-3 py-2 font-medium">Organism</th>
              <th className="px-3 py-2 font-medium">Antibiotic</th>
              <th className="px-3 py-2 font-medium">4 weeks</th>
              <th className="px-3 py-2 font-medium">n</th>
              <th className="px-3 py-2 font-medium">Annual</th>
              <th className="px-3 py-2 font-medium">n</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-muted-foreground">
                  No tested isolates in this slice yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.ward_code}-${row.organism}-${row.antibiotic_code}`} className="border-t border-border">
                <td className="px-3 py-2">{row.ward_code}</td>
                <td className="px-3 py-2">{row.organism}</td>
                <td className="px-3 py-2">
                  {row.antibiotic} <span className="font-mono text-xs text-muted-foreground">{row.antibiotic_code}</span>
                </td>
                <td className="px-3 py-2 font-mono">{pct(row.pct_4w)}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{row.n_4w}</td>
                <td className="px-3 py-2 font-mono">{pct(row.pct_year)}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{row.n_year}</td>
                <td className="px-3 py-2">
                  <StatusChip status={row.level} />
                </td>
                <td className="px-3 py-2">
                  <Spark
                    values={row.sparkline}
                    onClick={(origin) => setChart({ row, origin })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {chart && (
        <RateChartModal row={chart.row} origin={chart.origin} onClose={() => setChart(null)} />
      )}
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
