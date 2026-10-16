import { NextResponse } from "next/server";
import { createRuleAgent } from "@/agents/operator";
import { ruleSchema } from "@/types/artifacts";

export async function POST(request: Request) {
  const { rule_text } = (await request.json()) as { rule_text: string };
  try {
    const agent = createRuleAgent();
    const result = await agent.generate({
      prompt: `Answer using the diagnosis table. Rule text from the operator: ${rule_text}`,
    });
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ text: result.text });
    }
    try {
      const parsed = ruleSchema.parse({
        ...JSON.parse(match[0]),
        rule_text,
      });
      return NextResponse.json({ parsed, text: result.text });
    } catch {
      return NextResponse.json({ text: result.text });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "rule compile failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
