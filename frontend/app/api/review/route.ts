import { NextResponse } from "next/server";
import { appendLog, readLog } from "@/lib/decision-log";

export async function GET() {
  return NextResponse.json({ entries: await readLog() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    action: "accept" | "question" | "override";
    note?: string;
  };

  if (!body.action) {
    return NextResponse.json({ error: "action required" }, { status: 400 });
  }

  const entry = await appendLog({
    kind: "review",
    payload: { action: body.action, note: body.note ?? "" },
  });

  return NextResponse.json({ ok: true, entry });
}
