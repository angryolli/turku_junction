const PIPELINE_URL = process.env.PIPELINE_URL ?? "http://localhost:8000";

export async function pipeline<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${PIPELINE_URL}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pipeline ${path} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function getConfig() {
  return pipeline<{
    dataset_id: string;
    datasets: string[];
    calibration_id: string | null;
    baseline_established: boolean;
    no_egress: boolean;
    playing?: boolean;
    finished?: boolean;
  }>("/config");
}

export async function postConfig(body: Record<string, unknown>) {
  return pipeline("/config", { method: "POST", body: JSON.stringify(body) });
}

export type DiagnosisContributor = {
  field_id: string;
  /** |z| of this channel against its own expanding mean and sd. */
  score: number;
  mean: number | null;
  sd: number | null;
  skew: number | null;
  kurt: number | null;
  n: number;
};

export type DiagnosisSignal = {
  id: string;
  tick: number;
  level: "yellow" | "red";
  /** Consecutive hot samples behind this alert. Equals k when it opens. */
  score: number;
  /** Largest |z| across channels on the sample that raised the alert. */
  z: number;
  top_fields: DiagnosisContributor[];
  evidence: string;
  /** Human label: "z-score k=6", "v5 agnostic (moment)", or both joined with " + ". */
  reason?: string;
  /** Machine tags: "zscore", "moment", "freeze", "amp", "v5". */
  origins?: string[];
  created_at: string;
};

export type DiagnosisSnapshot = {
  signals: DiagnosisSignal[];
  events?: DiagnosisSignal[];
  current: {
    tick: number;
    n?: number;
    /** Consecutive samples so far with some channel past the yellow gate. */
    score: number;
    /** Largest |z| across channels on this sample. */
    z: number;
    calibrated: boolean;
    fields: DiagnosisContributor[];
    level?: "normal" | "yellow" | "red";
    /** Consecutive hot samples an alert needs. */
    k?: number;
    z_yellow?: number;
    z_red?: number;
    burn_in?: number;
    streak_yellow?: number;
    streak_red?: number;
    /** Channels past the yellow gate on this sample. */
    n_hot?: number;
  };
  evidence: string;
};

export async function getDiagnosis() {
  return pipeline<DiagnosisSnapshot>("/diagnosis");
}

export async function getDecisionLog(params?: { type?: string }) {
  const q = params?.type ? `?type=${params.type}` : "";
  return pipeline(`/decision-log${q}`);
}

export async function postDecisionLog(body: Record<string, unknown>) {
  return pipeline("/decision-log/append", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getEvents() {
  return pipeline<DiagnosisSnapshot>("/events");
}

export async function getMonitor() {
  return pipeline("/monitor/snapshot");
}

export async function getHealth() {
  return pipeline("/health");
}
