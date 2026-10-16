import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { LLMProvider, payloadHash } from "@/lib/llm/provider";
import { getDecisionLog, getDiagnosis, postDecisionLog } from "@/lib/pipeline";

async function logCall(agent: string, tools: string[]) {
  const provider = new LLMProvider();
  await postDecisionLog({
    type: "model_call",
    payload: {
      agent,
      model: provider.modelId,
      tools,
      hash: payloadHash({ agent, tools }),
    },
    evidence_ref: "derived artifacts only",
  });
}

const getDiagnosisTool = tool({
  description:
    "Read the current alarm log and per-channel snapshot for the active simulation run (yellow/red signals, n, mean, sd, skew, kurtosis, |z|). Never raw rows.",
  inputSchema: z.object({
    reason: z.string().optional().describe("Why you need the current alarm log"),
  }),
  execute: async () => {
    try {
      return await getDiagnosis();
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "diagnosis table unavailable",
        signals: [],
        current: {},
        evidence: "Diagnosis lookup failed. Tell the operator you could not read the table.",
      };
    }
  },
});

const getDecisionLogTool = tool({
  description:
    "Read the current decision log for the active simulation run (inferences, flags, diagnoses, overrides).",
  inputSchema: z.object({
    type: z.string().optional().describe("Optional log type filter"),
  }),
  execute: async ({ type }) => {
    try {
      return await getDecisionLog(type ? { type } : undefined);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "decision log unavailable",
        entries: [],
      };
    }
  },
});

const INSTRUCTIONS = `You are the operator-facing chat for a live process monitor.

You only see the CURRENT simulation run. Refer to "the current sources", "the current alarm log",
and "the current decision log". Past runs live in Reports & Logs after a reset; you do not see them
unless the operator quotes them.

A flag means a sustained excursion, not a blip. Each channel is studentized against its own expanding
mean and sd over the run so far; a sample is hot when some channel reaches |z| >= 4. Yellow needs k
consecutive hot samples (default k=6), red the same run at |z| >= 6, and the first 20 samples never
alert. A field's score IS its |z|. When you explain a flag, say which channel moved and by how many
sigma, and for how many samples in a row.

The autonomous system agent (not you) writes understanding, quality, and root-cause reports.
Your job is plain-language questions: why a flag fired, what a field is doing, what an override means.
Call getDiagnosis before answering about the process, flags, yellow/red signals, or fields.
Call getDecisionLog when asked about overrides or actions in the current run.
Answer from those tool results. You never see raw sensor rows and must never ask for them.

If the current alarm log is empty, the lookup failed, or the run is not yet calibrated (first 20
samples), say so clearly. Reset clears the current run; do not cite alarms from before a reset.
Every substantive answer must mention sources as artifact_type:id (for example diagnosis:sig_abc).
After a tool result arrives, write a plain-language answer for the operator.`;

export function createChatAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(8),
    instructions: INSTRUCTIONS,
    tools: {
      getDiagnosis: getDiagnosisTool,
      getDecisionLog: getDecisionLogTool,
    },
    onStart: async () => {
      await logCall("chat", ["getDiagnosis", "getDecisionLog"]);
    },
  });
}

export function createRuleAgent() {
  return createChatAgent();
}
