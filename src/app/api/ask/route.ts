import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { answerQuestion } from "@/lib/rag";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({ question: z.string() });

export async function POST(req: Request) {
  try {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_UPLOAD", 'Body must be JSON: {"question": "..."}', 400);
    const { rag } = getServices();
    return NextResponse.json(await answerQuestion(rag, parsed.data.question));
  } catch (e) {
    return errorResponse(e);
  }
}
