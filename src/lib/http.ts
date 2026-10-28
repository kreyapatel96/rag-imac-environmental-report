import { NextResponse } from "next/server";
import { toAppError } from "./errors";

export function errorResponse(err: unknown) {
  const e = toAppError(err);
  if (e.status >= 500) console.error(`[${e.code}]`, e.message, e.cause ?? "");
  return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
}
