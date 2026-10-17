"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { CompareChart, type ChartSeries } from "@/components/compare-chart";
import { Button } from "@/components/ui/button";
import {
  browserGet,
  browserPut,
  monitorStreamUrl,
  type LabCatalog,
  type MonitorSnapshot,
} from "@/lib/browser-api";
import { useSimulation } from "@/components/simulation-context";
import { cn } from "@/lib/utils";

const PALETTE = [
  "rgb(228, 228, 231)",
  "rgb(96, 165, 250)",
  "rgb(251, 191, 36)",
  "rgb(52, 211, 153)",
  "rgb(244, 114, 182)",
  "rgb(167, 139, 250)",
  "rgb(251, 146, 60)",
  "rgb(45, 212, 191)",
  "rgb(248, 113, 113)",
];

const COLUMNS = ["ward", "ward_name", "n_4w", "pct_4w", "n_year", "pct_year", "z", "level"] as const;

type ChartTab = {
  id: string;
  organism: string;
  code: string;
  wards: string[];
  focus: string | null;
  view_start: number;
  view_span: number;
};

type ChartWorkspace = {
  active_id: string;
  tabs: ChartTab[];
};

function blankTab(id: string): ChartTab {
  return { id, organism: "", code: "", wards: [], focus: null, view_start: 0, view_span: 1 };
}

function normalizeTab(tab: Partial<ChartTab> & { id?: string }, index: number): ChartTab {
  const span = Math.min(1, Math.max(0.02, Number(tab.view_span ?? 1)));
  const start = Math.min(Math.max(0, Number(tab.view_start ?? 0)), 1 - span);
  return {
    id: tab.id || `g${index + 1}`,
    organism: tab.organism ?? "",
    code: tab.code ?? "",
    wards: Array.isArray(tab.wards) ? tab.wards.filter((item) => typeof item === "string") : [],
    focus: tab.focus ?? null,
    view_start: start,
    view_span: span,
  };
}

type AnalysisRow = Record<string, string | number | null>;

type AnalysisResult = {
  as_of: string | null;
  columns: string[];
  rows: AnalysisRow[];
  series: { name: string; values: number[]; limit: number | null }[];
  matched: number;
  sheet_count: number;
};

function nextId() {
  return `g${Math.random().toString(36).slice(2, 8)}`;
}

function shortOrganism(name: string) {
  return name.replace(/^(\S)\S+/, "$1.");
}

function tabTitle(tab: ChartTab, index: number) {
  if (!tab.organism || !tab.code) return `Graph ${index + 1}`;
  return `${shortOrganism(tab.organism)} · ${tab.code}`;
}

function cell(column: string, value: string | number | null) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") {
    if (column.startsWith("pct") || column === "z") return value.toFixed(column === "z" ? 2 : 1);
    return String(value);
  }
  return value;
}

export function AnalysisView() {
  const { resetRevision } = useSimulation();
  const [tabs, setTabs] = useState<ChartTab[]>([blankTab("g1")]);
  const [activeId, setActiveId] = useState("g1");
  const [hydrated, setHydrated] = useState(false);
  const [catalog, setCatalog] = useState<LabCatalog | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const saveEnabled = useRef(false);
  const dirty = useRef(false);
  const latest = useRef<ChartWorkspace>({ active_id: "g1", tabs: [blankTab("g1")] });
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const ready = Boolean(active.organism && active.code && active.wards.length);
  const focus = active.focus;
  latest.current = { active_id: activeId, tabs };

  useEffect(() => {
    let on = true;
    void browserGet<ChartWorkspace>("/charts")
      .then((data) => {
        if (!on) return;
        const next = (data.tabs ?? []).map(normalizeTab);
        if (next.length) {
          setTabs(next);
          setActiveId(next.some((tab) => tab.id === data.active_id) ? data.active_id : next[0].id);
        }
        saveEnabled.current = true;
        setHydrated(true);
      })
      .catch(() => {
        if (on) setHydrated(true);
      });
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    if (!saveEnabled.current) return;
    dirty.current = true;
    const timer = window.setTimeout(() => {
      dirty.current = false;
      void browserPut("/charts", latest.current);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [tabs, activeId]);

  useEffect(() => {
    return () => {
      if (saveEnabled.current && dirty.current) void browserPut("/charts", latest.current);
    };
  }, []);

  useEffect(() => {
    let on = true;
    void browserGet<LabCatalog>("/catalog")
      .then((data) => {
        if (on) setCatalog(data);
      })
      .catch(() => {
        if (on) setError("Could not load the lab catalog.");
      });
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setError("");
    setAsOf(null);
  }, [resetRevision]);

  useEffect(() => {
    let on = true;
    const source = new EventSource(monitorStreamUrl());
    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot;
        if (on) setAsOf(data.as_of);
      } catch {
        /* ignore */
      }
    });
    return () => {
      on = false;
      source.close();
    };
  }, [resetRevision]);

  const selectionKey = `${active.id}:${active.organism}:${active.code}:${active.wards.join(",")}`;

  useEffect(() => {
    if (!ready) {
      setResult(null);
      setError("");
      return;
    }
    const params = new URLSearchParams();
    params.set("organism", active.organism);
    params.set("code", active.code);
    for (const ward of active.wards) params.append("ward", ward);
    const id = ++request.current;
    void browserGet<AnalysisResult>(`/compare?${params.toString()}`)
      .then((data) => {
        if (request.current !== id) return;
        setResult(data);
        setError("");
      })
      .catch((err: unknown) => {
        if (request.current !== id) return;
        setResult(null);
        setError(err instanceof Error ? err.message : "Could not load this comparison.");
      });
  }, [active.code, active.organism, active.wards, asOf, ready, resetRevision, selectionKey]);

  const colorFor = useMemo(() => {
    const order = new Map((catalog?.wards ?? []).map((ward, index) => [ward.code, index]));
    return (code: string) => PALETTE[(order.get(code) ?? 0) % PALETTE.length];
  }, [catalog]);

  const series = useMemo<ChartSeries[]>(() => {
    return (result?.series ?? []).map((item) => ({
      name: item.name,
      values: item.values,
      limit: item.limit,
      color: colorFor(item.name),
    }));
  }, [colorFor, result]);

  function patchActive(patch: Partial<ChartTab>) {
    setTabs((current) => current.map((tab) => (tab.id === active.id ? { ...tab, ...patch } : tab)));
  }

  function toggleFocus(name: string) {
    patchActive({ focus: focus === name ? null : name });
  }

  function toggleWard(code: string) {
    const wards = active.wards.includes(code)
      ? active.wards.filter((item) => item !== code)
      : [...active.wards, code];
    patchActive({ wards });
  }

  function addTab() {
    const id = nextId();
    setTabs((current) => [...current, blankTab(id)]);
    setActiveId(id);
    setResult(null);
    setError("");
  }

  function closeTab(id: string) {
    setTabs((current) => {
      if (current.length === 1) return [blankTab(current[0].id)];
      const next = current.filter((tab) => tab.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? current[0].id);
      return next;
    });
  }

  function selectAllWards() {
    const codes = (catalog?.wards ?? []).map((ward) => ward.code);
    const allOn = codes.length > 0 && codes.every((code) => active.wards.includes(code));
    patchActive({ wards: allOn ? [] : codes });
  }

  const plotted = series.filter((item) => item.values.length > 0).length;
  const allWardsOn =
    (catalog?.wards.length ?? 0) > 0 &&
    (catalog?.wards ?? []).every((ward) => active.wards.includes(ward.code));

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading charts</div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-muted/20 px-2">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {tabs.map((tab, index) => {
            const title = tabTitle(tab, index);
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-8 max-w-56 items-center gap-1 rounded-t-md border border-b-0 px-2 text-xs",
                  tab.id === active.id
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/60",
                )}
              >
                <button type="button" className="truncate" onClick={() => setActiveId(tab.id)}>
                  {title}
                </button>
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Close ${title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <Button size="icon-xs" variant="ghost" onClick={addTab} aria-label="New graph">
            <Plus />
          </Button>
        </div>
        <p className="mb-1.5 shrink-0 font-mono text-[11px] text-muted-foreground">{asOf ?? "No lab day"}</p>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Organism
            <select
              value={active.organism}
              onChange={(event) => patchActive({ organism: event.target.value, focus: null })}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring"
            >
              <option value="">Choose</option>
              {(catalog?.organisms ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Antibiotic
            <select
              value={active.code}
              onChange={(event) => patchActive({ code: event.target.value, focus: null })}
              className="h-8 max-w-72 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring"
            >
              <option value="">Choose</option>
              {(catalog?.antibiotics ?? []).map((drug) => (
                <option key={drug.code} value={drug.code}>
                  {drug.code} · {drug.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={selectAllWards}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-foreground/20 hover:text-foreground"
          >
            {allWardsOn ? "Clear" : "All wards"}
          </button>
          {(catalog?.wards ?? []).map((ward) => {
            const on = active.wards.includes(ward.code);
            return (
              <button
                key={ward.code}
                type="button"
                aria-pressed={on}
                title={ward.en}
                onClick={() => toggleWard(ward.code)}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[11px]",
                  on
                    ? "border-foreground/40 bg-foreground/10 text-foreground"
                    : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                {ward.code}
              </button>
            );
          })}
        </div>
      </div>
      {error && <p className="border-b border-border px-3 py-2 text-xs text-red-400">{error}</p>}

      <section className="flex min-h-0 flex-[3] flex-col border-b border-border">
        <div className="flex h-8 shrink-0 items-center justify-between gap-3 px-3 text-[11px] text-muted-foreground">
          <span className="truncate">
            {ready
              ? plotted
                ? `${active.organism} · ${active.code} · ${plotted} ward${plotted === 1 ? "" : "s"}`
                : "No line yet for this selection"
              : "Empty chart"}
          </span>
          <span>0–100% resistant. Scroll to zoom, drag to move.</span>
        </div>
        <div className="relative min-h-0 flex-1">
          {!ready && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Pick an organism and an antibiotic, then turn wards on to compare them on one chart.
            </div>
          )}
          {ready && !asOf && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Press play. The lines appear as the lab day moves.
            </div>
          )}
          <CompareChart
            series={ready ? series : []}
            focus={focus}
            viewStart={active.view_start}
            viewSpan={active.view_span}
            asOf={asOf}
            onViewChange={(start, span) => patchActive({ view_start: start, view_span: span })}
          />
        </div>
        {series.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-2">
            {series.map((item) => (
              <button
                key={item.name}
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 font-mono text-[11px]",
                  focus && focus !== item.name ? "text-muted-foreground" : "text-foreground",
                )}
                onClick={() => toggleFocus(item.name)}
              >
                <span className="size-2 rounded-full" style={{ background: item.color }} />
                {item.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-[2] flex-col">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3 text-[11px] text-muted-foreground">
          <span>Sheet</span>
          <span>{result ? `${result.sheet_count} rows` : "No selection"}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-left text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} className="border-b border-border px-3 py-1.5 font-mono font-medium text-muted-foreground">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(result?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-3 py-6 text-muted-foreground">
                    {ready ? "No rows for this selection yet." : "The selected wards show up here."}
                  </td>
                </tr>
              )}
              {(result?.rows ?? []).map((row) => {
                const name = String(row.ward ?? "");
                const on = Boolean(name) && focus === name;
                return (
                  <tr
                    key={name}
                    className={cn("cursor-pointer", on ? "bg-muted/70" : "hover:bg-muted/40")}
                    onClick={() => toggleFocus(name)}
                  >
                    {COLUMNS.map((column) => (
                      <td key={column} className="border-b border-border/70 px-3 py-1.5 font-mono whitespace-nowrap">
                        {cell(column, row[column] ?? null)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
