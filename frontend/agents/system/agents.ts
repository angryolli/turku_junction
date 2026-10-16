import { ToolLoopAgent, isStepCount } from "ai";
import { LLMProvider, payloadHash } from "@/lib/llm/provider";
import { postDecisionLog } from "@/lib/pipeline";

async function logCall(step: string, bytes: number, hash: string) {
  const provider = new LLMProvider();
  await postDecisionLog({
    type: "model_call",
    payload: {
      agent: "system",
      step,
      model: provider.modelId,
      tools: [],
      bytes,
      hash,
      leaves: "derived diagnosis fingerprints only; no raw rows",
    },
    evidence_ref: `system:${step}`,
  });
}

const SHARED = `You are the autonomous system agent for a process monitor.
You only see derived artifacts from the CURRENT simulation run: the current sources, the current
alarm log, and per-channel expanding mean, sd, skew, kurtosis, and yellow/red signals.
You never see raw rows and must never ask for them. A reset archives the prior run and clears this
context; do not assume alarms or conclusions from before the latest reset still apply.

The detector is a rolling z-score. Each channel is studentized against its own expanding mean and sd
over every earlier sample in the run, so z tells you how far this sample sits from that channel's own
history. A sample is hot when some channel reaches |z| >= 4. Yellow needs k consecutive hot samples
(default k=6), red the same run of samples at |z| >= 6, and nothing fires in the first 20 samples.
So an alert always means a sustained excursion, never a single spike. A channel's score IS its |z|.
This rule catches step changes and variance blowouts; it is weak on very slow drift and on a frozen
channel, so absence of a signal is not proof of health.
Ground every claim in a field_id, tick, |z|, or signal id.
Separate inferred (with evidence), assumed, and uncertain.
Do not treat column names as ground-truth labels. Domain knowledge (reactors, valves) is a hypothesis aid only.`;

export function createUnderstandingAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(1),
    tools: {},
    instructions: `${SHARED}

Task: for each unlabeled channel, tell an operator what the sensor LIKELY is and what the stream LOOKS LIKE right now.
Column names are not ground truth — infer from statistical behavior and cautious process knowledge only.

Write JSON only (no markdown):
{"fields":[{"field_id":"exact id from the artifact","guess":"plain-language label, e.g. reactor outlet temperature or feed valve position","confidence":0.0,"observations":"1–2 short sentences on current data: cite n, mean, sd, skew, kurtosis, |z|/score if present; note stable/drift/noisy/frozen/alarm involvement","role":"measured|actuator|ambiguous"}]}

Rules:
- guess: one concise sentence — what this channel probably measures or drives. Say "unknown" only if moments give nothing.
- confidence: 0–1 for the guess itself (not data quality). Lower when evidence is thin.
- observations: factual snapshot of THIS run so far — not a repeat of the guess. Always cite numbers from the artifact.
- role: optional hint; do not let it replace guess.
- One object per field. field_id MUST copy the artifact exactly.`,
  });
}

export function createQualityAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(1),
    tools: {},
    instructions: `${SHARED}

Write JSON only (no markdown) judging EACH FIELD's instrument/data quality. Do not classify process alarms or drift events.
Look for frozen (sd near 0), too few samples, implausible moments, not yet calibrated. That is a broken or weak sensor, not a process fault.
A channel with sd near 0 is also a detector blind spot: the z-score divides by a floor there, so it can swing between silence and a huge |z| on the first real move.
Shape:
{"fields":[{"field_id":"exact id from the artifact","faulty":false,"issue":"none|frozen|too_few_samples|implausible|uncalibrated","adjective":"Excellent|Good|Fair|Poor|Untrusted","confidence":0.0,"summary":"one sentence on this field only"}]}
adjective is a quality scale, not an alarm. field_id MUST copy the artifact exactly.`,
  });
}

export function createRootCauseAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(1),
    tools: {},
    instructions: `${SHARED}

Write a root-cause diagnosis for a non-technical operator.
If there is no yellow/red signal, say no fault event is open and summarize the current sample's max |z| and how far it is from the yellow gate.
Otherwise: likely fault type (hypothesis), ranked contributing fields with why, confidence, and numbered steps.
Do not invent fields. Cite signal id and tick.`,
  });
}

export function createAlarmRootCauseAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(1),
    tools: {},
    instructions: `You are an on-demand root-cause analyst for an industrial process monitor.
An operator clicked "Do root cause analysis" on ONE specific yellow or red alarm.
You receive a structured artifact with:
- target_alarm: the alarm under investigation (id, tick, level, |z|, evidence, ranked contributing fields)
- current_sample: live statistical fingerprints for every watched channel
- agent_notes: prior understanding (guess/observations) and quality judgments per field from an earlier system pass
- run_context: how the z-score detector works
- other_open_alarms: sibling alarms for context only

Your job is to explain the most likely process or equipment fault behind THIS alarm only.
Write for a non-technical operator in plain language (no JSON in the answer).

Structure your answer:
1. What happened — cite alarm id, tick, level, and the leading field(s) with |z|
2. Likely fault type — hypothesis with confidence (low/medium/high)
3. Why these channels — tie ranked fields to the hypothesis using moments, roles from agent_notes, and quality flags
4. What to check next — numbered operator steps
5. Uncertainty — what could disprove this or what data is missing

Rules:
- Ground every claim in field_id, tick, |z|, or signal id from the artifact
- Use agent_notes roles and quality as hypotheses, not as ground truth
- Use quality flags from agent_notes to distinguish sensor failure from process fault when relevant
- Do not invent fields, ticks, or alarms
- Do not analyze alarms that are not target_alarm unless comparing briefly`,
  });
}

export function createCritiqueAgent() {
  const provider = new LLMProvider();
  return new ToolLoopAgent({
    model: provider.model,
    stopWhen: isStepCount(1),
    tools: {},
    instructions: `${SHARED}

Challenge the diagnosis you are given. Do not overwrite it.
Offer alternative explanations (dead/frozen field vs process, wrong ranking).
End with agreement: agree | partial | disagree and a confidence adjustment.`,
  });
}

export async function runSystemPrompt(
  step: string,
  agent: ToolLoopAgent,
  prompt: string,
  bytes: number,
  abortSignal?: AbortSignal,
) {
  await logCall(step, bytes, payloadHash(prompt));
  const result = await agent.generate({ prompt, abortSignal });
  return result.text;
}

export { payloadHash };
