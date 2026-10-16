import { getDiagnosis, postDecisionLog } from "@/lib/pipeline";
import { LLMProvider, getRuntime, openaiCompatBaseURL } from "@/lib/llm/provider";
import { clipDiagnosis } from "./artifact";
import {
  createQualityAgent,
  createUnderstandingAgent,
  payloadHash,
  runSystemPrompt,
} from "./agents";
import { parseQualityFields, parseUnderstandingFields } from "./parse";
import type { DataFlowRecord, SensorNote, SystemReport, SystemStep } from "./types";

export type CycleSink = {
  aborted: () => boolean;
  abortSignal: AbortSignal;
  setStep: (step: SystemStep) => void;
  setEventId: (id: string | null) => void;
  setReport: (key: "understanding" | "quality", report: SystemReport) => void;
  mergeSensors: (patch: Record<string, SensorNote>) => void;
};

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "unconfigured";
  }
}

export function dataFlowRecord(): DataFlowRecord {
  let host = "unconfigured";
  try {
    host = hostOf(openaiCompatBaseURL());
  } catch {
    /* missing env */
  }
  const runtime = getRuntime();
  return {
    model: runtime.modelId,
    host,
    noEgress: runtime.noEgress,
    leaves:
      "Statistical fingerprints from the diagnosis table (n, mean, sd, skew, kurtosis, |z| against each channel's own history, yellow/red signal ids). Never raw records.",
    why: "The system agent infers roles, quality, and root cause. The operator agent answers questions. Both need derived summaries only.",
    swap: "Point OPENAI_BASE_URL (and OPENAI_API_KEY) at any OpenAI-compatible host, including localhost. No-egress refuses a non-local host.",
  };
}

function report(text: string, bytes: number): SystemReport {
  const provider = new LLMProvider();
  return {
    text,
    generatedAt: new Date().toISOString(),
    model: provider.modelId,
    hash: payloadHash(text),
    bytes,
  };
}

export async function runSystemCycle(sink: CycleSink) {
  const snap = await getDiagnosis();
  if (sink.aborted()) return;

  const { artifact, json, bytes } = clipDiagnosis(snap);
  const latest = artifact.signals[0];
  sink.setEventId(latest?.id ?? null);

  sink.setStep("understanding");
  const understanding = await runSystemPrompt(
    "understanding",
    createUnderstandingAgent(),
    json,
    bytes,
    sink.abortSignal,
  );
  if (sink.aborted()) return;
  sink.setReport("understanding", report(understanding, bytes));
  const understood = parseUnderstandingFields(understanding);
  const understoodPatch: Record<string, SensorNote> = {};
  for (const [id, row] of Object.entries(understood)) {
    understoodPatch[id] = { understanding: row };
  }
  sink.mergeSensors(understoodPatch);
  await postDecisionLog({
    type: "inference",
    payload: {
      step: "understanding",
      hash: payloadHash(understanding),
      fields: Object.values(understood),
    },
    evidence_ref: "system:understanding",
  });

  if (sink.aborted()) return;
  sink.setStep("quality");
  const quality = await runSystemPrompt(
    "quality",
    createQualityAgent(),
    json,
    bytes,
    sink.abortSignal,
  );
  if (sink.aborted()) return;
  sink.setReport("quality", report(quality, bytes));
  const parsedQuality = parseQualityFields(quality);
  const qualityPatch: Record<string, SensorNote> = {};
  for (const [id, row] of Object.entries(parsedQuality.fields)) {
    qualityPatch[id] = { quality: row };
  }
  sink.mergeSensors(qualityPatch);
  await postDecisionLog({
    type: "flag",
    payload: {
      step: "quality",
      hash: payloadHash(quality),
      fields: Object.values(parsedQuality.fields),
    },
    evidence_ref: "system:quality",
  });

}
