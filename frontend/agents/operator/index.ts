import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { LLMProvider, payloadHash } from "@/lib/llm/provider";
import { getSituation, postDecisionLog } from "@/lib/pipeline";

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

const getSituationTool = tool({
  description:
    "Current lab day, ward statuses, open resistance alerts, and the alert log. Pass a ward code (ICU, ED, MED-A, …) to include that ward's published four-week and annual rates. Never raw culture rows.",
  inputSchema: z.object({
    ward: z
      .string()
      .optional()
      .describe("Ward code such as ICU or ED. Omit to see every ward's status and the open alerts."),
  }),
  execute: async ({ ward }) => {
    try {
      return await getSituation(ward);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "situation unavailable",
        open_alerts: [],
        alert_log: [],
        evidence: "Situation lookup failed. Say you could not read the current lab day.",
      };
    }
  },
});

const INSTRUCTIONS = `You are the chat for a hospital antimicrobial-resistance monitor.

Doctors watch how often a bacterial species is resistant to an antibiotic on their own ward.
You only see the current replay. Call getSituation before answering about wards, rates, alerts, or the lab day.

A culture is one sample. An isolate is one bacterium from a positive culture. Susceptibility is S (drug should work) or R (resistant) for one isolate and one antibiotic.
The four-week rate is the share of R among first isolates in the previous 28 days. The annual rate is that share in the 365 days before those 28 days.
The first isolate is the earliest one per patient, organism, and specimen inside that window, so repeat samples from the same person are not counted again.
A percentage is blank when fewer than 30 isolates were tested. Blank rates never raise an alert.
An alert fires once, when a published four-week rate moves about two standard errors from the annual rate (yellow) or about three (red). Say which ward, organism, and antibiotic, both percentages, both counts, and whether resistance went up or down.
Cite the alert id from the alert log when you discuss one.

You never see raw culture rows and must not ask for them. If the replay has not started or the lookup fails, say so.
After a tool result arrives, answer in plain language for a doctor.`;

export function createChatAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(8),
    instructions: INSTRUCTIONS,
    tools: {
      getSituation: getSituationTool,
    },
    onStart: async () => {
      await logCall("chat", ["getSituation"]);
    },
  });
}

export function createRuleAgent() {
  return createChatAgent();
}
