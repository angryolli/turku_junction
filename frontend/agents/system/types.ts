export type SystemStep =
  | "idle"
  | "understanding"
  | "quality"
  | "diagnosis"
  | "error";

export type SystemReport = {
  text: string;
  generatedAt: string;
  model: string;
  hash: string;
  bytes: number;
};

export type FieldUnderstanding = {
  field_id: string;
  /** Plain-language best guess of what this channel measures or drives. */
  guess: string;
  /** 0–1 confidence in the guess. */
  confidence: number;
  /** Short read on current stream behavior, citing moments and |z| when available. */
  observations: string;
  /** measured | actuator | ambiguous — optional hint alongside the guess. */
  role?: string;
};

export type FieldQuality = {
  field_id: string;
  faulty: boolean;
  issue: string;
  adjective: string;
  confidence: number;
  summary: string;
};

export type SensorNote = {
  understanding?: FieldUnderstanding;
  quality?: FieldQuality;
};

export type DataFlowRecord = {
  model: string;
  host: string;
  noEgress: boolean;
  leaves: string;
  why: string;
  swap: string;
};

export type SystemAgentStatus = {
  running: boolean;
  loop: "manual" | "continuous";
  step: SystemStep;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastBeatAt: string | null;
  error: string | null;
  eventId: string | null;
  understanding: SystemReport | null;
  quality: SystemReport | null;
  diagnosis: SystemReport | null;
  critique: SystemReport | null;
  alarmDiagnoses: Record<string, SystemReport>;
  rootCauseSignalId: string | null;
  sensors: Record<string, SensorNote>;
  dataFlow: DataFlowRecord;
};
