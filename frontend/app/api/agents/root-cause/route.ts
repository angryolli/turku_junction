import { NextResponse } from "next/server";
import { createCritiqueAgent, createRootCauseAgent } from "@/agents/system";
import { postDecisionLog } from "@/lib/pipeline";

export async function POST(request: Request) {
  const { event_id, critique } = (await request.json()) as {
    event_id: string;
    critique?: boolean;
  };
  try {
    const agent = critique ? createCritiqueAgent() : createRootCauseAgent();
    const result = await agent.generate({
      prompt: critique
        ? `Challenge diagnosis ${event_id} using the diagnosis table.`
        : `Narrate diagnosis ${event_id} from the diagnosis table. Do not invent fields.`,
    });
    await postDecisionLog({
      type: "diagnosis",
      payload: { event_id, critique: Boolean(critique), text: result.text },
      evidence_ref: event_id,
    });
    return NextResponse.json({ text: result.text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "diagnosis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
