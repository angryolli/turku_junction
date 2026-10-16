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

export type WardCard = {
  ward_code: string;
  ward_en: string;
  ward_type: string;
  status: Chip;
  n_hot: number;
};

export type RateCard = {
  ward_code: string;
  ward_en: string;
  organism: string;
  antibiotic: string;
  antibiotic_code: string;
  n_4w: number;
  pct_4w: number | null;
  n_year: number;
  pct_year: number | null;
  z: number | null;
  level: Chip;
  direction: string;
  sparkline: number[];
};

export type MonitorSnapshot = {
  dataset_id: string;
  tick: number;
  as_of: string | null;
  date_start: string;
  date_end: string;
  playing?: boolean;
  ticks_per_second?: number;
  finished?: boolean;
  wards: WardCard[];
  open_alerts: RateCard[];
  fields?: FieldCard[];
  demo_data_uri?: string;
  evidence: string;
};

export type AntibiogramResponse = {
  as_of: string | null;
  rows: RateCard[];
};

export type LabCatalog = {
  wards: Array<{ code: string; en: string; type: string }>;
  organisms: string[];
  specimens: string[];
  sexes: string[];
  antibiotics: Array<{ code: string; name: string; urine_only: boolean }>;
  date_start: string;
  date_end: string;
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
  as_of?: string | null;
  date_start?: string;
  date_end?: string;
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
    level: "yellow" | "red";
    score: number;
    z: number;
    top_fields: Array<{
      field_id: string;
      score: number;
      mean: number | null;
      sd: number | null;
      skew: number | null;
      kurt: number | null;
      n: number;
    }>;
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
