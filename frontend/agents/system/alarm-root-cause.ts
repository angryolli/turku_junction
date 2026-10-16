import { getDiagnosis, postDecisionLog } from "@/lib/pipeline";
import { LLMProvider, payloadHash } from "@/lib/llm/provider";
import { clipForAlarmRootCause } from "./artifact";
import { createAlarmRootCauseAgent, runSystemPrompt } from "./agents";
import type { SensorNote, SystemReport } from "./types";

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

export async function runAlarmRootCause(
  signalId: string,
  sensors: Record<string, SensorNote>,
  abortSignal?: AbortSignal,
): Promise<SystemReport> {
  const snap = await getDiagnosis();
  const clipped = clipForAlarmRootCause(snap, signalId, sensors);
  if (!clipped) {
    throw new Error(`Alarm ${signalId} was not found in the current run.`);
  }

  const text = await runSystemPrompt(
    "alarm_root_cause",
    createAlarmRootCauseAgent(),
    clipped.json,
    clipped.bytes,
    abortSignal,
  );

  await postDecisionLog({
    type: "diagnosis",
    payload: {
      step: "alarm_root_cause",
      event_id: signalId,
      hash: payloadHash(text),
      text,
    },
    evidence_ref: signalId,
  });

  return report(text, clipped.bytes);
}
