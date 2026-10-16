import { NextResponse } from "next/server";
import { createUnderstandingAgent } from "@/agents/system";

export async function POST() {
  try {
    const agent = createUnderstandingAgent();
    const result = await agent.generate({
      prompt:
        "Infer a functional identity hypothesis for each unlabeled field from the diagnosis fingerprints.",
    });
    return NextResponse.json({ text: result.text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "role inference failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
