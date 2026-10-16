import { NextResponse } from "next/server";
import { getRuntime, setRuntime } from "@/lib/llm/provider";
import { getConfig, postConfig } from "@/lib/pipeline";

export async function GET() {
  const pipeline = await getConfig();
  return NextResponse.json({ ...pipeline, node: getRuntime() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    dataset_id?: string;
    no_egress?: boolean;
  };
  if (body.no_egress !== undefined) {
    setRuntime({ noEgress: body.no_egress });
  }
  const runtime = getRuntime();
  const pipeline = await postConfig({
    dataset_id: body.dataset_id,
    no_egress: runtime.noEgress,
  });
  return NextResponse.json({ pipeline, node: runtime });
}
