import { NextResponse } from "next/server";
import { envProblems } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const problems = envProblems();
  return NextResponse.json({ ok: problems.length === 0, problems });
}
