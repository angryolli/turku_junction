import type { DiagnosisSnapshot } from "@/lib/pipeline";
import type { SensorNote } from "./types";

const CEILING = 20_000;

export function clipDiagnosis(snap: DiagnosisSnapshot) {
  const fields = (snap.current?.fields ?? []).slice(0, 24).map((field) => ({
    field_id: field.field_id,
    n: field.n,
    mean: field.mean,
    sd: field.sd,
    skew: field.skew,
    kurt: field.kurt,
    score: field.score,
  }));
  const signals = (snap.signals ?? snap.events ?? []).slice(0, 8).map((row) => ({
    id: row.id,
    tick: row.tick,
    level: row.level,
    score: row.score,
    z: row.z,
    evidence: row.evidence,
    top_fields: row.top_fields.slice(0, 5),
  }));
  const artifact = {
    evidence: snap.evidence,
    current: {
      tick: snap.current?.tick ?? 0,
      n: snap.current?.n ?? 0,
      score: snap.current?.score ?? 0,
      z: snap.current?.z ?? 0,
      calibrated: Boolean(snap.current?.calibrated),
      fields,
    },
    signals,
  };
  let json = JSON.stringify(artifact);
  if (json.length > CEILING) {
    artifact.current.fields = artifact.current.fields.slice(0, 10);
    artifact.signals = artifact.signals.slice(0, 3);
    json = JSON.stringify(artifact);
  }
  return { artifact, json, bytes: json.length };
}

export function clipForAlarmRootCause(
  snap: DiagnosisSnapshot,
  signalId: string,
  sensors: Record<string, SensorNote>,
) {
  const signals = snap.signals ?? snap.events ?? [];
  const target = signals.find((row) => row.id === signalId);
  if (!target) return null;

  const fields = (snap.current?.fields ?? []).slice(0, 24).map((field) => ({
    field_id: field.field_id,
    n: field.n,
    mean: field.mean,
    sd: field.sd,
    skew: field.skew,
    kurt: field.kurt,
    score: field.score,
  }));

  const agentNotes = Object.entries(sensors).map(([field_id, note]) => ({
    field_id,
    understanding: note.understanding ?? null,
    quality: note.quality ?? null,
  }));

  const artifact = {
    run_context: {
      detector: {
        kind: "rolling_z_score",
        yellow_gate: snap.current?.z_yellow ?? 4,
        red_gate: snap.current?.z_red ?? 6,
        consecutive_k: snap.current?.k ?? 6,
        burn_in: snap.current?.burn_in ?? 20,
        rule:
          "Each channel is studentized against its own expanding mean and sd. Yellow/red need k consecutive hot samples; a single spike never opens an alarm.",
      },
    },
    target_alarm: {
      id: target.id,
      tick: target.tick,
      level: target.level,
      score: target.score,
      z: target.z,
      evidence: target.evidence,
      top_fields: target.top_fields,
    },
    current_sample: {
      tick: snap.current?.tick ?? 0,
      max_z: snap.current?.z ?? 0,
      consecutive_hot: snap.current?.score ?? 0,
      calibrated: Boolean(snap.current?.calibrated),
      fields,
    },
    other_open_alarms: signals
      .filter((row) => row.id !== signalId)
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        tick: row.tick,
        level: row.level,
        z: row.z,
      })),
    agent_notes: agentNotes,
  };

  let json = JSON.stringify(artifact);
  if (json.length > CEILING) {
    artifact.current_sample.fields = artifact.current_sample.fields.slice(0, 12);
    artifact.agent_notes = artifact.agent_notes.slice(0, 12);
    json = JSON.stringify(artifact);
  }

  return { artifact, json, bytes: json.length };
}
