import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { appendLog } from "./decision-log";
import { getModel, modelMeta } from "./model";
import { getSituation } from "./pipeline";

export function createProcessMonitorAgent() {
  return new ToolLoopAgent({
    model: getModel(),
    stopWhen: isStepCount(8),
    instructions: `You are the chat for a hospital antimicrobial-resistance monitor.

Call getSituation before answering. Explain four-week versus annual resistance rates for a ward, organism, and antibiotic.
A percentage needs at least 30 isolates. You never see raw culture rows.
If the replay has not started, say so.`,
    tools: {
      getSituation: tool({
        description: "Current lab day, ward statuses, and open resistance alerts. Optional ward code.",
        inputSchema: z.object({
          ward: z.string().optional(),
        }),
        execute: async ({ ward }) => getSituation(ward),
      }),
    },
    onStart: async () => {
      await appendLog({
        kind: "model_call",
        payload: {
          why: "lab chat",
          ...modelMeta(),
          egress: "derived rates and operator text only; no raw rows",
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
