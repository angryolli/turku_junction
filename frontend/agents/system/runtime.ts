import "server-only";

import { runAlarmRootCause } from "./alarm-root-cause";
import { dataFlowRecord, runSystemCycle } from "./cycle";
import type { SystemAgentStatus, SystemReport, SystemStep } from "./types";

type Handle = {
  status: Omit<SystemAgentStatus, "dataFlow">;
  abort: AbortController | null;
  job: Promise<void> | null;
  rootCauseAbort: AbortController | null;
  rootCauseJob: Promise<void> | null;
};

const g = globalThis as typeof globalThis & {
  __norrinSystemAgent?: Handle;
};

function emptyStatus(): Omit<SystemAgentStatus, "dataFlow"> {
  return {
    running: false,
    loop: "manual",
    step: "idle",
    startedAt: null,
    lastCycleAt: null,
    lastBeatAt: null,
    error: null,
    eventId: null,
    understanding: null,
    quality: null,
    diagnosis: null,
    critique: null,
    alarmDiagnoses: {},
    rootCauseSignalId: null,
    sensors: {},
  };
}

function handle(): Handle {
  if (!g.__norrinSystemAgent) {
    g.__norrinSystemAgent = {
      status: emptyStatus(),
      abort: null,
      job: null,
      rootCauseAbort: null,
      rootCauseJob: null,
    };
  }
  return g.__norrinSystemAgent;
}

function snapshot(): SystemAgentStatus {
  const status = handle().status;
  if (!status.sensors) status.sensors = {};
  if (!status.alarmDiagnoses) status.alarmDiagnoses = {};
  return { ...status, dataFlow: dataFlowRecord() };
}

export function getSystemAgentStatus(): SystemAgentStatus {
  return snapshot();
}

export function startSystemAgent(): SystemAgentStatus {
  const runtime = handle();
  if (runtime.status.running) return snapshot();
  runtime.abort = new AbortController();
  runtime.status.running = true;
  runtime.status.step = "understanding";
  runtime.status.error = null;
  runtime.status.startedAt = new Date().toISOString();
  runtime.status.lastBeatAt = runtime.status.startedAt;
  const abort = runtime.abort;
  runtime.job = runSystemCycle({
    aborted: () => abort.signal.aborted,
    abortSignal: abort.signal,
    setStep: (step: SystemStep) => {
      runtime.status.step = step;
      runtime.status.lastBeatAt = new Date().toISOString();
    },
    setEventId: (id) => {
      runtime.status.eventId = id;
    },
    setReport: (key, report: SystemReport) => {
      runtime.status[key] = report;
      runtime.status.lastBeatAt = new Date().toISOString();
    },
    mergeSensors: (patch) => {
      const next = { ...(runtime.status.sensors ?? {}) };
      for (const [id, note] of Object.entries(patch)) {
        next[id] = { ...next[id], ...note };
      }
      runtime.status.sensors = next;
    },
  })
    .then(() => {
      if (abort.signal.aborted) return;
      runtime.status.lastCycleAt = new Date().toISOString();
      runtime.status.step = "idle";
    })
    .catch((err) => {
      runtime.status.step = "error";
      runtime.status.error = err instanceof Error ? err.message : "system cycle failed";
    })
    .finally(() => {
      runtime.status.running = false;
      runtime.abort = null;
      runtime.job = null;
    });
  return snapshot();
}

export function stopSystemAgent(): SystemAgentStatus {
  const runtime = handle();
  runtime.abort?.abort();
  runtime.abort = null;
  runtime.status.running = false;
  if (runtime.status.step !== "error") runtime.status.step = "idle";
  return snapshot();
}

export async function startAlarmRootCause(signalId: string): Promise<SystemAgentStatus> {
  const runtime = handle();
  if (runtime.status.rootCauseSignalId) {
    throw new Error("Root-cause analysis is already running.");
  }
  if (runtime.rootCauseJob) {
    await runtime.rootCauseJob;
  }

  runtime.rootCauseAbort = new AbortController();
  runtime.status.rootCauseSignalId = signalId;
  runtime.status.error = null;
  runtime.status.step = "diagnosis";
  runtime.status.lastBeatAt = new Date().toISOString();

  const abort = runtime.rootCauseAbort;
  runtime.rootCauseJob = runAlarmRootCause(
    signalId,
    runtime.status.sensors ?? {},
    abort.signal,
  )
    .then((report) => {
      if (abort.signal.aborted) return;
      runtime.status.alarmDiagnoses = {
        ...(runtime.status.alarmDiagnoses ?? {}),
        [signalId]: report,
      };
      runtime.status.lastBeatAt = new Date().toISOString();
    })
    .catch((err) => {
      runtime.status.error = err instanceof Error ? err.message : "root-cause analysis failed";
      runtime.status.step = "error";
    })
    .finally(() => {
      runtime.status.rootCauseSignalId = null;
      if (runtime.status.step === "diagnosis") runtime.status.step = "idle";
      runtime.rootCauseAbort = null;
      runtime.rootCauseJob = null;
    });

  await runtime.rootCauseJob;
  return snapshot();
}

export function resetSystemAgent(): SystemAgentStatus {
  const runtime = handle();
  runtime.abort?.abort();
  runtime.rootCauseAbort?.abort();
  runtime.abort = null;
  runtime.rootCauseAbort = null;
  runtime.job = null;
  runtime.rootCauseJob = null;
  runtime.status = emptyStatus();
  return snapshot();
}

export type { SystemAgentStatus } from "./types";
