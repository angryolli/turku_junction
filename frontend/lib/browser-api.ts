const BASE = process.env.NEXT_PUBLIC_PIPELINE_URL ?? "http://localhost:8000";

export function monitorStreamUrl(): string {
  return `${BASE}/monitor/stream`;
}

export function eventsStreamUrl(): string {
  return `${BASE}/events/stream`;
}

export async function browserGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

export async function browserPost<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    let detail = `${path} ${res.status}`;
    try {
      const payload = (await res.json()) as { detail?: unknown };
      if (typeof payload.detail === "string" && payload.detail.trim()) {
        detail = payload.detail;
      }
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function browserPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

export async function browserDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE", cache: "no-store" });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

export type Chip = "normal" | "yellow" | "red";

export type FieldCard = {
  field_id: string;
  sparkline: number[];
  status: Chip;
  contribution: number;
  evidence: string;
  source_file?: string;
  source_id?: string;
};

export type MonitorSnapshot = {
  calibration_id: string | null;
  dataset_id: string;
  tick: number;
  t2_series: number[];
  control_limit: number;
  fields: FieldCard[];
  demo_fields?: FieldCard[];
  demo_tick?: number;
  exclusion_list: string[];
  latest_event_id: string | null;
  demo_data_uri?: string;
  playing?: boolean;
  ticks_per_second?: number;
  finished?: boolean;
  evidence: str;
};

export type DataSourcePreview = {
  path: string;
  file_name: string;
  columns: string[];
  numeric: string[];
};

export type DataSource = {
  id: string;
  name: string;
  kind: "process" | "business" | "other";
  description: string;
  origin: "api" | "file";
  api_url: string;
  file_path: string;
  train_path: string;
  live_path: string;
  x_column?: string;
  y_columns?: string[];
  created_at: string;
  updated_at: string;
  active: boolean;
};

export type RuntimeConfig = {
  dataset_id: string;
  datasets: string[];
  calibration_id: string | null;
  baseline_established: boolean;
  no_egress: boolean;
  demo_data_uri?: string;
  playing?: boolean;
  ticks_per_second?: number;
  finished?: boolean;
};

export type StreamResetResponse = {
  snapshot: MonitorSnapshot;
  archived_run_id: string | null;
};

export type SimulationRunSummary = {
  id: string;
  started_at: string;
  ended_at: string;
  tick: number;
  finished: boolean;
  sources: Array<{
    id?: string;
    name?: string;
    file_path?: string;
    x_column?: string;
    y_columns?: string[];
  }>;
  alarm_count: number;
  decision_count: number;
};

export type SimulationRunDetail = SimulationRunSummary & {
  alarms: Array<{
    id: string;
    tick: number;
    level: string;
    score: number;
    z: number;
    top_fields: Array<Record<string, unknown>>;
    evidence: string;
    reason?: string;
    origins?: string[];
    created_at: string;
  }>;
  decisions: Array<{
    ts: string;
    type: string;
    payload: unknown;
    evidence_ref: string;
    human_overridden: boolean;
  }>;
};

export type ChatSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ChatDetail = ChatSummary & {
  messages: Array<{
    id: string;
    role: string;
    parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
};
