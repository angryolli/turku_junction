"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StreamChart, type ChartMark } from "@/components/stream-chart";
import {
  browserGet,
  browserPost,
  eventsStreamUrl,
  monitorStreamUrl,
  type DataSource,
  type DataSourcePreview,
  type FieldCard,
  type MonitorSnapshot,
} from "@/lib/browser-api";
import type { DiagnosisSignal, DiagnosisSnapshot } from "@/lib/pipeline";
import { useSimulation } from "@/components/simulation-context";
import { IDLE_AGENT, type SystemAgentStatus } from "@/components/monitor-panes";
import { noteForStream, SourceModal } from "@/components/source-modal";
import { cn } from "@/lib/utils";

function sourceKey(sourceId: string, fieldId: string) {
  return `${sourceId}\t${fieldId}`;
}

function parseSourceKey(key: string) {
  const idx = key.indexOf("\t");
  if (idx < 0) return { source_id: "", field_id: key };
  return { source_id: key.slice(0, idx), field_id: key.slice(idx + 1) };
}

function fieldHit(signalFieldId: string, stream: FieldCard) {
  const sourceId = stream.source_id ?? "";
  const fieldId = stream.field_id;
  // Alarms are stored as `source_id::column`. Never match by bare column name —
  // that paints one CSV's alarms onto every other source that shares xmeas_*.
  if (sourceId) {
    return signalFieldId === `${sourceId}::${fieldId}`;
  }
  return signalFieldId === fieldId || signalFieldId.endsWith(`::${fieldId}`);
}

function marksForStream(
  stream: FieldCard,
  tick: number | undefined,
  signals: DiagnosisSignal[],
): ChartMark[] {
  const len = stream.sparkline.length;
  if (!len || tick == null) return [];
  const windowStart = tick - (len - 1);
  const out: ChartMark[] = [];
  for (const signal of signals) {
    if (signal.level !== "yellow" && signal.level !== "red") continue;
    if (!signal.top_fields.some((field) => fieldHit(field.field_id, stream)))
      continue;
    const index = signal.tick - windowStart;
    if (index < 0 || index > len - 1) continue;
    out.push({ index, level: signal.level });
  }
  return out;
}

type OriginChoice = "api" | "file" | null;

const DEMO_URI = (process.env.NEXT_PUBLIC_DEMO_DATA_URI ?? "").trim();
const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function DataSourcesView() {
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<OriginChoice>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [filePath, setFilePath] = useState(DEMO_URI);
  const [preview, setPreview] = useState<DataSourcePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [xColumn, setXColumn] = useState("");
  const [yColumns, setYColumns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [sources, setSources] = useState<DataSource[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [signals, setSignals] = useState<DiagnosisSignal[]>([]);
  const [agent, setAgent] = useState<SystemAgentStatus>(IDLE_AGENT);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [origin, setOrigin] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const ticksRef = useRef({
    tick: -1,
    demo: -1,
    dataset: "",
    playing: false,
    fields: "",
  });
  const { applySnapshot, finished } = useSimulation();
  const searchParams = useSearchParams();
  const openedQuery = useRef(false);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;

    function apply(data: MonitorSnapshot) {
      if (!on) return;
      const fieldKey = (data.fields ?? [])
        .map((field) => `${field.source_id ?? ""}:${field.field_id}`)
        .join("|");
      if (
        data.tick === ticksRef.current.tick &&
        data.dataset_id === ticksRef.current.dataset &&
        Boolean(data.playing) === ticksRef.current.playing &&
        fieldKey === ticksRef.current.fields
      ) {
        return;
      }
      ticksRef.current = {
        tick: data.tick,
        demo: data.tick,
        dataset: data.dataset_id,
        playing: Boolean(data.playing),
        fields: fieldKey,
      };
      setSnap(data);
      applySnapshot({
        playing: data.playing,
        ticks_per_second: data.ticks_per_second,
        finished: data.finished,
      });
    }

    function connect() {
      source?.close();
      source = new EventSource(monitorStreamUrl());
      source.addEventListener("snapshot", (event) => {
        try {
          apply(
            JSON.parse((event as MessageEvent<string>).data) as MonitorSnapshot,
          );
        } catch {
          /* ignore malformed frames */
        }
      });
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as MonitorSnapshot);
        } catch {
          /* ignore malformed frames */
        }
      };
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
  }, [applySnapshot]);

  useEffect(() => {
    let on = true;
    let source: EventSource | null = null;
    const sig = { current: "" };

    function apply(data: DiagnosisSnapshot) {
      if (!on) return;
      const next = data.signals ?? data.events ?? [];
      const nextSig = next
        .map((row) => `${row.id}:${row.level}:${row.tick}`)
        .join("|");
      if (nextSig === sig.current) return;
      sig.current = nextSig;
      setSignals(next);
    }

    function connect() {
      source?.close();
      source = new EventSource(eventsStreamUrl());
      source.addEventListener("events", (event) => {
        try {
          apply(
            JSON.parse(
              (event as MessageEvent<string>).data,
            ) as DiagnosisSnapshot,
          );
        } catch {
          /* ignore malformed frames */
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

  useEffect(() => {
    let on = true;
    async function pull() {
      try {
        const res = await fetch("/api/system-agent");
        const data = (await res.json()) as SystemAgentStatus;
        if (on)
          setAgent({ ...IDLE_AGENT, ...data, sensors: data.sensors ?? {} });
      } catch {
        /* ignore */
      }
    }
    void pull();
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    if (!openKey) return;
    let on = true;
    const id = window.setInterval(() => {
      fetch("/api/system-agent")
        .then((r) => r.json())
        .then((data: SystemAgentStatus) => {
          if (on)
            setAgent({ ...IDLE_AGENT, ...data, sensors: data.sensors ?? {} });
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [openKey]);

  async function loadSources() {
    try {
      setSources(await browserGet<DataSource[]>("/data-sources"));
    } catch {
      setSources([]);
    }
  }

  useEffect(() => {
    void loadSources();
  }, []);

  useEffect(() => {
    if (!adding && !deleteOpen && !deleting) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (deleteOpen) {
        setDeleteOpen(false);
        return;
      }
      if (deleting) {
        setDeleting(false);
        setSelected(new Set());
        return;
      }
      if (adding) closeModal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding, deleteOpen, deleting]);

  useEffect(() => {
    if (!adding || choice !== "file") return;
    const path = filePath.trim();
    if (!path) {
      setPreview(null);
      return;
    }
    let on = true;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      setPreviewing(true);
      setError(null);
      void browserPost<DataSourcePreview>(
        "/data-sources/preview",
        { path },
        controller.signal,
      )
        .then((data) => {
          if (!on) return;
          setPreview(data);
          setXColumn("");
          setYColumns([]);
        })
        .catch((err) => {
          if (!on) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setPreview(null);
          setXColumn("");
          setYColumns([]);
          setError(
            err instanceof Error ? err.message : "could not read headers",
          );
        })
        .finally(() => {
          if (on) setPreviewing(false);
        });
    }, 350);
    return () => {
      on = false;
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [adding, choice, filePath]);

  function closeModal() {
    setAdding(false);
    setChoice(null);
    setApiUrl("");
    setFilePath(DEMO_URI || snap?.demo_data_uri || "");
    setPreview(null);
    setPreviewing(false);
    setXColumn("");
    setYColumns([]);
    setError(null);
  }

  function toggleY(column: string) {
    setYColumns((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : [...current, column],
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (choice === "api") {
        if (!apiUrl.trim()) {
          setError("API URL is required");
          return;
        }
        await browserPost("/data-sources/api", {
          origin: "api",
          api_url: apiUrl.trim(),
        });
      } else if (choice === "file") {
        if (!filePath.trim()) {
          setError("File path is required");
          return;
        }
        if (!xColumn) {
          setError("Pick an x-axis column");
          return;
        }
        if (yColumns.length === 0) {
          setError("Pick at least one data column");
          return;
        }
        await browserPost("/data-sources/file", {
          path: filePath.trim(),
          x_column: xColumn,
          y_columns: yColumns,
        });
      } else {
        return;
      }
      closeModal();
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  function applySnap(updated: MonitorSnapshot) {
    const fieldKey = (updated.fields ?? [])
      .map((field) => `${field.source_id ?? ""}:${field.field_id}`)
      .join("|");
    ticksRef.current = {
      tick: updated.tick,
      demo: updated.tick,
      dataset: updated.dataset_id,
      playing: Boolean(updated.playing),
      fields: fieldKey,
    };
    setSnap(updated);
    applySnapshot({
      playing: updated.playing,
      ticks_per_second: updated.ticks_per_second,
      finished: updated.finished,
    });
  }

  function toggleSelected(key: string) {
    if (!key) return;
    setDeleting(true);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function confirmDelete() {
    const fields = [...selected]
      .map(parseSourceKey)
      .filter((item) => item.source_id && item.field_id);
    if (fields.length === 0) return;
    setBusy(true);
    try {
      applySnap(
        await browserPost<MonitorSnapshot>("/data-sources/bulk-delete", {
          fields,
        }),
      );
      setDeleteOpen(false);
      setDeleting(false);
      setSelected(new Set());
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  const yOptions = useMemo(() => {
    if (!preview) return [];
    const numeric = new Set(preview.numeric);
    return preview.columns
      .filter((column) => column !== xColumn)
      .sort((a, b) => Number(numeric.has(b)) - Number(numeric.has(a)));
  }, [preview, xColumn]);

  const streams = useMemo(() => {
    return [...(snap?.fields ?? [])].sort((a, b) => {
      const file = (a.source_file ?? "").localeCompare(b.source_file ?? "");
      if (file !== 0) return file;
      const an = Number.parseInt(a.field_id.replace(/\D/g, ""), 10);
      const bn = Number.parseInt(b.field_id.replace(/\D/g, ""), 10);
      const av = Number.isFinite(an) ? an : Number.POSITIVE_INFINITY;
      const bv = Number.isFinite(bn) ? bn : Number.POSITIVE_INFINITY;
      return av !== bv ? av - bv : a.field_id.localeCompare(b.field_id);
    });
  }, [snap]);

  const configuredSources = useMemo(() => {
    return sources.filter(
      (source) =>
        Boolean(source.x_column) || (source.y_columns?.length ?? 0) > 0,
    );
  }, [sources]);

  const idleFields = useMemo(() => {
    const seen = new Set(
      streams.map((stream) =>
        sourceKey(stream.source_id ?? "", stream.field_id),
      ),
    );
    return configuredSources.flatMap((source) =>
      (source.y_columns ?? [])
        .filter((column) => !seen.has(sourceKey(source.id, column)))
        .map((column) => ({
          source,
          field_id: column,
          key: sourceKey(source.id, column),
          file_name: source.file_path.split(/[/\\]/).pop() || source.name,
        })),
    );
  }, [configuredSources, streams]);

  const openStream = useMemo((): FieldCard | null => {
    if (!openKey) return null;
    const live = streams.find(
      (stream) =>
        sourceKey(stream.source_id ?? "", stream.field_id) === openKey,
    );
    if (live) return live;
    const idle = idleFields.find((field) => field.key === openKey);
    if (!idle) return null;
    return {
      field_id: idle.field_id,
      sparkline: [],
      status: "normal",
      contribution: 0,
      evidence: "",
      source_file: idle.file_name,
      source_id: idle.source.id,
    };
  }, [idleFields, openKey, streams]);

  const openSource = useCallback(
    (key: string, node: HTMLElement) => {
      if (deleting) return;
      const rect = node.getBoundingClientRect();
      setOrigin({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
      setOpenKey(key);
    },
    [deleting],
  );

  useEffect(() => {
    if (openedQuery.current || deleting) return;
    const field = searchParams.get("field");
    if (!field) return;
    const source = searchParams.get("source") ?? "";
    const exact = sourceKey(source, field);
    const liveExact = streams.find(
      (stream) => sourceKey(stream.source_id ?? "", stream.field_id) === exact,
    );
    const idleExact = idleFields.find((row) => row.key === exact);
    const liveField = streams.find((stream) => stream.field_id === field);
    const idleField = idleFields.find((row) => row.field_id === field);
    const key = liveExact
      ? exact
      : idleExact
        ? idleExact.key
        : liveField
          ? sourceKey(liveField.source_id ?? "", liveField.field_id)
          : idleField?.key;
    if (!key) return;
    openedQuery.current = true;
    const el = document.querySelector(`[data-source-key="${CSS.escape(key)}"]`);
    if (el instanceof HTMLElement) {
      openSource(key, el);
      return;
    }
    setOpenKey(key);
    setOrigin({
      left: Math.max(24, window.innerWidth / 2 - 160),
      top: 96,
      width: 320,
      height: 208,
    });
  }, [deleting, idleFields, openSource, searchParams, streams]);

  const allFieldKeys = useMemo(() => {
    const keys = streams.map((stream) =>
      sourceKey(stream.source_id ?? "", stream.field_id),
    );
    for (const field of idleFields) keys.push(field.key);
    return keys.filter(Boolean);
  }, [idleFields, streams]);

  const selectedLabels = useMemo(() => {
    const names = new Map<string, string>();
    for (const stream of streams) {
      names.set(
        sourceKey(stream.source_id ?? "", stream.field_id),
        `${stream.field_id} · ${stream.source_file || "file"}`,
      );
    }
    for (const field of idleFields) {
      names.set(field.key, `${field.field_id} · ${field.file_name}`);
    }
    return [...selected].map((key) => names.get(key) || key).filter(Boolean);
  }, [idleFields, selected, streams]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button
          size="sm"
          variant="outline"
          disabled={allFieldKeys.length === 0}
          onClick={() => {
            if (selected.size === 0) {
              setDeleting(true);
              return;
            }
            setDeleteOpen(true);
          }}
        >
          <Trash2 />
          Delete sources
        </Button>
        {deleting && (
          <Button
            size="sm"
            variant="outline"
            disabled={allFieldKeys.length === 0}
            onClick={() => {
              setSelected(new Set(allFieldKeys));
            }}
          >
            Select all
          </Button>
        )}
        {deleting && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDeleting(false);
              setSelected(new Set());
              setDeleteOpen(false);
            }}
          >
            Cancel
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          {deleting
            ? selected.size > 0
              ? `${selected.size} selected`
              : "Select y-axis sources to remove"
            : streams.length === 0
              ? "Add sources, then play from the sidebar"
              : finished
                ? "Stream ended. Reset from the sidebar to play again"
                : "Simulation progress is kept when you pause"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={cn(
              STREAM_CARD,
              "flex appearance-none items-center justify-center border-dashed text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
            )}
            aria-label="Add data source"
          >
            <Plus className="size-8" strokeWidth={1.5} />
          </button>
          {idleFields.map((field) => (
            <StreamTile
              key={field.key}
              tileKey={field.key}
              stream={{
                field_id: field.field_id,
                sparkline: [],
                status: "normal",
                contribution: 0,
                evidence: "",
                source_file: field.file_name,
                source_id: field.source.id,
              }}
              deleting={deleting}
              selected={selected.has(field.key)}
              onSelect={() => toggleSelected(field.key)}
              onOpen={(node) => openSource(field.key, node)}
            />
          ))}
          {streams.map((stream) => {
            const key = sourceKey(stream.source_id ?? "", stream.field_id);
            return (
              <StreamTile
                key={key}
                tileKey={key}
                stream={stream}
                tick={snap?.tick}
                marks={marksForStream(stream, snap?.tick, signals)}
                deleting={deleting}
                selected={selected.has(key)}
                onSelect={() => toggleSelected(key)}
                onOpen={(node) => openSource(key, node)}
              />
            );
          })}
        </div>
      </div>

      {adding && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
          onClick={closeModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-source-title"
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 id="add-source-title" className="text-sm font-medium">
                Add data source
              </h2>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={closeModal}
                aria-label="Close"
              >
                <X />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setChoice("api")}
                className={cn(
                  "rounded-xl border px-3 py-6 text-sm transition-colors",
                  choice === "api"
                    ? "border-foreground/40 bg-secondary"
                    : "border-border hover:border-foreground/30",
                )}
              >
                API
              </button>
              <button
                type="button"
                onClick={() => {
                  setChoice("file");
                  setFilePath(
                    (current) =>
                      current.trim() || snap?.demo_data_uri || DEMO_URI,
                  );
                }}
                className={cn(
                  "rounded-xl border px-3 py-6 text-sm transition-colors",
                  choice === "file"
                    ? "border-foreground/40 bg-secondary"
                    : "border-border hover:border-foreground/30",
                )}
              >
                CSV / Excel
              </button>
            </div>
            {choice && (
              <div className="mt-4 space-y-3">
                {choice === "api" ? (
                  <label className="block space-y-1 text-xs text-muted-foreground">
                    <span>URL</span>
                    <Input
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="https://…"
                    />
                  </label>
                ) : (
                  <>
                    <label className="block space-y-1 text-xs text-muted-foreground">
                      <span>File path</span>
                      <Input
                        value={filePath}
                        onChange={(e) => {
                          setFilePath(e.target.value);
                          setPreview(null);
                          setXColumn("");
                          setYColumns([]);
                        }}
                        placeholder="/path/to/data.csv"
                      />
                    </label>
                    {previewing && (
                      <p className="text-xs text-muted-foreground">
                        Reading column names…
                      </p>
                    )}
                    {preview && (
                      <>
                        <label className="block space-y-1 text-xs text-muted-foreground">
                          <span>X-axis</span>
                          <select
                            className={SELECT_CLASS}
                            value={xColumn}
                            onChange={(e) => {
                              const next = e.target.value;
                              setXColumn(next);
                              setYColumns((current) =>
                                current.filter((col) => col !== next),
                              );
                            }}
                          >
                            <option value="">Select column</option>
                            {preview.columns.map((column) => (
                              <option key={column} value={column}>
                                {column}
                              </option>
                            ))}
                          </select>
                        </label>
                        {xColumn && (
                          <fieldset className="space-y-2">
                            <legend className="text-xs text-muted-foreground">
                              Data columns
                            </legend>
                            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                              {yOptions.map((column) => (
                                <label
                                  key={column}
                                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-secondary"
                                >
                                  <input
                                    type="checkbox"
                                    checked={yColumns.includes(column)}
                                    onChange={() => toggleY(column)}
                                  />
                                  <span className="truncate font-mono text-xs">
                                    {column}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        )}
                      </>
                    )}
                  </>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button
                  className="w-full"
                  disabled={
                    busy ||
                    previewing ||
                    (choice === "file" && (!xColumn || yColumns.length === 0))
                  }
                  onClick={() => void submit()}
                >
                  Add
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {deleteOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDeleteOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-sources-title"
            className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-sources-title" className="text-sm font-medium">
              Delete data sources
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Remove {selected.size} y-axis source
              {selected.size === 1 ? "" : "s"} from the current simulation. The
              original file stays.
            </p>
            {selectedLabels.length > 0 && (
              <ul className="mt-3 max-h-32 list-disc overflow-y-auto pl-5 text-sm">
                {selectedLabels.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            )}
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || selected.size === 0}
                onClick={() => void confirmDelete()}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
      {openKey && origin && openStream && (
        <SourceModal
          stream={openStream}
          origin={origin}
          tick={snap?.tick}
          marks={marksForStream(openStream, snap?.tick, signals)}
          note={noteForStream(agent.sensors, openStream)}
          onClose={() => {
            setOpenKey(null);
            setOrigin(null);
          }}
        />
      )}
    </div>
  );
}

const STREAM_CARD = "box-border h-52 min-w-0 rounded-xl border bg-card p-2";

const StreamTile = memo(function StreamTile({
  tileKey,
  stream,
  tick,
  marks,
  deleting,
  selected,
  onSelect,
  onOpen,
}: {
  tileKey: string;
  stream: FieldCard;
  tick?: number;
  marks?: ChartMark[];
  deleting?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onOpen?: (node: HTMLElement) => void;
}) {
  return (
    <div
      data-source-key={tileKey}
      role={deleting ? undefined : "button"}
      className={cn(
        STREAM_CARD,
        "relative",
        !deleting && "cursor-pointer",
        selected && "border-blue-500 ring-2 ring-blue-500",
      )}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 13rem" }}
      onClick={(event) => {
        if (deleting) {
          onSelect?.();
          return;
        }
        onOpen?.(event.currentTarget);
      }}
    >
      {deleting && (
        <button
          type="button"
          className={cn(
            "absolute top-1.5 right-1.5 z-10 size-4 rounded-full border-2 border-white",
            selected ? "bg-blue-500" : "bg-transparent",
          )}
          aria-label={`Select ${stream.field_id}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.();
          }}
        />
      )}
      <div className="min-w-0 pr-6">
        <div className="truncate font-mono text-sm">{stream.field_id}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {stream.source_file || "—"}
        </div>
      </div>
      <div className="mt-1 h-36">
        <StreamChart
          values={stream.sparkline}
          tick={tick}
          marks={marks}
          className="h-36"
          accent="rgb(82, 82, 91)"
        />
      </div>
    </div>
  );
});
