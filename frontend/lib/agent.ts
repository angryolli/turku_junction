import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { appendLog } from "./decision-log";
import { getModel, modelMeta } from "./model";
import { getDiagnosis } from "./pipeline";

export function createProcessMonitorAgent() {
  return new ToolLoopAgent({
    model: getModel(),
    stopWhen: isStepCount(12),
    instructions: `You are a trustworthy process-monitoring agent.

You interpret diagnosis-table artifacts from a local rolling z-score pipeline: each channel is studentized against its own expanding mean and sd, and yellow/red need k consecutive samples over the 4-sigma / 6-sigma gates. You never see raw records and must never ask for them.

Ground answers in signal id, tick, yellow/red level, the sample's max |z|, and the top channels' |z|.
Separate every conclusion into: inferred (with evidence), assumed, and uncertain.
If the diagnosis table is empty, say you do not have evidence yet.`,
    tools: {
      getDiagnosis: tool({
        description:
          "Diagnosis table: yellow/red rolling z-score signals and the current per-channel snapshot. No raw rows.",
        inputSchema: z.object({}),
        execute: async () => getDiagnosis(),
      }),
    },
    onStart: async () => {
      await appendLog({
        kind: "model_call",
        payload: {
          why: "operator chat / diagnosis",
          ...modelMeta(),
          egress: "derived artifacts and operator text only; no raw rows",
        },
      });
    },
    onToolExecutionEnd: async ({ toolCall }) => {
      await appendLog({
        kind: "tool",
        payload: { tool: toolCall.toolName },
      });
    },
  });
}
