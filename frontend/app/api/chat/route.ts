import { createAgentUIStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { createChatAgent } from "@/agents/operator";

export const maxDuration = 60;

export async function POST(request: Request) {
  const { messages } = await request.json();
  try {
    return await createAgentUIStreamResponse({
      agent: createChatAgent(),
      uiMessages: messages,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return message || "agent failed";
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
