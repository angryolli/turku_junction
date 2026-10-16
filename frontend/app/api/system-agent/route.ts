import { NextResponse } from "next/server";
import {
  getSystemAgentStatus,
  resetSystemAgent,
  startAlarmRootCause,
  startSystemAgent,
  stopSystemAgent,
} from "@/agents/system";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json(getSystemAgentStatus());
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    running?: boolean;
    reset?: boolean;
    rootCauseSignalId?: string;
  };
  if (body.reset) {
    return NextResponse.json(resetSystemAgent());
  }
  if (body.rootCauseSignalId) {
    try {
      const status = await startAlarmRootCause(body.rootCauseSignalId);
      return NextResponse.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : "root-cause analysis failed";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  const status = body.running ? startSystemAgent() : stopSystemAgent();
  return NextResponse.json(status);
}
